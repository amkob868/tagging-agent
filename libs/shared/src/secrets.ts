import {
  SecretsManagerClient,
  GetSecretValueCommand
} from '@aws-sdk/client-secrets-manager';

const client = new SecretsManagerClient({});
const secretCache: Map<string, { value: unknown; expiresAt: number }> = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface HelpScoutCredentials {
  app_id: string;
  secret: string;
}

export interface AcmeCredentials {
  api_key: string;
  endpoint: string;
}

export interface HelpScoutToken {
  access_token: string;
  expires_at: string;
}

export interface ClaudeCredentials {
  api_key: string;
}

export interface JevCredentials {
  api_key: string;
}

export interface SlackCredentials {
  bot_token: string;
  user_token: string;
  signing_secret: string;
  channel_id: string;
}

/**
 * Get a secret from AWS Secrets Manager with caching
 */
export async function getSecret<T>(secretName: string): Promise<T> {
  const now = Date.now();
  const cached = secretCache.get(secretName);

  if (cached && cached.expiresAt > now) {
    return cached.value as T;
  }

  const command = new GetSecretValueCommand({ SecretId: secretName });
  const response = await client.send(command);

  if (!response.SecretString) {
    throw new Error(`Secret ${secretName} has no string value`);
  }

  const value = JSON.parse(response.SecretString) as T;
  secretCache.set(secretName, { value, expiresAt: now + CACHE_TTL_MS });

  return value;
}

/**
 * Get Help Scout OAuth credentials
 */
export async function getHelpScoutCredentials(): Promise<HelpScoutCredentials> {
  return getSecret<HelpScoutCredentials>('support-agent/helpscout-credentials');
}

/**
 * Get Acme API credentials
 */
export async function getAcmeCredentials(): Promise<AcmeCredentials> {
  return getSecret<AcmeCredentials>('support-agent/acme-api-key');
}

/**
 * Get Claude API credentials
 */
export async function getClaudeCredentials(): Promise<ClaudeCredentials> {
  return getSecret<ClaudeCredentials>('support-agent/claude-api-key');
}

/**
 * Get Jev (TypeSafe AI) API credentials
 */
export async function getJevCredentials(): Promise<JevCredentials> {
  return getSecret<JevCredentials>('support-agent/jev-api-key');
}

/**
 * Get Slack app credentials
 */
export async function getSlackCredentials(): Promise<SlackCredentials> {
  return getSecret<SlackCredentials>('support-agent/slack-credentials');
}

/**
 * Get cached Help Scout OAuth token
 */
export async function getHelpScoutToken(): Promise<HelpScoutToken | null> {
  try {
    return await getSecret<HelpScoutToken>('support-agent/helpscout-oauth-token');
  } catch (error) {
    // Token may not exist yet
    return null;
  }
}

/**
 * Clear the secret cache (useful for testing)
 */
export function clearSecretCache(): void {
  secretCache.clear();
}
