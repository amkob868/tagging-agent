import axios from 'axios';
import { DynamoDBClient, ScanCommand } from '@aws-sdk/client-dynamodb';
import {
  StepFunctionEvent,
  StepFunctionResult,
  logger,
  setRequestId,
  getClaudeCredentials,
  MAILBOX_IDS
} from '@support-agent-aws/shared';
import { helpScoutClient } from '@support-agent-aws/helpscout-client';
import { acmeClient } from '@support-agent-aws/acme-client';

const dynamoClient = new DynamoDBClient({});
const RESEARCH_CAPABILITIES_TABLE = process.env.RESEARCH_CAPABILITIES_TABLE || 'support-agent-research-capabilities';

// ============================================
// DYNAMIC CAPABILITIES FROM DYNAMODB
// ============================================

interface ResearchCapability {
  capabilityId: string;
  description: string;
  enabled: boolean;
}

async function getResearchCapabilities(): Promise<ResearchCapability[]> {
  try {
    const result = await dynamoClient.send(new ScanCommand({
      TableName: RESEARCH_CAPABILITIES_TABLE,
    }));

    const capabilities: ResearchCapability[] = [];
    for (const item of result.Items || []) {
      const capabilityId = item.capabilityId?.S;
      const description = item.description?.S;
      const enabled = item.enabled?.BOOL ?? true;

      if (capabilityId && description && enabled) {
        capabilities.push({ capabilityId, description, enabled });
      }
    }

    logger.info('Loaded research capabilities', { count: capabilities.length });
    return capabilities;
  } catch (error) {
    logger.warn('Failed to load research capabilities', {
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    return [];
  }
}

interface CapabilityResult {
  capabilityId: string;
  applied: boolean;
  noteContent?: string;
}

async function applyDynamicCapabilities(
  apiKey: string,
  capabilities: ResearchCapability[],
  emailSubject: string,
  emailBody: string,
  conversationId: number
): Promise<CapabilityResult[]> {
  if (capabilities.length === 0) {
    return [];
  }

  const results: CapabilityResult[] = [];

  // Use Claude to determine which capabilities to apply and how
  const capabilityDescriptions = capabilities
    .map(c => `- ${c.capabilityId}: ${c.description}`)
    .join('\n');

  const prompt = `You are a support agent assistant. Analyze this email and determine which research capabilities should be applied.

Email Subject: ${emailSubject}

Email Body:
${emailBody}

Available capabilities:
${capabilityDescriptions}

For each capability that should be applied, provide the note content that should be added to this HelpScout conversation.

Respond with JSON only:
{
  "results": [
    {
      "capabilityId": "capability-id",
      "applied": true,
      "noteContent": "The note to add (if any)"
    }
  ]
}

Only include capabilities that are relevant to this email. If a capability doesn't apply, set applied: false.
If a capability is already handled by built-in features (like translation), you can skip it.`;

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-3-haiku-20240307',
        max_tokens: 2048,
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

    const responseText = response.data.content?.[0]?.text || '{}';
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      for (const result of parsed.results || []) {
        if (result.applied && result.noteContent) {
          results.push({
            capabilityId: result.capabilityId,
            applied: true,
            noteContent: result.noteContent,
          });
        }
      }
    }
  } catch (error) {
    logger.error('Failed to apply dynamic capabilities', {
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }

  return results;
}

// ============================================
// HTML EMAIL EXTRACTION HELPER
// ============================================

/**
 * Extract a clean email address from a string that may contain HTML tags.
 * e.g. '<a href="mailto:foo@bar.com">foo@bar.com</a>' → 'foo@bar.com'
 */
function extractCleanEmail(raw: string): string | null {
  const stripped = raw.replace(/<[^>]+>/g, '').trim();
  const emailPattern = /[^\s@]+@[^\s@]+\.[^\s@]+/;
  const match = stripped.match(emailPattern);
  return match ? match[0].toLowerCase() : null;
}

// ============================================
// RELATED ORDERS
// ============================================

interface RelatedOrder {
  conversationId: number;
  subject: string;
  createdAt: string;
}

async function findRelatedOrders(
  buyerEmail: string,
  currentConversationId: number,
  mailboxId: number,
  hoursBack: number = 12
): Promise<RelatedOrder[]> {
  const relatedOrders: RelatedOrder[] = [];

  try {
    // Search for AcmePrints orders in the mailbox
    // Since all orders come from orders@acmeprints.example, we search by that sender
    // and then check the buyer email in each conversation's body
    const result = await helpScoutClient.listConversationsByCustomerEmail(
      'orders@acmeprints.example',
      mailboxId,
      'all'
    );

    logger.info('Related orders search result', {
      hasEmbedded: !!result?._embedded,
      conversationCount: result?._embedded?.conversations?.length || 0,
      buyerEmail: buyerEmail,
      currentConversationId
    });

    if (!result?._embedded?.conversations) {
      return relatedOrders;
    }

    const cutoffTime = new Date(Date.now() - hoursBack * 60 * 60 * 1000);

    for (const conv of result._embedded.conversations) {
      // Skip the current conversation
      if (conv.id === currentConversationId) {
        continue;
      }

      // Check if it's within the time window
      const createdAt = new Date(conv.createdAt);
      if (createdAt < cutoffTime) {
        continue;
      }

      // Check if it's a AcmePrints order (subject contains "Acme Prints Receipt")
      if (!conv.subject?.includes('Acme Prints Receipt')) {
        continue;
      }

      // Get the full conversation to check the buyer email in the body
      try {
        const fullConv = await helpScoutClient.getConversation(conv.id);
        const threads = fullConv?._embedded?.threads || [];

        // Find the original customer thread (type: 'customer') which contains the order notification
        // Threads may be sorted newest first, so we need to find the right one
        let body = '';
        for (const thread of threads) {
          if (thread.type === 'customer' && thread.body) {
            body = thread.body;
            break;
          }
        }

        // Fallback to first thread if no customer thread found
        if (!body && threads.length > 0) {
          body = threads[threads.length - 1]?.body || threads[0]?.body || '';
        }

        // Extract buyer email from the body: "placed by Name (email@example.com)"
        // The regex may capture HTML tags if the email is in an <a> tag, so we clean it
        const emailMatch = body.match(/placed by[^(]+\(([^)]+@[^)]+)\)/i);
        const convBuyerEmail = emailMatch ? extractCleanEmail(emailMatch[1]) : null;

        logger.debug('Checking conversation for buyer email match', {
          conversationId: conv.id,
          convBuyerEmail,
          targetBuyerEmail: buyerEmail.toLowerCase(),
          matches: convBuyerEmail === buyerEmail.toLowerCase()
        });

        // Check if this order is from the same buyer
        if (convBuyerEmail === buyerEmail.toLowerCase()) {
          relatedOrders.push({
            conversationId: conv.id,
            subject: conv.subject,
            createdAt: conv.createdAt,
          });
        }
      } catch (convError) {
        logger.warn('Failed to fetch conversation for related order check', {
          conversationId: conv.id,
          error: convError instanceof Error ? convError.message : 'Unknown error'
        });
      }
    }
  } catch (error) {
    logger.warn('Failed to search for related orders', {
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }

  return relatedOrders;
}

// ============================================
// ALL-TIME CUSTOMER ORDER HISTORY
// ============================================

async function findCustomerOrderHistory(
  buyerEmail: string,
  currentConversationId: number,
  mailboxId: number
): Promise<RelatedOrder[]> {
  const orders: RelatedOrder[] = [];

  try {
    // Search for AcmePrints order receipts mentioning this buyer email
    const result = await helpScoutClient.searchConversations(
      `(body:"${buyerEmail}" AND mailboxid:${mailboxId} AND subject:"Acme Prints Receipt")`
    );

    if (!result?._embedded?.conversations) {
      return orders;
    }

    for (const conv of result._embedded.conversations) {
      // Skip the current conversation
      if (conv.id === currentConversationId) {
        continue;
      }

      // Verify the buyer email actually matches by checking the conversation body
      try {
        const fullConv = await helpScoutClient.getConversation(conv.id);
        const threads = fullConv?._embedded?.threads || [];

        let body = '';
        for (const thread of threads) {
          if (thread.type === 'customer' && thread.body) {
            body = thread.body;
            break;
          }
        }
        if (!body && threads.length > 0) {
          body = threads[threads.length - 1]?.body || threads[0]?.body || '';
        }

        // Extract buyer email from "placed by Name (email@example.com)"
        // The regex may capture HTML tags if the email is in an <a> tag, so we clean it
        const emailMatch = body.match(/placed by[^(]+\(([^)]+@[^)]+)\)/i);
        const convBuyerEmail = emailMatch ? extractCleanEmail(emailMatch[1]) : null;

        if (convBuyerEmail !== buyerEmail.toLowerCase()) {
          logger.debug('Skipping non-matching order in history', {
            conversationId: conv.id,
            convBuyerEmail,
            targetBuyerEmail: buyerEmail.toLowerCase(),
          });
          continue;
        }
      } catch (convError) {
        logger.warn('Failed to verify buyer email for order history', {
          conversationId: conv.id,
          error: convError instanceof Error ? convError.message : 'Unknown error',
        });
        continue;
      }

      orders.push({
        conversationId: conv.id,
        subject: conv.subject || 'No subject',
        createdAt: conv.createdAt,
      });
    }

    // Sort by date descending (most recent first)
    orders.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    logger.info('Customer order history search complete', {
      buyerEmail,
      totalFound: orders.length,
    });
  } catch (error) {
    logger.warn('Failed to search customer order history', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }

  return orders;
}

interface TranslationResult {
  isNonEnglish: boolean;
  detectedLanguage: string | null;
  translatedSubject: string | null;
  translatedBody: string | null;
}

async function detectAndTranslate(
  apiKey: string,
  emailSubject: string,
  emailBody: string
): Promise<TranslationResult> {
  const result: TranslationResult = {
    isNonEnglish: false,
    detectedLanguage: null,
    translatedSubject: null,
    translatedBody: null,
  };

  const textToAnalyze = `${emailSubject}\n\n${emailBody}`.trim();
  if (!textToAnalyze) {
    return result;
  }

  const prompt = `Analyze the following email and determine if it is written in a language other than English.

Email Subject: ${emailSubject}

Email Body:
${emailBody}

IMPORTANT: Focus ONLY on the language of the email content itself. Ignore sender names, email addresses, and proper nouns when determining language.

Only classify an email as non-English if it contains 5 or more words in a foreign language. If the email is in English (or mostly English with a few foreign words, names, or typos), respond with:
{"isNonEnglish": false}

If the email contains 5 or more non-English words indicating it is written in a non-English language, respond with a JSON object containing:
- isNonEnglish: true
- detectedLanguage: the name of the language (e.g., "Spanish", "French", "Portuguese")
- translatedSubject: the subject translated to English
- translatedBody: the body translated to English (preserve formatting, keep it concise)

Respond with ONLY valid JSON, nothing else.`;

  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        temperature: 0,
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

    const responseText = response.data.content?.[0]?.text || '{}';
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        isNonEnglish: parsed.isNonEnglish || false,
        detectedLanguage: parsed.detectedLanguage || null,
        translatedSubject: parsed.translatedSubject || null,
        translatedBody: parsed.translatedBody || null,
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Translation detection failed', { error: message });
  }

  return result;
}

export async function handler(event: StepFunctionEvent): Promise<StepFunctionResult> {
  const { context } = event;
  setRequestId(`note-${context.conversationId}`);

  logger.info('Starting note creation', { mailboxId: context.mailboxId, isMovedConversation: context.isMovedConversation });

  // Skip note creation for moved conversations — they already have a research note
  if (context.isMovedConversation) {
    logger.info('Skipping note creation for moved conversation');
    return { success: true, context };
  }

  try {
    const orgs = context.organizations || [];
    const isPrintsInbox = context.mailboxId === MAILBOX_IDS.PRINTS;
    const hasCustomer = orgs.length > 0;
    const hasDesign = !!context.designOrg;
    const hasEnduser = !!context.enduserOrg;

    // Check for non-English emails and create translation note if needed
    const emailSubject = context.emailSubject || '';
    const emailBody = context.emailBody || '';

    // Skip translation and dynamic capabilities for AcmePrints order notifications —
    // they're automated internal emails that don't need these, and skipping saves ~2-4s
    const isAcmePrintsReceipt = isPrintsInbox && emailSubject.includes('Acme Prints Receipt');

    if ((emailSubject || emailBody) && !isAcmePrintsReceipt) {
      try {
        const claudeCredentials = await getClaudeCredentials();
        const translation = await detectAndTranslate(
          claudeCredentials.api_key,
          emailSubject,
          emailBody
        );

        if (translation.isNonEnglish && translation.translatedBody) {
          const translationLines: string[] = [];
          translationLines.push(`=== TRANSLATION (${translation.detectedLanguage}) ===`);
          translationLines.push('');
          if (translation.translatedSubject) {
            translationLines.push(`Subject: ${translation.translatedSubject}`);
            translationLines.push('');
          }
          translationLines.push(translation.translatedBody);
          translationLines.push('');
          translationLines.push('================================');

          await helpScoutClient.createNote(context.conversationId, translationLines.join('\n'));
          logger.info('Translation note created', { language: translation.detectedLanguage });
          context.translationCreated = true;
        }
      } catch (translationError) {
        logger.warn('Translation check failed', {
          error: translationError instanceof Error ? translationError.message : 'Unknown error'
        });
      }

      // Apply dynamic research capabilities from DynamoDB
      try {
        const claudeCredentials = await getClaudeCredentials();
        const capabilities = await getResearchCapabilities();

        if (capabilities.length > 0) {
          const capabilityResults = await applyDynamicCapabilities(
            claudeCredentials.api_key,
            capabilities,
            emailSubject,
            emailBody,
            context.conversationId
          );

          // Create notes for each applied capability
          for (const result of capabilityResults) {
            if (result.applied && result.noteContent) {
              await helpScoutClient.createNote(context.conversationId, result.noteContent);
              logger.info('Dynamic capability applied', { capabilityId: result.capabilityId });
            }
          }
        }
      } catch (capabilityError) {
        logger.warn('Dynamic capabilities check failed', {
          error: capabilityError instanceof Error ? capabilityError.message : 'Unknown error'
        });
      }
    }

    // Try to get recent order (needed for both inboxes)
    let orders: any[] = [];
    try {
      if (context.enduserOrg) {
        orders = await acmeClient.listOrdersByBuyerOrgId(context.enduserOrg.orgId, 1);
      }
      if (orders.length === 0) {
        orders = await acmeClient.listOrdersByEmail(context.customerEmail, 1);
      }
    } catch (orderError) {
      logger.warn('Failed to fetch orders for note', {
        error: orderError instanceof Error ? orderError.message : 'Unknown error'
      });
    }

    const hasOrders = orders.length > 0;

    // For Prints inbox, check for related orders BEFORE the early return
    // This is because AcmePrints orders come from orders@acmeprints.example which won't match any customer
    let relatedOrdersFound = false;
    let printsOrderHistory: RelatedOrder[] = [];
    if (isPrintsInbox) {
      const isAcmePrintsOrder = emailSubject.includes('Acme Prints Receipt');

      // Use buyerEmail (extracted from order notification) if available, otherwise fall back to customerEmail
      const emailForLookup = context.buyerEmail || context.customerEmail;

      logger.info('Related orders check', {
        isAcmePrintsOrder,
        emailSubject,
        hasBuyerEmail: !!context.buyerEmail,
        buyerEmail: context.buyerEmail,
        customerEmail: context.customerEmail,
        emailForLookup,
        mailboxId: context.mailboxId
      });

      if (isAcmePrintsOrder && emailForLookup && context.mailboxId) {
        const relatedOrders = await findRelatedOrders(
          emailForLookup,
          context.conversationId,
          context.mailboxId,
          12 // Look back 12 hours
        );
        logger.info('Related orders search complete', { emailForLookup, foundCount: relatedOrders.length });

        // If there are related orders, create notes linking them together
        if (relatedOrders.length > 0) {
          relatedOrdersFound = true;

          // Extract current order number from subject
          const currentOrderMatch = emailSubject.match(/Receipt\s+(\d+)/);
          const currentOrderNum = currentOrderMatch ? currentOrderMatch[1] : 'Unknown';

          // Create note on current order linking to related orders
          const relatedOrderLines: string[] = [];
          relatedOrderLines.push('⚠️ MULTIPLE ORDERS FROM SAME CUSTOMER ⚠️');
          relatedOrderLines.push('');
          relatedOrderLines.push(`Found ${relatedOrders.length} other active order(s) from this customer in the last 12 hours.`);
          relatedOrderLines.push('Consider combining for shipping savings.');
          relatedOrderLines.push('');
          relatedOrderLines.push('Related Orders:');

          for (const order of relatedOrders) {
            // Extract order number from subject like "Acme Prints Receipt 25903| FO01KE..."
            const orderMatch = order.subject.match(/Receipt\s+(\d+)/);
            const orderNum = orderMatch ? orderMatch[1] : 'Unknown';
            relatedOrderLines.push(`- Order #${orderNum}: https://secure.helpscout.net/conversation/${order.conversationId}`);
          }

          await helpScoutClient.createNote(context.conversationId, relatedOrderLines.join('\n'));
          logger.info('Related orders note created on current order', { relatedOrderCount: relatedOrders.length });

          // Also create notes on each related order linking back to the current order
          for (const order of relatedOrders) {
            try {
              const backLinkLines: string[] = [];
              backLinkLines.push('⚠️ MULTIPLE ORDERS FROM SAME CUSTOMER ⚠️');
              backLinkLines.push('');
              backLinkLines.push('A new order from the same customer was just placed.');
              backLinkLines.push('Consider combining for shipping savings.');
              backLinkLines.push('');
              backLinkLines.push(`New Order #${currentOrderNum}: https://secure.helpscout.net/conversation/${context.conversationId}`);

              await helpScoutClient.createNote(order.conversationId, backLinkLines.join('\n'));
              logger.info('Back-link note created on related order', { relatedConversationId: order.conversationId });
            } catch (noteError) {
              logger.warn('Failed to create back-link note on related order', {
                relatedConversationId: order.conversationId,
                error: noteError instanceof Error ? noteError.message : 'Unknown error'
              });
            }
          }
        }
      }

      // All-time customer order history (note created at the end to appear on top)
      if (emailForLookup && context.mailboxId) {
        printsOrderHistory = await findCustomerOrderHistory(
          emailForLookup,
          context.conversationId,
          context.mailboxId
        );
        logger.info('Customer order history loaded', { count: printsOrderHistory.length });
      }
    }

    // Create main research note if there's useful information
    if (hasCustomer || hasOrders) {
      const lines: string[] = [];

      if (isPrintsInbox) {
        // ============================================
        // PRINTS INBOX NOTE FORMAT
        // ============================================

        lines.push('=== PRINTS INBOX RESEARCH ===');
        lines.push('');

        if (hasCustomer) {
          lines.push('Customer: Found in Acme');

          if (hasDesign && hasEnduser) {
            lines.push('Customer Type: Designer and Enduser');
          } else if (hasDesign) {
            lines.push('Customer Type: Designer');
          } else if (hasEnduser) {
            lines.push('Customer Type: Enduser');
          }

          // Add profile links
          if (context.enduserOrg) {
            lines.push(`Enduser Org: https://intranet2.acme.example/support/end-users/${context.enduserOrg.orgId}`);
          }
          if (context.designOrg) {
            lines.push(`Designer Org: https://intranet2.acme.example/support/designers/${context.designOrg.orgId}`);
          }
        }

        if (hasOrders) {
          lines.push('');
          lines.push('=== ORDER LINKS ===');
          lines.push(`Order: https://intranet2.acme.example/support/orders/${orders[0].orderId}`);
        }

        lines.push('');
        lines.push('==============================');

      } else {
        // ============================================
        // SUPPORT INBOX NOTE FORMAT (default)
        // ============================================
        lines.push('Research results:');

        if (hasCustomer) {
          lines.push('Customer Found');

          if (hasDesign && hasEnduser) {
            lines.push('Customer Type: Designer and Enduser');
          } else if (hasDesign) {
            lines.push('Customer Type: Designer');
          } else if (hasEnduser) {
            lines.push('Customer Type: Enduser');
          }

          lines.push('');

          // Add profile links
          if (context.enduserOrg) {
            lines.push(`Org Link: https://intranet2.acme.example/support/end-users/${context.enduserOrg.orgId}`);
          }
          if (context.designOrg) {
            lines.push(`Org Link: https://intranet2.acme.example/support/designers/${context.designOrg.orgId}`);
          }
        }

        if (hasOrders) {
          lines.push(`Recent Order: https://intranet2.acme.example/support/orders/${orders[0].orderId}`);
        }
      }

      const noteText = lines.join('\n');

      await helpScoutClient.createNote(context.conversationId, noteText);

      logger.info('Note created');
      context.noteCreated = true;
    }

    // Create customer order history note (created last so it appears on top in HelpScout)
    if (isPrintsInbox && printsOrderHistory.length > 0) {
      const historyLines: string[] = [];
      const ordersToShow = printsOrderHistory.slice(0, 5);

      historyLines.push('=== CUSTOMER ORDER HISTORY ===');
      historyLines.push('');
      historyLines.push(`Found ${printsOrderHistory.length} previous order${printsOrderHistory.length === 1 ? '' : 's'} from this customer.`);
      historyLines.push('');

      for (const order of ordersToShow) {
        const orderMatch = order.subject.match(/Receipt\s+(\d+)/);
        const orderNum = orderMatch ? orderMatch[1] : null;
        const label = orderNum ? `Order #${orderNum}` : order.subject;
        const date = new Date(order.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        historyLines.push(`- ${label} (${date}): https://secure.helpscout.net/conversation/${order.conversationId}`);
      }

      if (printsOrderHistory.length > 5) {
        historyLines.push(`... and ${printsOrderHistory.length - 5} more`);
      }

      historyLines.push('');
      historyLines.push('==============================');

      await helpScoutClient.createNote(context.conversationId, historyLines.join('\n'));
      logger.info('Customer order history note created', { ordersShown: ordersToShow.length, totalOrders: printsOrderHistory.length });
      context.noteCreated = true;
    }

    if (!context.noteCreated) {
      context.noteCreated = relatedOrdersFound;
    }

    return { success: true, context };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Note creation failed', { error: message });

    context.errors = context.errors || [];
    context.errors.push({
      step: 'note-creator',
      message,
      recoverable: true,
    });
    context.noteCreated = false;

    return { success: true, context }; // Continue despite error
  }
}
