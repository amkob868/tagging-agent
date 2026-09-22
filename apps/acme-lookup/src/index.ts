import {
  StepFunctionEvent,
  StepFunctionResult,
  logger,
  setRequestId
} from '@support-agent-aws/shared';
import { acmeClient } from '@support-agent-aws/acme-client';

export async function handler(event: StepFunctionEvent): Promise<StepFunctionResult> {
  const { context } = event;
  setRequestId(`lookup-${context.conversationId}`);

  logger.info('Starting Acme lookup', { email: context.customerEmail });

  try {
    // Search for organizations by email
    const organizations = await acmeClient.searchOrganizationsByEmail(context.customerEmail);

    logger.info('Organizations found', { count: organizations.length });

    // Categorize organizations - prioritize ACTIVE accounts over CANCELLED/other statuses
    const designOrgs = organizations.filter(org => org.type === 'DESIGN');
    const enduserOrgs = organizations.filter(org => org.type === 'ENDUSER');

    // Pick active org first, then fall back to any org of that type
    const designOrg = designOrgs.find(org => org.status === 'ACTIVE') || designOrgs[0];
    const enduserOrg = enduserOrgs.find(org => org.status === 'ACTIVE') || enduserOrgs[0];

    context.organizations = organizations;
    context.designOrg = designOrg;
    context.enduserOrg = enduserOrg;

    logger.info('Lookup complete', {
      hasDesign: !!designOrg,
      hasEnduser: !!enduserOrg,
      designOrgStatus: designOrg?.status,
      enduserOrgStatus: enduserOrg?.status,
    });

    return { success: true, context };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Acme lookup failed', { error: message });

    context.errors = context.errors || [];
    context.errors.push({
      step: 'acme-lookup',
      message,
      recoverable: true,
    });

    return { success: false, context, error: message };
  }
}
