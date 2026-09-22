import {
  StepFunctionEvent,
  StepFunctionResult,
  logger,
  setRequestId,
  Organization,
  Integration
} from '@support-agent-aws/shared';
import { helpScoutClient } from '@support-agent-aws/helpscout-client';

function determineAccountType(orgs: Organization[]): string | null {
  const hasDesign = orgs.some(o => o.type === 'DESIGN');
  const hasEnduser = orgs.some(o => o.type === 'ENDUSER');

  if (hasDesign && hasEnduser) return 'Designer & Customer';
  if (hasDesign) return 'Designer';
  if (hasEnduser) return 'Customer';
  return null;
}

function getAffiliateValue(orgs: Organization[]): string | null {
  const designOrg = orgs.find(o => o.type === 'DESIGN');
  if (designOrg?.affiliateAccountId) return designOrg.affiliateAccountId;
  if (designOrg?.affiliateStatus) return designOrg.affiliateStatus;
  return null;
}

function getPrimaryOrgId(orgs: Organization[]): string | null {
  const designOrg = orgs.find(o => o.type === 'DESIGN');
  if (designOrg) return designOrg.orgId;
  const enduserOrg = orgs.find(o => o.type === 'ENDUSER');
  return enduserOrg?.orgId || null;
}

function getShopUrl(integrations: Integration[], source: string): string | null {
  const integration = integrations.find(i => i.source === source && i.status === 'ACTIVE');
  if (!integration) return null;

  try {
    const attrs = JSON.parse(integration.attributes);
    return attrs.shop_url || attrs.site_url || attrs.myshopify_domain || null;
  } catch {
    return null;
  }
}

export async function handler(event: StepFunctionEvent): Promise<StepFunctionResult> {
  const { context } = event;
  setRequestId(`properties-${context.conversationId}`);

  logger.info('Starting property update');

  try {
    const orgs = context.organizations || [];
    const integrations = context.integrations || [];

    if (orgs.length === 0) {
      logger.info('No organizations found, skipping property update');
      context.propertiesUpdated = [];
      return { success: true, context };
    }

    // Get existing customer properties
    const customer = await helpScoutClient.getCustomer(context.customerId);
    const existingProps: Record<string, string> = {};

    // Convert properties array to object for easier lookup
    if (customer.properties && Array.isArray(customer.properties)) {
      for (const prop of customer.properties) {
        if (prop.name && prop.value) {
          existingProps[prop.name] = prop.value;
        }
      }
    }

    // Build property updates
    const updates: Array<{ op: string; path: string; value: string }> = [];
    const updated: string[] = [];

    // Account Type
    const accountType = determineAccountType(orgs);
    if (accountType && !existingProps['account-type']) {
      updates.push({ op: 'replace', path: '/account-type', value: accountType });
      updated.push('account-type');
    }

    // Affiliate (always update if changed)
    const affiliate = getAffiliateValue(orgs);
    if (affiliate && existingProps['affiliate'] !== affiliate) {
      updates.push({ op: 'replace', path: '/affiliate', value: affiliate });
      updated.push('affiliate');
    }

    // Org ID
    const orgId = getPrimaryOrgId(orgs);
    if (orgId && !existingProps['org-id']) {
      updates.push({ op: 'replace', path: '/org-id', value: orgId });
      updated.push('org-id');
    }

    // Ordway ID
    const designOrg = orgs.find(o => o.type === 'DESIGN');
    if (designOrg?.planId && !existingProps['ordway-id']) {
      updates.push({ op: 'replace', path: '/ordway-id', value: designOrg.planId });
      updated.push('ordway-id');
    }

    // Contact Email
    if (designOrg?.contactEmail &&
        designOrg.contactEmail !== context.customerEmail &&
        !existingProps['org-contact-email']) {
      updates.push({ op: 'replace', path: '/org-contact-email', value: designOrg.contactEmail });
      updated.push('org-contact-email');
    }

    // Shop URLs
    const etsyUrl = getShopUrl(integrations, 'ETSY');
    if (etsyUrl && !existingProps['etsy-shop']) {
      updates.push({ op: 'replace', path: '/etsy-shop', value: etsyUrl });
      updated.push('etsy-shop');
    }

    const shopifyUrl = getShopUrl(integrations, 'SHOPIFY');
    if (shopifyUrl && !existingProps['shopify-shop']) {
      updates.push({ op: 'replace', path: '/shopify-shop', value: shopifyUrl });
      updated.push('shopify-shop');
    }

    const wooUrl = getShopUrl(integrations, 'WOOCOMMERCE');
    if (wooUrl && !existingProps['woocommerce-shop']) {
      updates.push({ op: 'replace', path: '/woocommerce-shop', value: wooUrl });
      updated.push('woocommerce-shop');
    }

    // Apply updates
    if (updates.length > 0) {
      await helpScoutClient.updateCustomerProperties(context.customerId, updates);
      logger.info('Properties updated', { properties: updated });
    } else {
      logger.info('No properties to update');
    }

    context.propertiesUpdated = updated;

    return { success: true, context };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Property update failed', { error: message });

    context.errors = context.errors || [];
    context.errors.push({
      step: 'property-updater',
      message,
      recoverable: false,
    });

    return { success: false, context, error: message };
  }
}
