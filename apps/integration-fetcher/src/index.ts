import {
  StepFunctionEvent,
  StepFunctionResult,
  logger,
  setRequestId
} from '@support-agent-aws/shared';
import { acmeClient } from '@support-agent-aws/acme-client';

export async function handler(event: StepFunctionEvent): Promise<StepFunctionResult> {
  const { context } = event;
  setRequestId(`integrations-${context.conversationId}`);

  logger.info('Starting integration fetch');

  try {
    // Only fetch integrations if there's a DESIGN org
    if (!context.designOrg) {
      logger.info('No DESIGN org, skipping integration fetch');
      context.integrations = [];
      return { success: true, context };
    }

    const integrations = await acmeClient.listIntegrationsByOrg(context.designOrg.orgId);

    logger.info('Integrations found', { count: integrations.length });

    context.integrations = integrations;

    return { success: true, context };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Integration fetch failed', { error: message });

    context.errors = context.errors || [];
    context.errors.push({
      step: 'integration-fetcher',
      message,
      recoverable: true,
    });
    context.integrations = [];

    return { success: true, context }; // Continue despite error
  }
}
