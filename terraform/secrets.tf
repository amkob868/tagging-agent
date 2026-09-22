# Help Scout OAuth credentials
resource "aws_secretsmanager_secret" "helpscout_credentials" {
  name        = "support-agent/helpscout-credentials"
  description = "Help Scout OAuth App ID and Secret"
}

# Acme API credentials
resource "aws_secretsmanager_secret" "acme_api_key" {
  name        = "support-agent/acme-api-key"
  description = "Acme GraphQL API endpoint and key"
}

# Help Scout OAuth token (managed by Lambda)
resource "aws_secretsmanager_secret" "helpscout_oauth_token" {
  name        = "support-agent/helpscout-oauth-token"
  description = "Cached Help Scout OAuth token"
}

# Claude API credentials
resource "aws_secretsmanager_secret" "claude_api_key" {
  name        = "support-agent/claude-api-key"
  description = "Claude API key for AI classification"
}

# Jev (TypeSafe AI) API credentials
resource "aws_secretsmanager_secret" "jev_api_key" {
  name        = "support-agent/jev-api-key"
  description = "Jev (TypeSafe AI) API key for conversation tag classification"
}

# Initial empty values (user will update via AWS Console or CLI)
resource "aws_secretsmanager_secret_version" "helpscout_credentials_initial" {
  secret_id = aws_secretsmanager_secret.helpscout_credentials.id
  secret_string = jsonencode({
    app_id = "PLACEHOLDER_APP_ID"
    secret = "PLACEHOLDER_SECRET"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret_version" "acme_api_key_initial" {
  secret_id = aws_secretsmanager_secret.acme_api_key.id
  secret_string = jsonencode({
    api_key  = "PLACEHOLDER_API_KEY"
    endpoint = "https://placeholder.appsync-api.us-west-2.amazonaws.com/graphql"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret_version" "helpscout_oauth_token_initial" {
  secret_id = aws_secretsmanager_secret.helpscout_oauth_token.id
  secret_string = jsonencode({
    access_token = ""
    expires_at   = "1970-01-01T00:00:00Z"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret_version" "claude_api_key_initial" {
  secret_id = aws_secretsmanager_secret.claude_api_key.id
  secret_string = jsonencode({
    api_key = "PLACEHOLDER_API_KEY"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret_version" "jev_api_key_initial" {
  secret_id = aws_secretsmanager_secret.jev_api_key.id
  secret_string = jsonencode({
    api_key = "PLACEHOLDER_API_KEY"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

# Slack credentials for orchestrator
resource "aws_secretsmanager_secret" "slack_credentials" {
  name        = "support-agent/slack-credentials"
  description = "Slack app credentials (bot token, user token, signing secret)"
}

resource "aws_secretsmanager_secret_version" "slack_credentials_initial" {
  secret_id = aws_secretsmanager_secret.slack_credentials.id
  secret_string = jsonencode({
    bot_token      = "xoxb-PLACEHOLDER"
    user_token     = "xoxp-PLACEHOLDER"
    signing_secret = "PLACEHOLDER"
    channel_id     = "PLACEHOLDER"
  })

  lifecycle {
    ignore_changes = [secret_string]
  }
}
