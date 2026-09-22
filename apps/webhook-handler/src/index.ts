import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import {
  HelpScoutWebhookPayload,
  ProcessingContext,
  logger,
  setRequestId
} from '@support-agent-aws/shared';

const sfnClient = new SFNClient({});
const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN!;

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = event.requestContext.requestId;
  setRequestId(requestId);

  logger.info('Webhook received', { requestId });

  try {
    // Parse and validate payload
    if (!event.body) {
      logger.error('Missing request body');
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing body' }) };
    }

    const payload: HelpScoutWebhookPayload = JSON.parse(event.body);

    // Detect event type from X-HelpScout-Event header
    const helpScoutEvent = event.headers?.['X-HelpScout-Event'] || event.headers?.['x-helpscout-event'] || '';
    const isMovedConversation = helpScoutEvent === 'convo.moved';

    logger.info('Webhook event type', { helpScoutEvent, isMovedConversation });

    // Help Scout V2 webhooks send conversation data directly
    // The event type (convo.created, convo.moved) is determined by webhook config
    // payload.type is the conversation type (email, chat, phone), not the event type

    // Validate required fields - check both V1 (record.primaryCustomer) and V2 (primaryCustomer) formats
    const customer = payload.primaryCustomer || payload.record?.primaryCustomer;
    const conversationId = payload.id || payload.record?.id;

    if (!customer?.email || !conversationId) {
      logger.error('Missing required fields in payload', { payload: JSON.stringify(payload).slice(0, 500) });
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    // Extract mailbox ID
    const mailboxId = payload.mailboxId || payload.record?.mailboxId;

    // Extract email subject and body
    const emailSubject = payload.subject || payload.record?.subject || '';
    const threads = payload._embedded?.threads || [];
    const firstThread = threads[0];

    // Skip processing if this conversation was initiated by staff (not a customer email)
    // Only applies to new conversations - moved conversations should always be processed
    // firstThread.createdBy.type will be "user" for staff-initiated emails, "customer" for inbound
    if (!isMovedConversation) {
      const createdByType = firstThread?.createdBy?.type;
      if (createdByType === 'user') {
        logger.info('Skipping staff-initiated conversation', { conversationId, createdByType });
        return {
          statusCode: 200,
          body: JSON.stringify({
            success: true,
            skipped: true,
            reason: 'staff-initiated conversation'
          }),
        };
      }
    }

    // Log spam status but continue processing — HelpScout's spam filter
    // sometimes misclassifies legitimate emails from uncommon domains
    const status = payload.status || payload.record?.status;
    if (status === 'spam') {
      logger.info('Conversation marked as spam by HelpScout, processing anyway', { conversationId, status });
    }

    const emailBodyHtml = firstThread?.body || payload.preview || '';
    // Strip HTML tags to get plain text
    const emailBody = emailBodyHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

    // Extract existing tags
    const existingTags = (payload.tags || []).map(t => typeof t === 'string' ? t : t.name);

    // Create processing context
    const context: ProcessingContext = {
      conversationId: conversationId,
      customerId: customer.id,
      customerEmail: customer.email,
      mailboxId,
      emailSubject,
      emailBody,
      emailBodyHtml,
      isMovedConversation,
      tagsAdded: [],
      errors: [],
    };

    logger.info('Starting Step Function execution', {
      conversationId: context.conversationId,
      customerEmail: context.customerEmail
    });

    // Start Step Function execution
    await sfnClient.send(new StartExecutionCommand({
      stateMachineArn: STATE_MACHINE_ARN,
      name: `webhook-${conversationId}-${Date.now()}`,
      input: JSON.stringify({ context }),
    }));

    logger.info('Step Function started successfully');

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        conversationId: context.conversationId
      }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Webhook processing failed', { error: message });

    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
}
