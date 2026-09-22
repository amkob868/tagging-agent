import { ProcessingContext, logger } from '@support-agent-aws/shared';
import { helpScoutClient } from '@support-agent-aws/helpscout-client';
import { analyzeMultipleScreenshots, ImageAnalysisResult } from './image-analyzer';

export interface SlackFile {
  url: string;
  mimeType: string;
  name: string;
}

export interface RouteDecision {
  needsClarification: boolean;
  clarificationMessage?: string;
  targetLambda?: 'note-creator' | 'conversation-tagger';
  action?: 'research' | 'tagging';
  conversationId?: number;
  processingContext?: { context: ProcessingContext };
  imageAnalysis?: ImageAnalysisResult;
}

// Keywords that indicate research/note-creator action
const RESEARCH_KEYWORDS = ['research', 'lookup', 'note', 'look up', 'find info', 'investigate'];

// Keywords that indicate tagging action
const TAGGING_KEYWORDS = ['tag', 'classify', 'categorize', 'label', 'add tag', 'keyword'];

// HelpScout URL pattern: https://secure.helpscout.net/conversation/123456789
const HELPSCOUT_URL_PATTERN = /helpscout\.net\/conversation\/(\d+)/i;

// Conversation ID patterns - support various formats
const CONVERSATION_ID_PATTERNS = [
  /\b(\d{9,10})\b/,           // Full conversation ID (9-10 digits)
  /#\s*(\d{5,8})\b/,          // Short format like #147226
  /conversation[:#\s]*(\d+)/i, // "conversation 147226" or "conversation: 147226"
];

/**
 * Extract conversation ID from text using multiple patterns
 */
function extractConversationId(text: string): { id: number; isShortFormat: boolean } | null {
  // First try URL pattern
  const urlMatch = text.match(HELPSCOUT_URL_PATTERN);
  if (urlMatch) {
    return { id: parseInt(urlMatch[1], 10), isShortFormat: false };
  }

  // Try other patterns
  for (const pattern of CONVERSATION_ID_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const id = parseInt(match[1], 10);
      const isShortFormat = id < 1000000000; // Less than 10 digits = short format
      return { id, isShortFormat };
    }
  }

  return null;
}

/**
 * Determine action from text and image analysis
 */
function determineAction(
  text: string,
  imageAnalysis?: ImageAnalysisResult
): 'research' | 'tagging' | 'both' | 'unknown' {
  const textLower = text.toLowerCase();
  const isResearchText = RESEARCH_KEYWORDS.some((kw) => textLower.includes(kw));
  const isTaggingText = TAGGING_KEYWORDS.some((kw) => textLower.includes(kw));

  // Check image analysis suggestion
  const imageAction = imageAnalysis?.suggestedAction;

  if (isResearchText && isTaggingText) return 'both';
  if (isResearchText) return 'research';
  if (isTaggingText) return 'tagging';

  // Fall back to image analysis
  if (imageAction === 'research' || imageAction === 'tagging') {
    return imageAction;
  }

  return 'unknown';
}

/**
 * Parse a Slack message (with optional images) and determine routing
 */
export async function parseSlackMessage(
  text: string,
  files?: SlackFile[],
  botToken?: string
): Promise<RouteDecision> {
  logger.debug('Parsing Slack message', { textLength: text.length, fileCount: files?.length || 0 });

  let imageAnalysis: ImageAnalysisResult | undefined;

  // Analyze screenshots if present
  if (files && files.length > 0 && botToken) {
    const imageFiles = files.filter((f) =>
      f.mimeType.startsWith('image/')
    );

    if (imageFiles.length > 0) {
      logger.info('Analyzing screenshots', { count: imageFiles.length });
      try {
        imageAnalysis = await analyzeMultipleScreenshots(
          imageFiles.map((f) => ({ url: f.url, mimeType: f.mimeType })),
          botToken,
          text
        );
        logger.info('Screenshot analysis complete', {
          conversationId: imageAnalysis.conversationId,
          conversationNumber: imageAnalysis.conversationNumber,
          suggestedAction: imageAnalysis.suggestedAction,
        });
      } catch (error) {
        logger.error('Failed to analyze screenshots', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  // Extract conversation ID from text first, then fall back to image analysis
  let conversationResult = extractConversationId(text);

  // If not found in text, try image analysis
  if (!conversationResult && imageAnalysis) {
    if (imageAnalysis.conversationId) {
      conversationResult = { id: imageAnalysis.conversationId, isShortFormat: false };
    } else if (imageAnalysis.conversationNumber) {
      // Parse the conversation number from image (remove # if present)
      const numStr = imageAnalysis.conversationNumber.replace('#', '').trim();
      const num = parseInt(numStr, 10);
      if (!isNaN(num)) {
        conversationResult = { id: num, isShortFormat: true };
      }
    }
  }

  if (!conversationResult) {
    const suggestion = imageAnalysis?.summary
      ? `\n\nFrom the screenshot, I see: ${imageAnalysis.summary}`
      : '';

    return {
      needsClarification: true,
      clarificationMessage:
        `I couldn't find a HelpScout conversation ID in your message or screenshot.${suggestion}\n\nPlease include a link like \`https://secure.helpscout.net/conversation/123456789\` or mention the conversation number.`,
      imageAnalysis,
    };
  }

  const { id: conversationId, isShortFormat } = conversationResult;

  // Determine the action
  const action = determineAction(text, imageAnalysis);

  if (action === 'both') {
    return {
      needsClarification: true,
      clarificationMessage: `Found conversation ${conversationId}. Did you want me to:\n- *research* (create a note with customer info)\n- *tag* (classify and add tags)\n\nPlease reply with one of these options.`,
      imageAnalysis,
    };
  }

  if (action === 'unknown') {
    const contextFromImage = imageAnalysis?.summary
      ? `\n\nFrom the screenshot: ${imageAnalysis.summary}`
      : '';

    return {
      needsClarification: true,
      clarificationMessage: `Found conversation ${conversationId}, but I'm not sure what action you want.${contextFromImage}\n\nPlease clarify:\n- "research" or "lookup" to create a research note\n- "tag" or "classify" to add/fix tags`,
      imageAnalysis,
    };
  }

  // Fetch conversation details from HelpScout
  logger.info('Fetching conversation from HelpScout', { conversationId, isShortFormat });

  try {
    const conversation = await helpScoutClient.getConversation(conversationId);

    // Extract email body from threads
    const threads = conversation._embedded?.threads || [];
    const customerThread = threads.find((t: any) => t.type === 'customer');
    const emailBodyHtml = customerThread?.body || threads[0]?.body || '';
    const emailBody = emailBodyHtml
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const context: ProcessingContext = {
      conversationId,
      customerId: conversation.primaryCustomer?.id || 0,
      customerEmail: conversation.primaryCustomer?.email || imageAnalysis?.customerEmail || '',
      mailboxId: conversation.mailboxId,
      emailSubject: conversation.subject || imageAnalysis?.subject || '',
      emailBody,
      emailBodyHtml,
      tagsAdded: [],
      errors: [],
    };

    return {
      needsClarification: false,
      targetLambda: action === 'research' ? 'note-creator' : 'conversation-tagger',
      action,
      conversationId,
      processingContext: { context },
      imageAnalysis,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to fetch conversation from HelpScout', { conversationId, error: message });

    // If it's a short format ID, the full conversation ID might be different
    const shortFormatHint = isShortFormat
      ? `\n\n(Note: ${conversationId} appears to be a short conversation number. The full HelpScout conversation ID might be different.)`
      : '';

    return {
      needsClarification: true,
      clarificationMessage: `I found conversation ${conversationId} but couldn't fetch it from HelpScout. Error: ${message}${shortFormatHint}\n\nPlease verify the conversation ID or provide the full HelpScout URL.`,
      imageAnalysis,
    };
  }
}
