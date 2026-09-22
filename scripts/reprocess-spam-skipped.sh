#!/bin/bash
# Reprocess conversations that were skipped due to HelpScout spam classification
# These conversations were legitimate but marked as spam between April 20-21, 2026

set -euo pipefail

REGION="us-east-1"
PROFILE="support-agent"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text --profile "$PROFILE")"
STATE_MACHINE_ARN="arn:aws:states:${REGION}:${ACCOUNT_ID}:stateMachine:support-agent-workflow"

# Help Scout conversation IDs that were spam-skipped (pass as arguments or edit this list)
CONVERSATION_IDS=("$@")
if [ ${#CONVERSATION_IDS[@]} -eq 0 ]; then
  echo "Usage: $0 <conversationId> [<conversationId> ...]"
  exit 1
fi

# Get HelpScout OAuth token from Secrets Manager
echo "Fetching HelpScout credentials..."
HS_CREDS=$(aws secretsmanager get-secret-value \
  --secret-id support-agent/helpscout-credentials \
  --query SecretString --output text \
  --profile "$PROFILE" --region "$REGION")

HS_APP_ID=$(echo "$HS_CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin)['app_id'])")
HS_SECRET=$(echo "$HS_CREDS" | python3 -c "import sys,json; print(json.load(sys.stdin)['secret'])")

# Try cached token first
echo "Getting HelpScout access token..."
CACHED_TOKEN=$(aws secretsmanager get-secret-value \
  --secret-id support-agent/helpscout-oauth-token \
  --query SecretString --output text \
  --profile "$PROFILE" --region "$REGION" 2>/dev/null || echo '{}')

ACCESS_TOKEN=$(echo "$CACHED_TOKEN" | python3 -c "import sys,json; print(json.load(sys.stdin).get('access_token',''))" 2>/dev/null || echo "")

if [ -z "$ACCESS_TOKEN" ]; then
  echo "Cached token not found, authenticating..."
  TOKEN_RESPONSE=$(curl -s -X POST https://api.helpscout.net/v2/oauth2/token \
    -H "Content-Type: application/json" \
    -d "{\"grant_type\":\"client_credentials\",\"client_id\":\"$HS_APP_ID\",\"client_secret\":\"$HS_SECRET\"}")
  ACCESS_TOKEN=$(echo "$TOKEN_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
fi

echo "Authenticated with HelpScout"
echo ""

PROCESSED=0
FAILED=0

for CONV_ID in "${CONVERSATION_IDS[@]}"; do
  echo "Processing conversation $CONV_ID..."

  # Fetch conversation from HelpScout with threads embedded
  CONV_JSON=$(curl -s "https://api.helpscout.net/v2/conversations/${CONV_ID}?embed=threads" \
    -H "Authorization: Bearer $ACCESS_TOKEN")

  # Check for error
  ERROR=$(echo "$CONV_JSON" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('_embedded',{}).get('errors',[{}])[0].get('message','') if '_embedded' in d and 'errors' in d.get('_embedded',{}) else d.get('message',''))" 2>/dev/null || echo "")
  if [ -n "$ERROR" ] && [ "$ERROR" != "None" ] && [ "$ERROR" != "" ]; then
    echo "  ERROR fetching conversation: $ERROR"
    FAILED=$((FAILED + 1))
    continue
  fi

  # Extract fields using python
  CONTEXT_JSON=$(echo "$CONV_JSON" | python3 -c "
import sys, json, re

conv = json.load(sys.stdin)

customer = conv.get('primaryCustomer', {})
customer_id = customer.get('id', 0)
customer_email = customer.get('email', '')
mailbox_id = conv.get('mailboxId', 0)
subject = conv.get('subject', '')

threads = conv.get('_embedded', {}).get('threads', [])
first_thread = threads[0] if threads else {}
body_html = first_thread.get('body', conv.get('preview', ''))
body_text = re.sub(r'<[^>]*>', ' ', body_html)
body_text = re.sub(r'\s+', ' ', body_text).strip()

# Escape for JSON
context = {
    'context': {
        'conversationId': conv.get('id', $CONV_ID),
        'customerId': customer_id,
        'customerEmail': customer_email,
        'mailboxId': mailbox_id,
        'emailSubject': subject,
        'emailBody': body_text[:5000],
        'emailBodyHtml': body_html[:10000],
        'isMovedConversation': False,
        'tagsAdded': [],
        'errors': [],
    }
}

print(json.dumps(context))
")

  if [ -z "$CONTEXT_JSON" ] || [ "$CONTEXT_JSON" = "null" ]; then
    echo "  ERROR: Could not build context for conversation $CONV_ID"
    FAILED=$((FAILED + 1))
    continue
  fi

  CUSTOMER_EMAIL=$(echo "$CONTEXT_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['context']['customerEmail'])")
  echo "  Customer: $CUSTOMER_EMAIL"

  # Start Step Function execution
  aws stepfunctions start-execution \
    --state-machine-arn "$STATE_MACHINE_ARN" \
    --name "reprocess-spam-${CONV_ID}-$(date +%s)" \
    --input "$CONTEXT_JSON" \
    --profile "$PROFILE" --region "$REGION" \
    --query 'executionArn' --output text > /dev/null 2>&1

  echo "  Step Function started"
  PROCESSED=$((PROCESSED + 1))

  # Small delay to avoid rate limiting
  sleep 1
done

echo ""
echo "Done! Processed: $PROCESSED, Failed: $FAILED"
