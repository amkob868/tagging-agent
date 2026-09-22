# Credentials Setup Guide

This document contains the specific configuration for your Support Agent AWS deployment.

## AWS Profile

The AWS CLI profile `support-agent` has been configured on your local machine.

**Profile Name:** `support-agent`
**Region:** `us-west-2`
**Account ID:** `<AWS_ACCOUNT_ID>`

### Verify Profile
```bash
aws sts get-caller-identity --profile support-agent
```

## Terraform Configuration

Use this `terraform.tfvars` file:

```hcl
aws_region           = "us-west-2"
aws_profile          = "support-agent"
environment          = "prod"
helpscout_mailbox_id = "100001"
```

## Secrets to Configure

After Terraform creates the Secrets Manager entries, run these commands to populate them with actual values:

### Help Scout Credentials
```bash
aws secretsmanager put-secret-value \
  --secret-id support-agent/helpscout-credentials \
  --secret-string '{"app_id":"<HELPSCOUT_APP_ID>","secret":"<HELPSCOUT_APP_SECRET>"}' \
  --profile support-agent
```

### Acme API Credentials
```bash
aws secretsmanager put-secret-value \
  --secret-id support-agent/acme-api-key \
  --secret-string '{"api_key":"<ACME_API_KEY>","endpoint":"https://<APPSYNC_ID>.appsync-api.us-west-2.amazonaws.com/graphql"}' \
  --profile support-agent
```

## Security Recommendations

Since these credentials were shared in plain text, you should:

1. **After deployment is working:** Rotate the Help Scout OAuth credentials
   - Go to Help Scout → Your Profile → My Apps
   - Regenerate the secret
   - Update the AWS secret with the new value

2. **Consider rotating AWS keys:**
   - Create a new IAM user with limited permissions
   - Generate new access keys
   - Update the AWS CLI profile
   - Delete the old keys

3. **Never commit credentials to git**
   - All `.tfvars` files with secrets should be in `.gitignore`
   - Use Secrets Manager for all sensitive values

## Quick Setup Commands

After Terraform apply, run this script to update all secrets:

```bash
#!/bin/bash
set -e

echo "Updating Help Scout credentials..."
aws secretsmanager put-secret-value \
  --secret-id support-agent/helpscout-credentials \
  --secret-string '{"app_id":"<HELPSCOUT_APP_ID>","secret":"<HELPSCOUT_APP_SECRET>"}' \
  --profile support-agent

echo "Updating Acme API credentials..."
aws secretsmanager put-secret-value \
  --secret-id support-agent/acme-api-key \
  --secret-string '{"api_key":"<ACME_API_KEY>","endpoint":"https://<APPSYNC_ID>.appsync-api.us-west-2.amazonaws.com/graphql"}' \
  --profile support-agent

echo "All secrets updated successfully!"
```
