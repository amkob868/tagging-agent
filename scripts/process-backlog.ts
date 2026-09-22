/**
 * One-time script to process backlog of messages in #ai-training-data
 * Run with: npx ts-node scripts/process-backlog.ts
 */

import axios from 'axios';

// Slack credentials - loaded from environment for this one-time run
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const CHANNEL_ID = process.env.SLACK_CHANNEL_ID || '';
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';

if (!BOT_TOKEN || !CHANNEL_ID) {
  console.error('SLACK_BOT_TOKEN and SLACK_CHANNEL_ID must be set');
  process.exit(1);
}

interface SlackMessage {
  ts: string;
  user: string;
  text: string;
  files?: Array<{
    url_private: string;
    mimetype: string;
    name: string;
  }>;
}

interface AnalyzedMessage {
  ts: string;
  user: string;
  text: string;
  type: 'research' | 'tagging' | 'unclear';
  conversationIds?: number[];
  keywords?: string[];
  tag?: string;
  summary: string;
  screenshotAnalysis?: string;
}

/**
 * Fetch messages from Slack channel for the last N days
 */
async function fetchSlackMessages(days: number): Promise<SlackMessage[]> {
  const oldestTimestamp = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);

  console.log(`Fetching messages from the last ${days} days...`);

  const allMessages: SlackMessage[] = [];
  let cursor: string | undefined;

  do {
    const params: any = {
      channel: CHANNEL_ID,
      oldest: oldestTimestamp.toString(),
      limit: 100,
    };
    if (cursor) params.cursor = cursor;

    const response = await axios.get('https://slack.com/api/conversations.history', {
      headers: { Authorization: `Bearer ${BOT_TOKEN}` },
      params,
    });

    if (!response.data.ok) {
      throw new Error(`Slack API error: ${response.data.error}`);
    }

    const messages = response.data.messages.filter((m: any) =>
      !m.bot_id && m.text // Only human messages with text
    );

    allMessages.push(...messages);
    cursor = response.data.response_metadata?.next_cursor;

    console.log(`Fetched ${allMessages.length} messages so far...`);
  } while (cursor);

  return allMessages.reverse(); // Oldest first
}

/**
 * Download image from Slack
 */
async function downloadImage(url: string): Promise<Buffer> {
  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${BOT_TOKEN}` },
    responseType: 'arraybuffer',
  });
  return Buffer.from(response.data);
}

/**
 * Analyze a message using Claude to determine its type
 */
async function analyzeMessage(message: SlackMessage): Promise<AnalyzedMessage> {
  // First, try to determine type from text patterns
  const textLower = message.text.toLowerCase();

  // Check for tagging patterns: "keyword(s):" and "tag:"
  const keywordMatch = message.text.match(/keyword\(?s?\)?[:\s]+([^\n]+)/i);
  const tagMatch = message.text.match(/tag[:\s]+([^\n]+)/i);

  if (keywordMatch && tagMatch) {
    // This is a tagging request
    const keywordsStr = keywordMatch[1].trim();
    const tag = tagMatch[1].trim();
    const keywords = keywordsStr.split(/[,;]/).map(k => k.trim().toLowerCase()).filter(Boolean);

    return {
      ts: message.ts,
      user: message.user,
      text: message.text,
      type: 'tagging',
      keywords,
      tag,
      summary: `Add keywords [${keywords.join(', ')}] for tag "${tag}"`,
    };
  }

  // Check for HelpScout URLs - likely research request
  const helpscoutUrls = message.text.match(/https:\/\/secure\.helpscout\.net\/conversation\/(\d+)/g) || [];
  const conversationIds = helpscoutUrls.map(url => {
    const match = url.match(/\/(\d+)/);
    return match ? parseInt(match[1], 10) : null;
  }).filter((id): id is number => id !== null);

  if (conversationIds.length > 0) {
    // Check if it mentions notes, orders, or repeat buyer
    if (textLower.includes('note') || textLower.includes('order') ||
        textLower.includes('buyer') || textLower.includes('repeat') ||
        textLower.includes('same') || textLower.includes('link')) {
      return {
        ts: message.ts,
        user: message.user,
        text: message.text,
        type: 'research',
        conversationIds,
        summary: `Research request for conversations: ${conversationIds.join(', ')}`,
      };
    }
  }

  // If has screenshots, analyze with Claude
  if (message.files?.length && CLAUDE_API_KEY) {
    try {
      const imageFile = message.files.find(f => f.mimetype.startsWith('image/'));
      if (imageFile) {
        const imageBuffer = await downloadImage(imageFile.url_private);
        const base64Image = imageBuffer.toString('base64');

        const response = await axios.post(
          'https://api.anthropic.com/v1/messages',
          {
            model: 'claude-3-haiku-20240307',
            max_tokens: 500,
            messages: [{
              role: 'user',
              content: [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: imageFile.mimetype, data: base64Image },
                },
                {
                  type: 'text',
                  text: `Analyze this HelpScout screenshot shared with message: "${message.text}"

Determine if this is:
1. A "research" request (about adding notes for repeat orders, linking conversations)
2. A "tagging" request (about adding keywords that should trigger tags)
3. "unclear" if you can't determine

Extract any conversation IDs visible (format: #123456 or in URLs).
If tagging: extract the keywords and tag name.

Respond in JSON:
{
  "type": "research" | "tagging" | "unclear",
  "conversationIds": [numbers if found],
  "keywords": ["if tagging request"],
  "tag": "tag name if tagging request",
  "summary": "brief description"
}`,
                },
              ],
            }],
          },
          {
            headers: {
              'x-api-key': CLAUDE_API_KEY,
              'anthropic-version': '2023-06-01',
              'Content-Type': 'application/json',
            },
          }
        );

        const content = response.data.content[0]?.text || '{}';
        let jsonStr = content.trim();
        if (jsonStr.startsWith('```')) {
          jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
        }

        const analysis = JSON.parse(jsonStr);
        return {
          ts: message.ts,
          user: message.user,
          text: message.text,
          type: analysis.type || 'unclear',
          conversationIds: analysis.conversationIds,
          keywords: analysis.keywords,
          tag: analysis.tag,
          summary: analysis.summary || 'Analyzed from screenshot',
          screenshotAnalysis: content,
        };
      }
    } catch (error) {
      console.error('Failed to analyze screenshot:', error);
    }
  }

  // Default to unclear
  return {
    ts: message.ts,
    user: message.user,
    text: message.text,
    type: 'unclear',
    summary: 'Could not determine request type',
  };
}

/**
 * Main function
 */
async function main() {
  console.log('='.repeat(60));
  console.log('BACKLOG PROCESSOR - #ai-training-data');
  console.log('='.repeat(60));

  // Fetch messages from last 2 weeks
  const messages = await fetchSlackMessages(14);
  console.log(`\nFound ${messages.length} human messages in the last 2 weeks\n`);

  const researchRequests: AnalyzedMessage[] = [];
  const taggingRequests: AnalyzedMessage[] = [];
  const unclearRequests: AnalyzedMessage[] = [];

  // Analyze each message
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    console.log(`Analyzing message ${i + 1}/${messages.length}...`);

    try {
      const analyzed = await analyzeMessage(msg);

      switch (analyzed.type) {
        case 'research':
          researchRequests.push(analyzed);
          break;
        case 'tagging':
          taggingRequests.push(analyzed);
          break;
        default:
          unclearRequests.push(analyzed);
      }
    } catch (error) {
      console.error(`Error analyzing message: ${error}`);
      unclearRequests.push({
        ts: msg.ts,
        user: msg.user,
        text: msg.text,
        type: 'unclear',
        summary: 'Error during analysis',
      });
    }

    // Rate limiting
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  // Output results
  console.log('\n' + '='.repeat(60));
  console.log('RESULTS');
  console.log('='.repeat(60));

  console.log(`\n📊 RESEARCH REQUESTS (${researchRequests.length}):`);
  console.log('-'.repeat(40));
  researchRequests.forEach((r, i) => {
    console.log(`${i + 1}. ${r.summary}`);
    console.log(`   Conversations: ${r.conversationIds?.join(', ') || 'none found'}`);
    console.log(`   Original: "${r.text.slice(0, 100)}..."`);
    console.log('');
  });

  console.log(`\n🏷️  TAGGING REQUESTS (${taggingRequests.length}):`);
  console.log('-'.repeat(40));
  taggingRequests.forEach((r, i) => {
    console.log(`${i + 1}. Tag: "${r.tag}"`);
    console.log(`   Keywords: ${r.keywords?.join(', ')}`);
    console.log(`   Original: "${r.text.slice(0, 100)}..."`);
    console.log('');
  });

  console.log(`\n⚠️  UNCLEAR - NEEDS HUMAN CHECK (${unclearRequests.length}):`);
  console.log('-'.repeat(40));
  unclearRequests.forEach((r, i) => {
    console.log(`${i + 1}. "${r.text.slice(0, 150)}..."`);
    console.log('');
  });

  // Output tagging keywords to add
  if (taggingRequests.length > 0) {
    console.log('\n' + '='.repeat(60));
    console.log('KEYWORDS TO ADD TO TAGGING AGENT:');
    console.log('='.repeat(60));

    const keywordsByTag: Record<string, string[]> = {};
    taggingRequests.forEach(r => {
      if (r.tag && r.keywords) {
        const tagLower = r.tag.toLowerCase();
        if (!keywordsByTag[tagLower]) keywordsByTag[tagLower] = [];
        keywordsByTag[tagLower].push(...r.keywords);
      }
    });

    Object.entries(keywordsByTag).forEach(([tag, keywords]) => {
      const uniqueKeywords = [...new Set(keywords)];
      console.log(`\nTag: "${tag}"`);
      console.log(`Keywords: ['${uniqueKeywords.join("', '")}']`);
    });
  }

  // Output research conversations to process
  if (researchRequests.length > 0) {
    console.log('\n' + '='.repeat(60));
    console.log('CONVERSATIONS TO SEND TO RESEARCH AGENT:');
    console.log('='.repeat(60));

    const allConversationIds = researchRequests
      .flatMap(r => r.conversationIds || [])
      .filter((id, i, arr) => arr.indexOf(id) === i);

    console.log(allConversationIds.join('\n'));
  }
}

main().catch(console.error);
