import axios from 'axios';
import {
  getAcmeCredentials,
  Organization,
  Integration,
  logger
} from '@support-agent-aws/shared';

export class AcmeClient {
  private endpoint: string | null = null;
  private apiKey: string | null = null;

  private async ensureCredentials(): Promise<void> {
    if (this.endpoint && this.apiKey) {
      return;
    }

    const credentials = await getAcmeCredentials();
    this.endpoint = credentials.endpoint;
    this.apiKey = credentials.api_key;
    logger.debug('Acme credentials loaded');
  }

  private async query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    await this.ensureCredentials();

    logger.debug('Executing Acme GraphQL query', {
      operationName: query.match(/query\s+(\w+)/)?.[1] || 'unknown'
    });

    const response = await axios.post(
      this.endpoint!,
      { query, variables },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey!,
        },
      }
    );

    if (response.data.errors) {
      const errorMessage = JSON.stringify(response.data.errors);
      logger.error('GraphQL error', { errors: response.data.errors });
      throw new Error(`GraphQL error: ${errorMessage}`);
    }

    return response.data.data;
  }

  /**
   * Search for organizations by email address
   */
  async searchOrganizationsByEmail(email: string): Promise<Organization[]> {
    logger.info('Searching organizations by email', { email });

    const query = `
      query SupportSearchOrganizations($searchTerms: OrganizationSearchInput!) {
        supportSearchOrganizations(searchTerms: $searchTerms) {
          items {
            orgId
            type
            status
            name
            contactEmail
            planId
            affiliateAccountId
            affiliateStatus
          }
          matchCount
        }
      }
    `;

    const result = await this.query<{ supportSearchOrganizations: { items: Organization[], matchCount: number } }>(
      query,
      {
        searchTerms: {
          searchString: email,
        },
      }
    );

    const items = result.supportSearchOrganizations.items;
    logger.info('Organizations found', { count: items.length });

    return items;
  }

  /**
   * List integrations for an organization
   */
  async listIntegrationsByOrg(orgId: string): Promise<Integration[]> {
    logger.info('Listing integrations for org', { orgId });

    const query = `
      query ListIntegrationsByOrg($orgId: ID!, $limit: Int) {
        listIntegrationsByOrg(orgId: $orgId, limit: $limit) {
          items {
            integrationId
            orgId
            source
            status
            attributes
          }
        }
      }
    `;

    const result = await this.query<{ listIntegrationsByOrg: { items: Integration[] } }>(
      query,
      { orgId, limit: 50 }
    );

    const items = result.listIntegrationsByOrg.items;
    logger.info('Integrations found', { count: items.length });

    return items;
  }

  /**
   * List orders by buyer organization ID
   */
  async listOrdersByBuyerOrgId(buyerOrgId: string, limit: number = 10): Promise<any[]> {
    logger.debug('Listing orders by buyer org', { buyerOrgId, limit });

    const query = `
      query ListOrdersByBuyerOrgId($buyerOrgId: ID!, $sortDirection: ModelSortDirection, $limit: Int) {
        listOrdersByBuyerOrgId(buyerOrgId: $buyerOrgId, sortDirection: $sortDirection, limit: $limit) {
          items {
            orderId
            status
            createdAt
          }
        }
      }
    `;

    const result = await this.query<{ listOrdersByBuyerOrgId: { items: any[] } }>(
      query,
      { buyerOrgId, sortDirection: 'DESC', limit }
    );

    return result.listOrdersByBuyerOrgId.items;
  }

  /**
   * List orders by email address
   */
  async listOrdersByEmail(email: string, limit: number = 10): Promise<any[]> {
    logger.debug('Listing orders by email', { email, limit });

    const query = `
      query ListOrdersByEmail($emailAddress: String!, $sortDirection: ModelSortDirection, $limit: Int) {
        listOrdersByEmail(emailAddress: $emailAddress, sortDirection: $sortDirection, limit: $limit) {
          items {
            orderId
            status
            createdAt
          }
        }
      }
    `;

    const result = await this.query<{ listOrdersByEmail: { items: any[] } }>(
      query,
      { emailAddress: email, sortDirection: 'DESC', limit }
    );

    return result.listOrdersByEmail.items;
  }
}

// Export a singleton instance for convenience
export const acmeClient = new AcmeClient();
