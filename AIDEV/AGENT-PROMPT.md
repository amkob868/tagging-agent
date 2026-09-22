# Claude Code Agent Implementation Prompt

Copy the prompt below and provide it to a fresh Claude Code agent running in the `support-agent-aws` directory.

---

## PROMPT START

You are implementing an AWS migration for a support ticket automation system. This project migrates an n8n workflow to AWS Lambda, Step Functions, and API Gateway.

## Context

**Current Directory:** You are in `~/Code/support-agent-aws/`

**Documentation Location:** All requirements and implementation details are in `./AIDEV/`

**Reference Implementation:** The original n8n project is at `../support-agent/` - use this for code reference but DO NOT modify it.

**AWS Profile:** Already configured as `support-agent` (us-west-2 region)

## Your Task

Implement the AWS migration in phases. After each phase, stop and report what was completed so the user can verify before proceeding.

---

## PHASE 1: Project Setup & NX Workspace

**Goal:** Initialize the NX monorepo and create project structure.

**Read First:**
- `./AIDEV/04-IMPLEMENTATION-PLAN.md` - Sections: Phase 1, Phase 2

**Actions:**
1. Initialize NX workspace with TypeScript preset
2. Install dependencies: `@aws-sdk/client-secrets-manager`, `@aws-sdk/client-sfn`, `axios`, `@types/aws-lambda`, `esbuild`, `@nx/esbuild`
3. Create directory structure:
   ```
   libs/shared/src/
   libs/helpscout-client/src/
   libs/acme-client/src/
   apps/webhook-handler/src/
   apps/acme-lookup/src/
   apps/integration-fetcher/src/
   apps/property-updater/src/
   apps/conversation-tagger/src/
   apps/note-creator/src/
   terraform/
   ```

**Validation:**
- `nx --version` returns version
- `ls libs/` shows shared, helpscout-client, acme-client
- `ls apps/` shows all 6 Lambda function directories

**STOP after Phase 1 and report to user.**

---

## PHASE 2: Shared Libraries

**Goal:** Create shared types, secrets utility, and logger.

**Read First:**
- `./AIDEV/04-IMPLEMENTATION-PLAN.md` - Section: Phase 2
- `./AIDEV/01-FLOW-DOCUMENTATION.md` - For understanding data structures

**Reference Code:**
- `../support-agent/src/types/helpscout.types.ts`
- `../support-agent/src/types/acme_api/`

**Actions:**
1. Create `libs/shared/src/types.ts` with:
   - `HelpScoutWebhookPayload` interface
   - `ProcessingContext` interface
   - `Organization` interface
   - `Integration` interface
   - `StepFunctionEvent` and `StepFunctionResult` interfaces

2. Create `libs/shared/src/secrets.ts` with:
   - Functions to get secrets from AWS Secrets Manager
   - Caching logic for secrets
   - Typed getters for HelpScout and Acme credentials

3. Create `libs/shared/src/logger.ts` with:
   - Structured JSON logging
   - Request ID tracking
   - Log levels (DEBUG, INFO, WARN, ERROR)

4. Create `libs/shared/src/index.ts` to export all

5. Create `libs/shared/project.json` for NX

**Validation:**
- `nx build shared` succeeds
- `ls dist/libs/shared/` shows compiled files

**STOP after Phase 2 and report to user.**

---

## PHASE 3: API Client Libraries

**Goal:** Create Help Scout and Acme API clients.

**Read First:**
- `./AIDEV/04-IMPLEMENTATION-PLAN.md` - Sections: Phase 3, Phase 4
- `./AIDEV/02-REQUIREMENTS.md` - API interface requirements

**Reference Code:**
- `../support-agent/src/services/helpscout.service.ts`
- `../support-agent/src/services/acme.service.ts`

**Actions:**
1. Create `libs/helpscout-client/src/index.ts` with:
   - OAuth 2.0 authentication with token caching
   - Token refresh logic (store in Secrets Manager)
   - Methods: getConversation, getCustomer, updateCustomerProperties, updateConversationTags, createNote

2. Create `libs/acme-client/src/index.ts` with:
   - GraphQL client using axios
   - API key authentication from Secrets Manager
   - Methods: searchOrganizationsByEmail, listIntegrationsByOrg, listOrdersByBuyerOrgId, listOrdersByEmail

3. Create project.json files for both libraries

**Validation:**
- `nx build helpscout-client` succeeds
- `nx build acme-client` succeeds

**STOP after Phase 3 and report to user.**

---

## PHASE 4: Lambda Functions

**Goal:** Create all 6 Lambda functions.

**Read First:**
- `./AIDEV/04-IMPLEMENTATION-PLAN.md` - Section: Phase 5
- `./AIDEV/01-FLOW-DOCUMENTATION.md` - Complete flow understanding

**Reference Code:**
- `../support-agent/src/index.ts` - Main logic flow
- `../support-agent/src/services/customer-property-updater.service.ts` - Property update logic

**Actions:**
Create each Lambda with proper typing and error handling:

1. `apps/webhook-handler/src/index.ts`
   - Receives API Gateway event
   - Validates webhook payload
   - Starts Step Functions execution
   - Returns 200 response

2. `apps/acme-lookup/src/index.ts`
   - Searches Acme by customer email
   - Categorizes organizations (DESIGN/ENDUSER)
   - Adds to ProcessingContext

3. `apps/integration-fetcher/src/index.ts`
   - Fetches marketplace integrations for DESIGN orgs
   - Extracts shop URLs from Etsy, Shopify, WooCommerce

4. `apps/property-updater/src/index.ts`
   - Gets existing customer properties
   - Determines what to update (conditional logic)
   - Updates Help Scout customer properties

5. `apps/conversation-tagger/src/index.ts`
   - Adds "acme seller" or "acme customer" tag
   - Preserves existing tags

6. `apps/note-creator/src/index.ts`
   - Creates research note with findings
   - Includes intranet links

7. Create project.json for each Lambda with esbuild configuration

**Validation:**
- `nx run-many --target=build --all` succeeds
- `ls dist/apps/` shows all 6 compiled Lambda directories
- Each directory contains `index.js`

**STOP after Phase 4 and report to user.**

---

## PHASE 5: Terraform Infrastructure

**Goal:** Create all Terraform configuration files.

**Read First:**
- `./AIDEV/03-AWS-SERVICES-INVENTORY.md` - Complete AWS inventory
- `./AIDEV/04-IMPLEMENTATION-PLAN.md` - Section: Phase 6
- `./AIDEV/06-CREDENTIALS-SETUP.md` - Profile and terraform.tfvars

**Actions:**
1. Create `terraform/providers.tf` - AWS provider with profile `support-agent`
2. Create `terraform/variables.tf` - All input variables
3. Create `terraform/secrets.tf` - Secrets Manager resources
4. Create `terraform/iam.tf` - IAM roles and policies
5. Create `terraform/lambda.tf` - Lambda functions with archive data sources
6. Create `terraform/step-functions.tf` - State machine definition
7. Create `terraform/api-gateway.tf` - REST API with /webhook endpoint
8. Create `terraform/cloudwatch.tf` - Log groups
9. Create `terraform/outputs.tf` - Webhook URL, health URL
10. Create `terraform/terraform.tfvars`:
    ```hcl
    aws_region           = "us-west-2"
    aws_profile          = "support-agent"
    environment          = "prod"
    helpscout_mailbox_id = "100001"
    ```

**Validation:**
- `cd terraform && terraform init` succeeds
- `terraform validate` succeeds
- `terraform plan` shows resources to create (don't apply yet)

**STOP after Phase 5 and report to user.**

---

## PHASE 6: Deploy and Configure

**Goal:** Deploy to AWS and configure secrets.

**Prerequisites:** User must confirm Phase 5 validation passed.

**Read First:**
- `./AIDEV/06-CREDENTIALS-SETUP.md` - Secrets update commands

**Actions:**
1. Apply Terraform:
   ```bash
   cd terraform
   terraform apply -auto-approve
   ```

2. Capture outputs:
   ```bash
   terraform output webhook_url
   terraform output health_check_url
   ```

3. Update secrets with real values:
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id support-agent/helpscout-credentials \
     --secret-string '{"app_id":"<HELPSCOUT_APP_ID>","secret":"<HELPSCOUT_APP_SECRET>"}' \
     --profile support-agent

   aws secretsmanager put-secret-value \
     --secret-id support-agent/acme-api-key \
     --secret-string '{"api_key":"<ACME_API_KEY>","endpoint":"https://<APPSYNC_ID>.appsync-api.us-west-2.amazonaws.com/graphql"}' \
     --profile support-agent
   ```

**Validation:**
- Health check returns 200: `curl $(terraform output -raw health_check_url)`
- Secrets updated: `aws secretsmanager describe-secret --secret-id support-agent/helpscout-credentials --profile support-agent`

**STOP after Phase 6 and report to user with:**
- Webhook URL to configure in Help Scout
- Health check URL
- Any errors encountered

---

## PHASE 7: End-to-End Testing

**Goal:** Verify the complete system works.

**Actions:**
1. Send test webhook:
   ```bash
   curl -X POST "$(cd terraform && terraform output -raw webhook_url)" \
     -H "Content-Type: application/json" \
     -d '{
       "id": 999999999,
       "type": "conversation.created",
       "record": {
         "id": 999999999,
         "number": 99999,
         "type": "email",
         "mailboxId": 100001,
         "status": "active",
         "subject": "Test ticket",
         "primaryCustomer": {
           "id": 999999,
           "email": "test@example.com"
         }
       }
     }'
   ```

2. Check Step Functions execution:
   ```bash
   aws stepfunctions list-executions \
     --state-machine-arn $(cd terraform && terraform output -raw step_function_arn) \
     --profile support-agent \
     --max-results 5
   ```

3. Check CloudWatch logs for errors:
   ```bash
   aws logs filter-log-events \
     --log-group-name /aws/lambda/support-agent-webhook-handler \
     --profile support-agent \
     --limit 20
   ```

**Report to user:**
- Test results
- Any errors in logs
- Step Function execution status
- Instructions to configure Help Scout webhook

---

## Important Notes

1. **Always read the AIDEV docs before implementing** - they contain the complete specifications
2. **Reference the original project** at `../support-agent/` for implementation patterns
3. **Stop after each phase** - Let the user verify before proceeding
4. **Use the AWS profile `support-agent`** - it's already configured
5. **Don't modify the original project** - it should remain unchanged

## PROMPT END

---

*Copy everything between "PROMPT START" and "PROMPT END" to provide to the new Claude Code agent.*
