import axios, { AxiosInstance } from 'axios';
import {
  getHelpScoutCredentials,
  getHelpScoutToken,
  HelpScoutCredentials,
  logger
} from '@support-agent-aws/shared';
import {
  SecretsManagerClient,
  PutSecretValueCommand
} from '@aws-sdk/client-secrets-manager';

const TOKEN_REFRESH_BUFFER_SECONDS = 60;

export class HelpScoutClient {
  private client: AxiosInstance;
  private accessToken: string | null = null;
  private tokenExpiresAt: Date | null = null;
  private credentials: HelpScoutCredentials | null = null;

  constructor() {
    this.client = axios.create({
      baseURL: 'https://api.helpscout.net/v2',
      headers: {
        'Content-Type': 'application/json',
      },
    });
  }

  private async ensureAuthenticated(): Promise<void> {
    const now = new Date();

    // Check if current token is still valid
    if (this.accessToken && this.tokenExpiresAt) {
      const bufferTime = new Date(this.tokenExpiresAt.getTime() - TOKEN_REFRESH_BUFFER_SECONDS * 1000);
      if (now < bufferTime) {
        return;
      }
    }

    // Try to load cached token from Secrets Manager
    const cachedToken = await getHelpScoutToken();
    if (cachedToken && cachedToken.access_token) {
      const expiresAt = new Date(cachedToken.expires_at);
      const bufferTime = new Date(expiresAt.getTime() - TOKEN_REFRESH_BUFFER_SECONDS * 1000);
      if (now < bufferTime) {
        this.accessToken = cachedToken.access_token;
        this.tokenExpiresAt = expiresAt;
        logger.debug('Using cached Help Scout token');
        return;
      }
    }

    // Fetch new token
    await this.authenticate();
  }

  private async authenticate(): Promise<void> {
    if (!this.credentials) {
      this.credentials = await getHelpScoutCredentials();
    }

    logger.info('Authenticating with Help Scout');

    const response = await axios.post('https://api.helpscout.net/v2/oauth2/token', {
      grant_type: 'client_credentials',
      client_id: this.credentials.app_id,
      client_secret: this.credentials.secret,
    });

    this.accessToken = response.data.access_token;
    this.tokenExpiresAt = new Date(Date.now() + response.data.expires_in * 1000);

    logger.info('Help Scout authentication successful', {
      expiresAt: this.tokenExpiresAt.toISOString()
    });

    // Cache token in Secrets Manager
    try {
      const secretsClient = new SecretsManagerClient({});
      await secretsClient.send(new PutSecretValueCommand({
        SecretId: 'support-agent/helpscout-oauth-token',
        SecretString: JSON.stringify({
          access_token: this.accessToken,
          expires_at: this.tokenExpiresAt.toISOString(),
        }),
      }));
      logger.debug('Cached Help Scout token in Secrets Manager');
    } catch (error) {
      // Log but don't fail if we can't cache the token
      logger.warn('Failed to cache Help Scout token', {
        error: error instanceof Error ? error.message : 'Unknown error'
      });
    }
  }

  private async request<T>(method: string, url: string, data?: unknown): Promise<T> {
    await this.ensureAuthenticated();

    const response = await this.client.request<T>({
      method,
      url,
      data,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
      },
    });

    return response.data;
  }

  /**
   * Get a conversation by ID
   */
  async getConversation(conversationId: number): Promise<any> {
    logger.debug('Getting conversation', { conversationId });
    return this.request('GET', `/conversations/${conversationId}?embed=threads`);
  }

  /**
   * Get a customer by ID
   */
  async getCustomer(customerId: number): Promise<any> {
    logger.debug('Getting customer', { customerId });
    return this.request('GET', `/customers/${customerId}`);
  }

  /**
   * Update customer properties using JSON Patch
   */
  async updateCustomerProperties(
    customerId: number,
    properties: Array<{ op: string; path: string; value: string }>
  ): Promise<void> {
    logger.debug('Updating customer properties', { customerId, propertyCount: properties.length });
    await this.request('PATCH', `/customers/${customerId}/properties`, properties);
  }

  /**
   * Update conversation tags (replaces all tags)
   */
  async updateConversationTags(conversationId: number, tags: string[]): Promise<void> {
    logger.debug('Updating conversation tags', { conversationId, tags });
    await this.request('PUT', `/conversations/${conversationId}/tags`, { tags });
  }

  /**
   * Create a note on a conversation
   */
  async createNote(conversationId: number, text: string): Promise<void> {
    logger.debug('Creating note', { conversationId, textLength: text.length });
    await this.request('POST', `/conversations/${conversationId}/notes`, { text });
  }

  /**
   * Search conversations by query
   * Query format: https://developer.helpscout.com/mailbox-api/endpoints/conversations/list/#query
   */
  async searchConversations(query: string): Promise<any> {
    logger.debug('Searching conversations', { query });
    const encodedQuery = encodeURIComponent(query);
    return this.request('GET', `/conversations?query=${encodedQuery}`);
  }

  /**
   * List conversations for a customer in a specific mailbox
   */
  async listConversationsByCustomerEmail(
    email: string,
    mailboxId: number,
    status: 'active' | 'closed' | 'all' = 'active'
  ): Promise<any> {
    logger.debug('Listing conversations by customer email', { email, mailboxId, status });
    // Build query: email AND mailbox AND status (HelpScout requires parentheses wrapping)
    let query = `(email:"${email}" AND mailboxid:${mailboxId}`;
    if (status !== 'all') {
      query += ` AND status:${status}`;
    }
    query += ')';
    const encodedQuery = encodeURIComponent(query);
    return this.request('GET', `/conversations?query=${encodedQuery}`);
  }
}

// Export a singleton instance for convenience
export const helpScoutClient = new HelpScoutClient();
