import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, PutItemCommand, ScanCommand } from '@aws-sdk/client-dynamodb';
import { createHmac, timingSafeEqual } from 'crypto';
import axios from 'axios';
import { getSlackCredentials, getClaudeCredentials, logger, setRequestId } from '@support-agent-aws/shared';
import { SlackClient } from './slack-client';
import { analyzeScreenshot, downloadSlackImage } from './image-analyzer';

const dynamoClient = new DynamoDBClient({});

const TAGGING_RULES_TABLE = process.env.TAGGING_RULES_TABLE || 'support-agent-tagging-rules';
const RESEARCH_CAPABILITIES_TABLE = process.env.RESEARCH_CAPABILITIES_TABLE || 'support-agent-research-capabilities';

// Slack file attachment type
interface SlackFileAttachment {
  id: string;
  name: string;
  mimetype: string;
  url_private: string;
}

// Slack event types
interface SlackEvent {
  type: string;
  channel: string;
  user: string;
  text: string;
  ts: string;
  bot_id?: string;
  subtype?: string;
  files?: SlackFileAttachment[];
}

interface SlackEventPayload {
  type: string;
  challenge?: string;
  event?: SlackEvent;
}

// Claude's understanding of the request
interface RequestAnalysis {
  requestType: 'tagging' | 'research' | 'unclear';

  // For tagging requests
  keywords?: string[];
  tagName?: string;

  // For research requests
  capabilityDescription?: string;
  capabilityId?: string;

  // For unclear requests
  clarificationQuestion?: string;

  // Summary for confirmation
  summary: string;
}

/**
 * Verify Slack request signature using HMAC-SHA256
 */
function verifySlackSignature(
  signingSecret: string,
  signature: string,
  timestamp: string,
  body: string
): boolean {
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (parseInt(timestamp, 10) < fiveMinutesAgo) {
    logger.warn('Slack request timestamp too old', { timestamp });
    return false;
  }

  const sigBasestring = `v0:${timestamp}:${body}`;
  const mySignature = 'v0=' + createHmac('sha256', signingSecret).update(sigBasestring).digest('hex');

  try {
    return timingSafeEqual(Buffer.from(mySignature), Buffer.from(signature));
  } catch {
    return false;
  }
}

/**
 * Use Claude to understand what the coworker is requesting
 */
async function analyzeRequest(
  messageText: string,
  imageContext?: string
): Promise<RequestAnalysis> {
  const credentials = await getClaudeCredentials();

  const combinedContext = imageContext
    ? `Message: "${messageText}"\n\nScreenshot context: ${imageContext}`
    : `Message: "${messageText}"`;

  const prompt = `You are an AI assistant helping to manage a support system. Coworkers send requests to add new capabilities to our automated support agents.

There are two types of agents:
1. **Tagging Agent**: Automatically adds tags to HelpScout conversations based on keywords in the email
2. **Research Agent**: Performs automated actions on conversations (like translating foreign language emails, looking up customer history, etc.)

Analyze this request from a coworker:

${combinedContext}

Determine what they're asking for:

1. **Tagging Request**: They want certain keywords to trigger a specific tag
   - Example: "When someone mentions 'refund' or 'money back', add the 'refund-request' tag"
   - Extract: keywords (array) and tagName (string)

2. **Research Request**: They want the research agent to perform a new action
   - Example: "Translate foreign language emails to English"
   - Example: "Look up the customer's previous orders"
   - Extract: capabilityDescription (what it should do) and capabilityId (short identifier)

3. **Unclear**: You can't determine what they want
   - Provide a clarificationQuestion to ask them

Respond with JSON only:
{
  "requestType": "tagging" | "research" | "unclear",
  "keywords": ["keyword1", "keyword2"],  // for tagging only
  "tagName": "tag-name",  // for tagging only
  "capabilityDescription": "...",  // for research only
  "capabilityId": "short-id",  // for research only (lowercase, hyphenated)
  "clarificationQuestion": "...",  // for unclear only
  "summary": "Brief description of what will be done"
}`;

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-3-haiku-20240307',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    },
    {
      headers: {
        'x-api-key': credentials.api_key,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
    }
  );

  const content = response.data.content[0]?.text || '{}';

  // Parse JSON from response
  let jsonStr = content.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
  }

  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    return JSON.parse(jsonMatch[0]) as RequestAnalysis;
  }

  return {
    requestType: 'unclear',
    clarificationQuestion: "I couldn't understand your request. Could you please rephrase it?",
    summary: 'Unable to parse request',
  };
}

/**
 * Store a tagging rule in DynamoDB
 */
async function storeTaggingRule(keywords: string[], tagName: string): Promise<void> {
  // Store each keyword as a separate item
  for (const keyword of keywords) {
    await dynamoClient.send(new PutItemCommand({
      TableName: TAGGING_RULES_TABLE,
      Item: {
        keyword: { S: keyword.toLowerCase() },
        tagName: { S: tagName },
        createdAt: { S: new Date().toISOString() },
      },
    }));
  }

  logger.info('Tagging rules stored', { keywords, tagName });
}

/**
 * Store a research capability in DynamoDB
 */
async function storeResearchCapability(capabilityId: string, description: string): Promise<void> {
  await dynamoClient.send(new PutItemCommand({
    TableName: RESEARCH_CAPABILITIES_TABLE,
    Item: {
      capabilityId: { S: capabilityId },
      description: { S: description },
      enabled: { BOOL: true },
      createdAt: { S: new Date().toISOString() },
    },
  }));

  logger.info('Research capability stored', { capabilityId, description });
}

/**
 * Get all existing tagging rules for display
 */
async function getExistingTaggingRules(): Promise<Map<string, string[]>> {
  const result = await dynamoClient.send(new ScanCommand({
    TableName: TAGGING_RULES_TABLE,
  }));

  const rulesByTag = new Map<string, string[]>();

  for (const item of result.Items || []) {
    const keyword = item.keyword?.S || '';
    const tagName = item.tagName?.S || '';

    if (!rulesByTag.has(tagName)) {
      rulesByTag.set(tagName, []);
    }
    rulesByTag.get(tagName)!.push(keyword);
  }

  return rulesByTag;
}

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = event.requestContext.requestId;
  setRequestId(requestId);

  logger.info('Slack webhook received', { requestId });

  try {
    const credentials = await getSlackCredentials();

    // Verify Slack signature
    const signature = event.headers['x-slack-signature'] || event.headers['X-Slack-Signature'] || '';
    const timestamp = event.headers['x-slack-request-timestamp'] || event.headers['X-Slack-Request-Timestamp'] || '';

    if (!verifySlackSignature(credentials.signing_secret, signature, timestamp, event.body || '')) {
      logger.error('Invalid Slack signature');
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid signature' }) };
    }

    const payload: SlackEventPayload = JSON.parse(event.body || '{}');

    // Handle URL verification challenge
    if (payload.type === 'url_verification') {
      logger.info('Handling URL verification challenge');
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'text/plain' },
        body: payload.challenge || '',
      };
    }

    // Ignore bot messages
    if (payload.event?.bot_id) {
      logger.debug('Ignoring bot message');
      return { statusCode: 200, body: 'OK' };
    }

    // Ignore message subtypes except file_share
    if (payload.event?.subtype && payload.event.subtype !== 'file_share') {
      logger.debug('Ignoring message subtype', { subtype: payload.event.subtype });
      return { statusCode: 200, body: 'OK' };
    }

    // Ignore Slack retries
    const retryNum = event.headers['x-slack-retry-num'] || event.headers['X-Slack-Retry-Num'];
    if (retryNum) {
      logger.debug('Ignoring Slack retry', { retryNum });
      return { statusCode: 200, body: 'OK' };
    }

    // Only process messages from the configured channel
    if (payload.event?.channel !== credentials.channel_id) {
      logger.debug('Ignoring message from different channel');
      return { statusCode: 200, body: 'OK' };
    }

    const slackEvent = payload.event;
    if (!slackEvent || (!slackEvent.text && !slackEvent.files?.length)) {
      logger.debug('No message content to process');
      return { statusCode: 200, body: 'OK' };
    }

    // Only process messages that start with "#"
    if (!slackEvent.text?.trimStart().startsWith('#')) {
      logger.debug('Ignoring message that does not start with #');
      return { statusCode: 200, body: 'OK' };
    }

    const slackClient = new SlackClient(credentials.bot_token);
    const userId = slackEvent.user;

    logger.info('Processing Slack message', {
      channel: slackEvent.channel,
      user: userId,
      textPreview: slackEvent.text?.slice(0, 100) || '(no text)',
      fileCount: slackEvent.files?.length || 0,
    });

    // Post "thinking" message
    await slackClient.postMessage(
      slackEvent.channel,
      `🤔 Analyzing request from <@${userId}>...`,
      slackEvent.ts
    );

    // Analyze screenshots if present
    let imageContext: string | undefined;
    if (slackEvent.files?.length) {
      const imageFile = slackEvent.files.find(f => f.mimetype.startsWith('image/'));
      if (imageFile) {
        try {
          const imageBuffer = await downloadSlackImage(imageFile.url_private, credentials.bot_token);
          const analysis = await analyzeScreenshot(imageBuffer, imageFile.mimetype, slackEvent.text || '');
          imageContext = analysis.summary + (analysis.rawText ? `\n\nText from image: ${analysis.rawText}` : '');
        } catch (error) {
          logger.warn('Failed to analyze screenshot', { error: error instanceof Error ? error.message : 'Unknown' });
        }
      }
    }

    // Use Claude to understand the request
    const analysis = await analyzeRequest(slackEvent.text || '', imageContext);

    logger.info('Request analyzed', {
      requestType: analysis.requestType,
      summary: analysis.summary
    });

    if (analysis.requestType === 'unclear') {
      // Ask for clarification
      const clarificationMsg = [
        `❓ *Clarification Needed*`,
        ``,
        `<@${userId}>, ${analysis.clarificationQuestion}`,
        ``,
        `*Examples of what I can do:*`,
        `• "Add a tag 'refund-request' when someone mentions 'refund' or 'money back'"`,
        `• "Translate foreign language emails to English"`,
        `• "Look up customer's order history and add it as a note"`,
      ].join('\n');

      await slackClient.postMessage(slackEvent.channel, clarificationMsg, slackEvent.ts);

    } else if (analysis.requestType === 'tagging') {
      // Store tagging rule
      if (analysis.keywords && analysis.tagName) {
        await storeTaggingRule(analysis.keywords, analysis.tagName);

        const successMsg = [
          `✅ *Tagging Rule Added*`,
          ``,
          `*Tag:* \`${analysis.tagName}\``,
          `*Keywords:* ${analysis.keywords.map(k => `\`${k}\``).join(', ')}`,
          ``,
          `When a HelpScout email contains any of these keywords, the \`${analysis.tagName}\` tag will be automatically added.`,
          ``,
          `_Request by <@${userId}>_`,
        ].join('\n');

        await slackClient.postMessage(slackEvent.channel, successMsg, slackEvent.ts);
      } else {
        await slackClient.postMessage(
          slackEvent.channel,
          `⚠️ I understood this is a tagging request, but couldn't extract the keywords or tag name. Please try again with a clearer format.`,
          slackEvent.ts
        );
      }

    } else if (analysis.requestType === 'research') {
      // Store research capability
      if (analysis.capabilityId && analysis.capabilityDescription) {
        await storeResearchCapability(analysis.capabilityId, analysis.capabilityDescription);

        const successMsg = [
          `✅ *Research Capability Added*`,
          ``,
          `*Capability:* \`${analysis.capabilityId}\``,
          `*Description:* ${analysis.capabilityDescription}`,
          ``,
          `This capability is now enabled. The research agent will apply this to future conversations.`,
          ``,
          `_Request by <@${userId}>_`,
        ].join('\n');

        await slackClient.postMessage(slackEvent.channel, successMsg, slackEvent.ts);
      } else {
        await slackClient.postMessage(
          slackEvent.channel,
          `⚠️ I understood this is a research request, but couldn't determine the capability details. Please try again with a clearer description.`,
          slackEvent.ts
        );
      }
    }

    return { statusCode: 200, body: 'OK' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Slack orchestrator failed', { error: message });
    return { statusCode: 200, body: 'OK' };
  }
}
