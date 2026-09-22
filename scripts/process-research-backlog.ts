/**
 * Process research requests identified from backlog analysis
 * Run with: npx tsx scripts/process-research-backlog.ts
 */

import { LambdaClient, InvokeCommand, InvocationType } from '@aws-sdk/client-lambda';
import { helpScoutClient } from '../libs/helpscout-client/src';
import { ProcessingContext } from '../libs/shared/src';

const lambdaClient = new LambdaClient({ region: 'us-east-1' });

// Conversation IDs identified from backlog analysis that need research notes
const RESEARCH_CONVERSATION_IDS = [
  3197892275,
  3198605575,
  3198607193,
  3198842348,
  3199503503,
  3199949514,
  3207298903,
  3209338935,
  3209364991,
  3211108146,
];

async function processResearchRequest(conversationId: number): Promise<boolean> {
  console.log(`\nProcessing conversation ${conversationId}...`);

  try {
    // Fetch conversation from HelpScout
    const conversation = await helpScoutClient.getConversation(conversationId);

    // Extract email body from threads
    const threads = conversation._embedded?.threads || [];
    const customerThread = threads.find((t: any) => t.type === 'customer');
    const emailBodyHtml = customerThread?.body || threads[0]?.body || '';
    const emailBody = emailBodyHtml
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Build processing context
    const context: ProcessingContext = {
      conversationId,
      customerId: conversation.primaryCustomer?.id || 0,
      customerEmail: conversation.primaryCustomer?.email || '',
      mailboxId: conversation.mailboxId,
      emailSubject: conversation.subject || '',
      emailBody,
      emailBodyHtml,
      tagsAdded: [],
      errors: [],
    };

    console.log(`  Customer: ${context.customerEmail}`);
    console.log(`  Subject: ${context.emailSubject.slice(0, 50)}...`);

    // Invoke note-creator Lambda
    const lambdaName = 'support-agent-note-creator';
    await lambdaClient.send(
      new InvokeCommand({
        FunctionName: lambdaName,
        InvocationType: InvocationType.Event, // Async
        Payload: JSON.stringify({ context }),
      })
    );

    console.log(`  Research note creation triggered for conversation ${conversationId}`);
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`  ERROR: Failed to process conversation ${conversationId}: ${message}`);
    return false;
  }
}

async function main() {
  console.log('='.repeat(60));
  console.log('RESEARCH BACKLOG PROCESSOR');
  console.log('='.repeat(60));
  console.log(`\nProcessing ${RESEARCH_CONVERSATION_IDS.length} research requests...\n`);

  let successCount = 0;
  let failureCount = 0;

  for (const conversationId of RESEARCH_CONVERSATION_IDS) {
    const success = await processResearchRequest(conversationId);
    if (success) {
      successCount++;
    } else {
      failureCount++;
    }

    // Rate limiting - wait between requests
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));
  console.log(`Successfully triggered: ${successCount}`);
  console.log(`Failed: ${failureCount}`);
  console.log('\nNote: Lambda invocations are async - check CloudWatch logs for results.');
}

main().catch(console.error);
