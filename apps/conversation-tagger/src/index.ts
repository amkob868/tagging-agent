import axios from 'axios';
import { DynamoDBClient, ScanCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import {
  StepFunctionEvent,
  StepFunctionResult,
  logger,
  setRequestId,
  getClaudeCredentials,
  getJevCredentials,
  MAILBOX_IDS
} from '@support-agent-aws/shared';
import { helpScoutClient } from '@support-agent-aws/helpscout-client';
import { parseAcmePrintsOrderNotification } from './orderTagging';
import { classifySupportEmailWithJev, classifyPrintsEmailWithJev } from './jevClassifier';

const dynamoClient = new DynamoDBClient({});
const TAGGING_RULES_TABLE = process.env.TAGGING_RULES_TABLE || 'support-agent-tagging-rules';
const CONFIDENCE_TABLE = process.env.CONFIDENCE_TABLE || 'support-agent-tag-confidence';
const MIN_CONFIDENCE_THRESHOLD = 40; // Don't apply tags below this confidence %
const SUPPORT_INBOX_BANNED_TAGS = ['foam board poster', 'foam-board'];

// ============================================
// DYNAMIC RULES FROM DYNAMODB WITH CONFIDENCE
// ============================================

interface DynamicTaggingRule {
  keyword: string;
  tagName: string;
  confidence: number;
}

async function getDynamicTaggingRules(): Promise<DynamicTaggingRule[]> {
  try {
    // Get rules from tagging rules table
    const rulesResult = await dynamoClient.send(new ScanCommand({
      TableName: TAGGING_RULES_TABLE,
    }));

    // Get confidence scores
    const confidenceResult = await dynamoClient.send(new ScanCommand({
      TableName: CONFIDENCE_TABLE,
    }));

    // Build confidence map
    const confidenceMap = new Map<string, number>();
    for (const item of confidenceResult.Items || []) {
      const keyword = item.keyword?.S;
      const confidence = parseInt(item.confidence?.N || '80', 10);
      if (keyword) {
        confidenceMap.set(keyword, confidence);
      }
    }

    const rules: DynamicTaggingRule[] = [];
    for (const item of rulesResult.Items || []) {
      const keyword = item.keyword?.S;
      const tagName = item.tagName?.S;
      if (keyword && tagName) {
        const confidence = confidenceMap.get(keyword) ?? 80; // Default 80% if not found
        rules.push({ keyword, tagName, confidence });
      }
    }

    logger.info('Loaded dynamic tagging rules with confidence', {
      ruleCount: rules.length,
      highConfidence: rules.filter(r => r.confidence >= 70).length,
      lowConfidence: rules.filter(r => r.confidence < MIN_CONFIDENCE_THRESHOLD).length
    });
    return rules;
  } catch (error) {
    logger.warn('Failed to load dynamic tagging rules', {
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    return [];
  }
}

async function incrementAppliedCount(keyword: string): Promise<void> {
  try {
    await dynamoClient.send(new UpdateItemCommand({
      TableName: CONFIDENCE_TABLE,
      Key: { keyword: { S: keyword } },
      UpdateExpression: 'SET appliedCount = if_not_exists(appliedCount, :zero) + :one, lastUpdated = :now',
      ExpressionAttributeValues: {
        ':one': { N: '1' },
        ':zero': { N: '0' },
        ':now': { S: new Date().toISOString() },
      },
    }));
  } catch (error) {
    logger.warn('Failed to increment applied count', { keyword, error });
  }
}

async function applyDynamicRules(text: string, dynamicRules: DynamicTaggingRule[]): Promise<string[]> {
  const textLower = text.toLowerCase();
  const tags: string[] = [];
  const appliedKeywords: string[] = [];

  for (const rule of dynamicRules) {
    // Skip rules below confidence threshold
    if (rule.confidence < MIN_CONFIDENCE_THRESHOLD) {
      logger.debug('Skipping low confidence rule', {
        keyword: rule.keyword,
        tag: rule.tagName,
        confidence: rule.confidence
      });
      continue;
    }

    if (textLower.includes(rule.keyword.toLowerCase())) {
      if (!tags.includes(rule.tagName)) {
        tags.push(rule.tagName);
        appliedKeywords.push(rule.keyword);
        logger.debug('Dynamic rule matched', {
          keyword: rule.keyword,
          tag: rule.tagName,
          confidence: rule.confidence
        });
      }
    }
  }

  // Track applied rules (fire and forget)
  for (const keyword of appliedKeywords) {
    incrementAppliedCount(keyword).catch(() => {});
  }

  return tags;
}

// ============================================
// SUPPORT INBOX FUNCTIONS
// ============================================

function getSupportKeywordTags(emailSubject: string, emailBody: string): string[] {
  const text = `${emailSubject} ${emailBody}`.toLowerCase();
  const tags: string[] = [];

  const keywordMappings = [
    { keywords: ['direct order link'], tag: 'direct order link' },
    { keywords: ['billing', 'payout', 'payment'], tag: 'billing' },
    { keywords: ['\\bprint\\b'], tag: 'print', useRegex: true },  // Only exact word "print"
    { keywords: ['download', 'downloads', 'downloading'], tag: 'downloads' },
    { keywords: ['search', 'searching'], tag: 'search' },
    { keywords: ['global replace'], tag: 'global replace' },
    { keywords: ['prints of love'], tag: 'prints of love' },
    { keywords: ['creative fabrica'], tag: 'creative fabrica' },
    { keywords: ['claimed', 'claim', 'order claim', 'email claim'], tag: 'change order claim email' },
    { keywords: ['custom integration'], tag: 'custom integration' },
    { keywords: ['custom integration'], tag: 'direct order link' },
    { keywords: ['apple pay', 'hide my email', 'apple id'], tag: 'apple pay' },
    { keywords: ['apple pay', 'hide my email', 'apple id'], tag: 'hide my email' },
    { keywords: ['copy and paste'], tag: 'copy and paste' },
    { keywords: ['hyperlink', 'hyperlinks'], tag: 'hyperlink' },
    { keywords: ['editing help', 'how do i edit', "can't figure out how to edit"], tag: 'editing help' },
    { keywords: ['organizations', 'organisations', 'multi-shop', 'more than 1 etsy shop', 'more than one etsy shop', 'add another shop'], tag: 'multi-organization' },
    { keywords: ["can't reset password", 'cant reset password', 'reset password', 'password', 'forgot password'], tag: 'forgot password' },
    { keywords: ['font', 'fonts'], tag: 'font' },
    { keywords: ['color palette', 'palette', 'color swatch', 'color swatches'], tag: 'color palette' },
    { keywords: ['design only plan', 'design only', '$5 plan', '$5'], tag: 'design only plan' },
    { keywords: ['download quality', 'quality', 'jpeg quality', 'blurry', 'download blurry', 'not sharp', 'download not sharp'], tag: 'download quality' },
    { keywords: ['png download', 'download png', 'black background', 'background is black'], tag: 'png download' },
    { keywords: ['styles', 'position', 'transform', 'rotation', 'opacity', 'stroke', 'hue', 'blur', 'brightness', 'sharpen', 'contrast', 'saturation', 'drop shadow', 'outer glow', 'blend mode'], tag: 'styles' },
    { keywords: ['styles', 'position', 'transform', 'rotation', 'opacity', 'stroke', 'hue', 'blur', 'brightness', 'sharpen', 'contrast', 'saturation', 'drop shadow', 'outer glow', 'blend mode'], tag: 'editor' },
    { keywords: ['pdf importer', 'pdf import', 'pdf upload', 'pdf uploader', 'pdf tool', 'pdf beta', 'pfd files transfer'], tag: 'pdf import' },
    { keywords: ['canva', 'canva import', 'canva tool'], tag: 'canva import' },
    { keywords: ['canva', 'canva import', 'canva tool'], tag: 'canva' },
    { keywords: ['outgoing call (answered)'], tag: 'voicemail' },
    { keywords: ['order prints', 'prints', 'acme prints'], tag: 'acme prints' },
    { keywords: ['blank page'], tag: 'blank page' },
    { keywords: ['conversion', 'convert tool', 'converting', 'conversion tool'], tag: 'conversion' },
    { keywords: ['paperless post'], tag: 'paperless post' },
    { keywords: ['blank screen', 'blank page', 'takes me to blank', 'shows me blank'], tag: 'blank screen' },
    { keywords: ['eggshell', 'egg shell'], tag: 'eggshell' },
    { keywords: ['teachers pay teachers', 'tpt', "teacher's pay teachers"], tag: 'teacherspayteachers' },
    { keywords: ['\\bmobile\\b', '\\bphones?\\b', '\\biphones?\\b', '\\bandroid\\b'], tag: 'mobile', useRegex: true },  // \b so "telephone"/"headphones"/"automobile" don't match
  ];

  for (const mapping of keywordMappings) {
    for (const keyword of mapping.keywords) {
      const found = (mapping as any).useRegex
        ? new RegExp(keyword, 'i').test(text)
        : text.includes(keyword);
      if (found) {
        if (!tags.includes(mapping.tag)) {
          tags.push(mapping.tag);
        }
        break;
      }
    }
  }

  return tags;
}

async function classifySupportEmailWithClaude(
  apiKey: string,
  emailSubject: string,
  emailBody: string,
  isDesigner: boolean,
  isEnduser: boolean
): Promise<string[]> {
  const userType = isDesigner ? 'Designer (seller)' : (isEnduser ? 'End User (customer/buyer)' : 'Unknown');

  const prompt = `You are a support ticket classifier for Acme, a platform where designers sell customizable digital products to end users/customers.

The email sender is a: ${userType}

Email Subject: ${emailSubject}

Email Body:
${emailBody}

Based on the email content, select the MOST appropriate tag(s) from this list. You may select multiple tags if applicable, but be selective - only choose tags that clearly match the email content.

Available tags:
- "acme customer" = The email is coming from a acme customer/end user (NOT a designer/seller)
- "missing order" = An order is missing or not showing up
- "how do i respond to my customer" = A designer is explicitly asking Acme support for guidance on how to reply to or help their buyer/customer. The designer must be directly requesting advice on what to say or do. Do NOT use this tag if the designer is simply reporting a customer issue, forwarding a complaint, or mentioning a customer in passing.
- "email change" = Customer or seller requesting to update their account email
- "general" = General questions about the Acme platform
- "2.0 how do I" = Question involving how to use the 2.0 version of Acme
- "need more info" = Not enough information provided to help the customer
- "data removal" = Request to remove data
- "cancel" = Request to cancel their account
- "downloads" = Anything to do with downloads (need more downloads, out of downloads, file doesn't download, etc.)
- "listing issue" = Any issue involving a listing
- "categories" = A seller/designer has a question, concern, or possible bug about Acme categories (Tags, Collections, or Folders)
- "not a friend of acme" = Email is hostile, angry, threatening to leave for competitors (like Canva), demanding staff be fired, or generally unconstructive/rude complaints

IMPORTANT RULES:
1. If the user is an End User (customer/buyer), always include "acme customer" tag
2. Only use "how do i respond to my customer" if the designer is explicitly asking for advice on how to respond to or help their buyer. Do NOT apply it just because a designer mentions a customer or forwards a customer issue.
3. Only use "need more info" if the email genuinely lacks details needed to help
4. Be specific - prefer specific tags over "general" when possible

Respond with ONLY a JSON array of tag strings, nothing else. Example: ["acme customer", "downloads"]`;

  return callClaude(apiKey, prompt);
}

// ============================================
// PRINTS INBOX FUNCTIONS
// ============================================

export function getPrintsKeywordTags(emailSubject: string, emailBody: string): string[] {
  const rawText = `${emailSubject} ${emailBody}`.toLowerCase();
  // Strip SKU/envelope-name tokens (e.g. "ACME-A7-PLAIN-PEARL-UW") so paper-type
  // keywords like "pearl" only match when describing the paper itself,
  // not an envelope product name
  const text = rawText.replace(/acme-[a-z0-9-]+/g, ' ');
  const tags: string[] = [];

  const keywordMappings = [
    { keywords: ['foam board', 'foamboard', 'foam poster'], tag: 'foam board poster' },
    { keywords: ['pearl'], tag: 'pearl' },
    { keywords: ['shipping', 'delivery', 'arrive', 'when will', 'eta', 'how long'], tag: 'shipping question' },
    { keywords: ['priority mail', 'priority shipping', '2-3 business days', '2-3 business', '2 to 3 business'], tag: 'priority mail' },
    { keywords: ['overnight', 'next day', 'next-day'], tag: 'overnight shipping' },
    { keywords: ['rush', 'urgent', 'asap', 'expedite', 'fast'], tag: 'rush order' },
    { keywords: ['qr code', 'qr', 'qrcode'], tag: 'qr code' },
  ];

  for (const mapping of keywordMappings) {
    for (const keyword of mapping.keywords) {
      if (text.includes(keyword)) {
        if (!tags.includes(mapping.tag)) {
          tags.push(mapping.tag);
        }
        break;
      }
    }
  }

  // "egg shell" applies to ANY mention of eggshell EXCEPT these envelope SKUs,
  // which are eggshell-colored envelopes, not the eggshell paper type
  const EGGSHELL_ENVELOPE_SKUS = [
    'acme-a7-plain-eggshell-uw',
    'acme-a2-plain-eggshell-uw',
    'acme-a1-plain-eggshell-w',
  ];
  let eggshellText = rawText;
  for (const sku of EGGSHELL_ENVELOPE_SKUS) {
    eggshellText = eggshellText.replaceAll(sku, ' ');
  }
  if (eggshellText.includes('eggshell') || eggshellText.includes('egg shell')) {
    tags.push('egg shell');
  }

  return tags;
}



// Known third-party printer/shipping domains and their associated tags
// These are automated notifications that should NOT get customer-related tags
const PRINTER_DOMAIN_CONFIG: { domain: string; tags: string[] }[] = [
  { domain: 'sinalite.com', tags: ['sinalite'] },
  { domain: 'printswell.com', tags: [] },
  { domain: 'shipstation.com', tags: [] },
  { domain: 'millerslab.com', tags: [] },
  { domain: 'onlineprintsale.com', tags: [] },  // Sinalite Online Proofer
  { domain: 'ups.com', tags: [] },  // UPS shipping notifications
  { domain: 'printandgo', tags: [] },  // Spam/printer notifications
  { domain: 'printtimeusa', tags: [] },  // Spam/printer notifications
];

// Tags that should never be applied to emails from printer domains
const PRINTER_EXCLUDED_TAGS = [
  'overnight shipping',
  'shipping question',
  'print',
];

function getMatchingPrinterConfig(senderEmail: string): { domain: string; tags: string[] } | null {
  const emailLower = senderEmail.toLowerCase();
  return PRINTER_DOMAIN_CONFIG.find(config => emailLower.includes(config.domain)) || null;
}

function isFromPrinterDomain(senderEmail: string): boolean {
  return getMatchingPrinterConfig(senderEmail) !== null;
}

function isPrinterNotificationEmail(senderEmail: string, emailSubject: string): boolean {
  const subjectLower = emailSubject.toLowerCase();

  // Check if sender is from a known printer domain
  const fromPrinter = isFromPrinterDomain(senderEmail);

  // Check if it's a shipping/fulfillment notification
  const isShippingNotification = subjectLower.includes('shipped') ||
    subjectLower.includes('has been printed') ||
    subjectLower.includes('tracking') ||
    subjectLower.includes('fulfillment');

  return fromPrinter && isShippingNotification;
}

function getPrinterTags(senderEmail: string): string[] {
  const config = getMatchingPrinterConfig(senderEmail);
  return config ? config.tags : [];
}

function filterPrinterExcludedTags(tags: string[], senderEmail: string): string[] {
  if (!isFromPrinterDomain(senderEmail)) {
    return tags;
  }
  // Filter out excluded tags and add printer-specific tags
  const filteredTags = tags.filter(tag => !PRINTER_EXCLUDED_TAGS.includes(tag));
  const printerTags = getPrinterTags(senderEmail);
  for (const tag of printerTags) {
    if (!filteredTags.includes(tag)) {
      filteredTags.push(tag);
    }
  }
  return filteredTags;
}

async function classifyPrintsEmailWithClaude(
  apiKey: string,
  emailSubject: string,
  emailBody: string,
  senderEmail: string,
  isThirdPartyPrinter: boolean
): Promise<string[]> {
  const senderType = isThirdPartyPrinter ? '3rd Party Printer (automated notification)' : 'Customer or Unknown';

  const prompt = `You are a support ticket classifier for Acme Prints, a print fulfillment service for customizable products.

The email sender appears to be: ${senderType}
Sender Email: ${senderEmail}

Email Subject: ${emailSubject}

Email Body:
${emailBody}

Based on the email content, select the MOST appropriate tag(s) from this list. You may select multiple tags if applicable, but be selective - only choose tags that clearly match the email content.

Available tags:
- "foam board poster" = The email is about a foam board poster print product
- "pearl" = The email mentions pearlescent finish/paper print products
- "shipping question" = Customer asking about shipping status, delivery time, or when their order will arrive
- "question about print order" = General question about a print order (status, details, etc.)
- "priority mail" = Customer is asking about or requesting priority mail shipping, OR the email mentions 2-3 business days shipping
- "overnight shipping" = Customer is asking about or requesting overnight/next-day shipping
- "rush order" = Customer needs their order rushed, expedited, or completed urgently

IMPORTANT RULES:
1. Be specific - prefer specific tags over general ones when possible
2. If a customer is asking about their order in a general way, use "question about print order"
3. "shipping question" is for questions about delivery/arrival, while "question about print order" is for other order-related questions
4. Only apply tags that are clearly relevant to the email content
5. Multiple tags can apply - for example, a rush order for foam board posters would get both "rush order" and "foam board poster"

Respond with ONLY a JSON array of tag strings, nothing else. Example: ["shipping question", "foam board poster"]`;

  return callClaude(apiKey, prompt);
}

// ============================================
// SHARED FUNCTIONS
// ============================================

async function callClaude(apiKey: string, prompt: string): Promise<string[]> {
  try {
    logger.info('Calling Claude API for classification');
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }],
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      }
    );

    const responseText = response.data.content?.[0]?.text || '[]';
    logger.info('Claude response received', { responseText: responseText.substring(0, 200) });
    const jsonMatch = responseText.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
      const tags = JSON.parse(jsonMatch[0]);
      const filteredTags = tags.filter((tag: unknown) => typeof tag === 'string');
      logger.info('Claude tags parsed', { tags: filteredTags });
      return filteredTags;
    }
    logger.warn('No JSON array found in Claude response');
    return [];
  } catch (error: any) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    const status = error?.response?.status;
    const data = error?.response?.data;
    logger.error('Claude classification failed', { error: message, status, data: JSON.stringify(data)?.substring(0, 500) });
    return [];
  }
}

// ============================================
// MAIN HANDLER
// ============================================

export async function handler(event: StepFunctionEvent): Promise<StepFunctionResult> {
  const { context } = event;
  setRequestId(`tagger-${context.conversationId}`);

  logger.info('Starting conversation tagging', { mailboxId: context.mailboxId });

  try {
    const hasDesign = !!context.designOrg;
    const hasEnduser = !!context.enduserOrg;
    const emailSubject = context.emailSubject || '';
    const mailboxId = context.mailboxId;
    const isPrintsInbox = mailboxId === MAILBOX_IDS.PRINTS;

    // Get full conversation with threads
    const conversation = await helpScoutClient.getConversation(context.conversationId);
    const existingTags: string[] = conversation.tags?.map((t: { name: string }) => t.name) || [];

    // Use context email body first (from webhook), then try to get from fetched conversation as backup
    let emailBodyHtml = context.emailBodyHtml || '';
    let emailBody = context.emailBody || '';

    // If webhook didn't have body, try to get from fetched conversation
    if (!emailBodyHtml) {
      const threads = conversation._embedded?.threads || [];
      // Try customer thread first, then any thread
      const customerThread = threads.find((t: any) => t.type === 'customer');
      const anyThread = threads[0];
      emailBodyHtml = customerThread?.body || anyThread?.body || '';
      emailBody = emailBodyHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    }

    logger.info('Email body info', {
      hasEmailBodyHtml: !!emailBodyHtml,
      emailBodyHtmlLength: emailBodyHtml.length,
      source: context.emailBodyHtml ? 'webhook' : 'fetched'
    });

    let allSuggestedTags: string[] = [];

    if (isPrintsInbox) {
      // ============================================
      // PRINTS INBOX LOGIC
      // ============================================
      logger.info('Processing as Prints inbox');

      // Handle third-party printer emails (SinaLite, Printswell, etc.)
      // Skip keyword + AI tagging entirely and just apply printer-specific tags
      if (isFromPrinterDomain(context.customerEmail)) {
        const printerTags = getPrinterTags(context.customerEmail);
        logger.info('Third-party printer email detected, applying printer tags only', {
          senderEmail: context.customerEmail,
          tags: printerTags
        });
        allSuggestedTags = [...printerTags];
      }
      // Parse AcmePrints order notifications
      else if (parseAcmePrintsOrderNotification(emailBodyHtml).isAcmePrintsNotification) {
        const acmePrintsNotification = parseAcmePrintsOrderNotification(emailBodyHtml);
        // For AcmePrints internal order notifications, ONLY use the notification-specific tags
        // (rush, overnight, priority based on actual shipping method selected)
        // Skip keyword and AI tagging to avoid false positives
        logger.info('AcmePrints order notification detected', {
          tags: acmePrintsNotification.suggestedTags,
          buyerEmail: acmePrintsNotification.buyerEmail,
          hasBuyerEmail: !!acmePrintsNotification.buyerEmail,
          emailBodyHtmlLength: emailBodyHtml.length
        });
        allSuggestedTags = [...acmePrintsNotification.suggestedTags];

        // Store buyer email for related orders detection in note-creator
        if (acmePrintsNotification.buyerEmail) {
          context.buyerEmail = acmePrintsNotification.buyerEmail;
          logger.info('Buyer email stored in context', { buyerEmail: context.buyerEmail });
        } else {
          logger.warn('No buyer email found in AcmePrints notification');
        }
      } else {
        // For customer emails, use keyword + AI tagging
        const keywordTags = getPrintsKeywordTags(emailSubject, emailBody);
        logger.info('Keyword tags found', { tags: keywordTags });

        let aiTags: string[] = [];
        if (emailSubject || emailBody) {
          try {
            const jevCredentials = await getJevCredentials();
            aiTags = await classifyPrintsEmailWithJev(
              jevCredentials.api_key,
              emailSubject,
              emailBody,
              context.customerEmail,
              false
            );
          } catch (jevError: any) {
            logger.error('Jev tagging failed, falling back to Claude', { error: jevError?.message || 'Unknown error' });
            const claudeCredentials = await getClaudeCredentials();
            aiTags = await classifyPrintsEmailWithClaude(
              claudeCredentials.api_key,
              emailSubject,
              emailBody,
              context.customerEmail,
              false
            );
          }
          logger.info('AI tags found', { tags: aiTags });
        }

        // Combine keyword + AI tags
        allSuggestedTags = [...keywordTags];
        for (const tag of aiTags) {
          if (!allSuggestedTags.includes(tag)) {
            allSuggestedTags.push(tag);
          }
        }
      }

    } else {
      // ============================================
      // SUPPORT INBOX LOGIC (default)
      // ============================================
      logger.info('Processing as Support inbox');

      // Get keyword-based tags
      const keywordTags = getSupportKeywordTags(emailSubject, emailBody);
      logger.info('Keyword tags found', { tags: keywordTags });

      // Get AI-based tags
      let aiTags: string[] = [];
      if (emailSubject || emailBody) {
        try {
          try {
            const jevCredentials = await getJevCredentials();
            aiTags = await classifySupportEmailWithJev(
              jevCredentials.api_key,
              emailSubject,
              emailBody,
              hasDesign,
              hasEnduser
            );
          } catch (jevError: any) {
            logger.error('Jev tagging failed, falling back to Claude', { error: jevError?.message || 'Unknown error' });
            const claudeCredentials = await getClaudeCredentials();
            aiTags = await classifySupportEmailWithClaude(
              claudeCredentials.api_key,
              emailSubject,
              emailBody,
              hasDesign,
              hasEnduser
            );
          }
          logger.info('AI tags found', { tags: aiTags });
        } catch (aiError: any) {
          logger.error('AI tagging failed', { error: aiError?.message || 'Unknown error' });
        }
      } else {
        logger.warn('No email subject or body for AI tagging');
      }

      // Combine keyword and AI tags
      allSuggestedTags = [...keywordTags];
      for (const tag of aiTags) {
        if (!allSuggestedTags.includes(tag)) {
          allSuggestedTags.push(tag);
        }
      }

      // Add "acme seller" tag if they're a designer
      if (hasDesign && !allSuggestedTags.includes('acme seller')) {
        allSuggestedTags.push('acme seller');
      }

      // Designers should never get the "acme customer" tag — the AI sometimes adds it
      // when the email body mentions "customers" (e.g., a designer asking about their buyers)
      if (hasDesign && allSuggestedTags.includes('acme customer')) {
        allSuggestedTags = allSuggestedTags.filter(tag => tag !== 'acme customer');
        logger.info('Removed "acme customer" tag from designer');
      }

      // If customer is replying from a registration code email and didn't provide an order number,
      // they likely need to provide more info
      const isRegistrationCodeEmail = /Registration Code is \d+/i.test(emailSubject);
      const hasOrderNumber = /\b\d{5,8}\b/.test(emailBody); // Order numbers are typically 5-8 digits

      if (isRegistrationCodeEmail && !hasOrderNumber && allSuggestedTags.includes('acme customer')) {
        if (!allSuggestedTags.includes('need more info')) {
          allSuggestedTags.push('need more info');
          logger.info('Added need more info tag - registration code email without order number');
        }
      }
    }

    // Load and apply dynamic tagging rules from DynamoDB (with confidence filtering)
    const dynamicRules = await getDynamicTaggingRules();
    if (dynamicRules.length > 0) {
      const dynamicTags = await applyDynamicRules(`${emailSubject} ${emailBody}`, dynamicRules);
      for (const tag of dynamicTags) {
        if (!allSuggestedTags.includes(tag)) {
          allSuggestedTags.push(tag);
        }
      }
      logger.info('Dynamic tags applied', { tags: dynamicTags });
    }

    // Filter out tags excluded for printer domains (e.g., sinalite.com)
    allSuggestedTags = filterPrinterExcludedTags(allSuggestedTags, context.customerEmail);

    // Filter out banned tags from the support inbox
    if (!isPrintsInbox) {
      allSuggestedTags = allSuggestedTags.filter(tag => !SUPPORT_INBOX_BANNED_TAGS.includes(tag));
    }

    // Remove "how do i respond to my customer" if "acme customer" is present
    // (doesn't make sense for actual customers to have this tag)
    if (allSuggestedTags.includes('acme customer') && allSuggestedTags.includes('how do i respond to my customer')) {
      allSuggestedTags = allSuggestedTags.filter(tag => tag !== 'how do i respond to my customer');
    }

    // Filter out tags that already exist
    const tagsToAdd = allSuggestedTags.filter(tag => !existingTags.includes(tag));

    if (tagsToAdd.length === 0) {
      logger.info('No new tags to add');
      return { success: true, context };
    }

    // Add all new tags
    const newTags = [...existingTags, ...tagsToAdd];
    await helpScoutClient.updateConversationTags(context.conversationId, newTags);

    logger.info('Tags added', { tags: tagsToAdd });
    context.tagsAdded = tagsToAdd;

    return { success: true, context };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Tagging failed', { error: message });

    context.errors = context.errors || [];
    context.errors.push({
      step: 'conversation-tagger',
      message,
      recoverable: true,
    });

    return { success: true, context }; // Continue despite error
  }
}
