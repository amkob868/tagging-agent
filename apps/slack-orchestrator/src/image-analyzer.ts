import axios from 'axios';
import { getClaudeCredentials, logger } from '@support-agent-aws/shared';

export interface ImageAnalysisResult {
  conversationId: number | null;
  conversationNumber: string | null;
  suggestedAction: 'research' | 'tagging' | 'unknown';
  customerEmail: string | null;
  subject: string | null;
  tags: string[];
  summary: string;
  rawText: string;
}

/**
 * Download an image from Slack
 * Slack file URLs require authentication with the bot token
 */
export async function downloadSlackImage(
  fileUrl: string,
  botToken: string
): Promise<Buffer> {
  logger.debug('Downloading image from Slack', { fileUrl });

  const response = await axios.get(fileUrl, {
    headers: {
      Authorization: `Bearer ${botToken}`,
    },
    responseType: 'arraybuffer',
  });

  return Buffer.from(response.data);
}

/**
 * Analyze a screenshot using Claude's vision capabilities
 */
export async function analyzeScreenshot(
  imageBuffer: Buffer,
  mimeType: string,
  messageText: string
): Promise<ImageAnalysisResult> {
  logger.info('Analyzing screenshot with Claude vision');

  const credentials = await getClaudeCredentials();
  const base64Image = imageBuffer.toString('base64');

  const response = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-3-haiku-20240307',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mimeType,
                data: base64Image,
              },
            },
            {
              type: 'text',
              text: `You are analyzing a screenshot from HelpScout (a customer support platform) that was shared in a Slack channel for AI training data.

The person sharing this screenshot included this message: "${messageText || 'No message provided'}"

Please analyze the screenshot and extract the following information in JSON format:
{
  "conversationId": <number or null - the HelpScout conversation ID if visible (usually a long number like 2847592847)>,
  "conversationNumber": <string or null - the shorter conversation number if visible (like #147226)>,
  "suggestedAction": <"research" | "tagging" | "unknown" - what action seems to be requested based on the context>,
  "customerEmail": <string or null - the customer's email if visible>,
  "subject": <string or null - the email subject if visible>,
  "tags": <array of strings - any tags visible or mentioned that should be added/removed>,
  "summary": <string - brief summary of what the screenshot shows and what action is being requested>,
  "rawText": <string - any relevant text you can extract from the screenshot>
}

Context clues for suggestedAction:
- "research" if the request is about looking up customer info, creating notes, finding related orders
- "tagging" if the request is about adding/removing/fixing tags, classifying conversations, or adding new keywords
- "unknown" if you can't determine the intent

Return ONLY the JSON object, no other text.`,
            },
          ],
        },
      ],
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

  try {
    // Parse the JSON response, handling potential markdown code blocks
    let jsonStr = content.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/```json?\n?/g, '').replace(/```/g, '').trim();
    }

    const result = JSON.parse(jsonStr) as ImageAnalysisResult;
    logger.info('Screenshot analysis complete', {
      conversationId: result.conversationId,
      conversationNumber: result.conversationNumber,
      suggestedAction: result.suggestedAction
    });
    return result;
  } catch (error) {
    logger.error('Failed to parse Claude vision response', { content });
    return {
      conversationId: null,
      conversationNumber: null,
      suggestedAction: 'unknown',
      customerEmail: null,
      subject: null,
      tags: [],
      summary: content,
      rawText: '',
    };
  }
}

/**
 * Analyze multiple screenshots and combine results
 */
export async function analyzeMultipleScreenshots(
  files: Array<{ url: string; mimeType: string }>,
  botToken: string,
  messageText: string
): Promise<ImageAnalysisResult> {
  if (files.length === 0) {
    return {
      conversationId: null,
      conversationNumber: null,
      suggestedAction: 'unknown',
      customerEmail: null,
      subject: null,
      tags: [],
      summary: '',
      rawText: '',
    };
  }

  // Analyze the first image (most relevant)
  // Could be extended to analyze multiple and merge results
  const file = files[0];
  const imageBuffer = await downloadSlackImage(file.url, botToken);
  return analyzeScreenshot(imageBuffer, file.mimeType, messageText);
}
