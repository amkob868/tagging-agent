# Support Agent AWS

Automated customer support ticket enrichment system built on AWS serverless infrastructure. When a new Help Scout conversation arrives, the system automatically looks up the customer in Acme, enriches the ticket with organization data, marketplace integrations, tags, and research notes.

## Architecture

```
Help Scout Webhook → API Gateway → webhook-handler → Step Functions
                                                        ├→ acme-lookup
                                                        ├→ integration-fetcher
                                                        ├→ property-updater
                                                        ├→ conversation-tagger
                                                        └→ note-creator

Slack (#ai-training) → API Gateway → slack-orchestrator → DynamoDB
```

## Lambda Functions

### Step Functions Pipeline

| Function | Purpose |
|----------|---------|
| **webhook-handler** | Receives Help Scout webhooks, validates payload, filters spam/staff emails, starts Step Functions |
| **acme-lookup** | Searches Acme for customer organizations (DESIGN/ENDUSER) by email |
| **integration-fetcher** | Fetches Etsy, Shopify, WooCommerce integrations for designer orgs |
| **property-updater** | Updates Help Scout customer properties (account type, org ID, shop URLs, affiliate status) |
| **conversation-tagger** | Tags conversations using keyword rules, dynamic DynamoDB rules, and Claude AI classification |
| **note-creator** | Creates research notes with customer links, order history, translations, and dynamic capabilities |

### Standalone

| Function | Purpose |
|----------|---------|
| **slack-orchestrator** | Listens to `#ai-training` Slack channel for messages starting with `#`, uses Claude to extract tagging rules and research capabilities, stores them in DynamoDB |

## Shared Libraries

- **@support-agent-aws/shared** - Types (`ProcessingContext`, `Organization`, `Integration`), secrets management (cached, 5-min TTL), structured logger
- **@support-agent-aws/helpscout-client** - Help Scout API (OAuth 2.0, conversations, tags, notes, customer properties, search)
- **@support-agent-aws/acme-client** - Acme GraphQL API (organization search, integrations, orders)

## Key Features

- **Intelligent tagging** - Keyword rules + Claude AI classification + dynamic rules from Slack, with separate logic for Support (mailbox 100001) and Prints (mailbox 100002) inboxes
- **Language detection** - Detects non-English emails (requires 5+ foreign words) and creates translation notes
- **Related order linking** - Finds orders from the same buyer within 12 hours and links them (Prints inbox)
- **Dynamic rules via Slack** - Add new tagging keywords or research capabilities by posting `#` messages in `#ai-training`
- **Graceful degradation** - Non-critical failures don't stop the pipeline; errors are logged and accumulated

## Infrastructure (Terraform)

- **Compute:** 7 Lambda functions (Node.js 18.x, ARM64)
- **Orchestration:** Step Functions state machine
- **API:** API Gateway REST (`/webhook`, `/slack-webhook`, `/health`)
- **Storage:** 2 DynamoDB tables (`support-agent-tagging-rules`, `support-agent-research-capabilities`)
- **Secrets:** 5 Secrets Manager entries (Help Scout, Acme, Claude, Slack, OAuth token cache)
- **Monitoring:** CloudWatch Logs, X-Ray tracing

## Project Structure

```
apps/
  webhook-handler/        # Entry point - validates webhooks, starts pipeline
  acme-lookup/           # Customer org lookup
  integration-fetcher/    # Marketplace integration data
  property-updater/       # Help Scout customer property updates
  conversation-tagger/    # AI + keyword tagging
  note-creator/           # Research notes, translations, order linking
  slack-orchestrator/     # Slack bot for dynamic rule management
libs/
  shared/                 # Types, secrets, logger
  helpscout-client/       # Help Scout API client
  acme-client/           # Acme GraphQL client
terraform/                # All AWS infrastructure
scripts/                  # One-time utility scripts
AIDEV/                    # Architecture documentation
```

## Development

### Prerequisites

- Node.js 18+
- Terraform 1.5+
- AWS CLI configured with `support-agent` profile

### Build

```bash
npm install
npm run build          # Build all apps and libs
npx nx build <app>     # Build a single app
```

### Deploy

**Full deploy (Terraform):**
```bash
cd terraform
AWS_PROFILE=support-agent terraform apply -var 'aws_region=us-east-1'
```

**Single Lambda update:**
```bash
npx nx build <app-name>
cd dist/apps/<app-name> && zip -r ../../../<app-name>.zip .
AWS_PROFILE=support-agent aws lambda update-function-code \
  --function-name support-agent-<app-name> \
  --zip-file fileb://$(pwd)/../../../<app-name>.zip \
  --region us-east-1
```

### Logs

```bash
# View logs for any function
AWS_PROFILE=support-agent aws logs tail /aws/lambda/support-agent-<function-name> --region us-east-1 --follow
```

## Configuration

All secrets are stored in AWS Secrets Manager:

| Secret | Contents |
|--------|----------|
| `support-agent/helpscout-credentials` | `app_id`, `secret` |
| `support-agent/acme-api-key` | `api_key`, `endpoint` |
| `support-agent/claude-api-key` | `api_key` (fallback classifier for the tagger; still primary for other Lambdas) |
| `support-agent/jev-api-key` | `api_key` (Jev / TypeSafe AI, primary tag classifier; a tag is applied at >= 70% probability, override with `JEV_TAG_THRESHOLD`) |
| `support-agent/slack-credentials` | `bot_token`, `user_token`, `signing_secret`, `channel_id` |
| `support-agent/helpscout-oauth-token` | Auto-managed token cache |

## Tech Stack

TypeScript, Node.js 18, AWS Lambda (ARM64), Step Functions, API Gateway, DynamoDB, Secrets Manager, CloudWatch, X-Ray, Terraform, NX, esbuild, Claude API, Help Scout API, Acme GraphQL, Slack Events API
