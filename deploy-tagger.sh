#!/bin/bash
set -euo pipefail

# Deploy Conversation Tagger
echo "Deploying support-agent-conversation-tagger..."
REPO_ROOT="$(cd "$(dirname "$0")" && pwd)"
ZIP_PATH="$REPO_ROOT/conversation-tagger.zip"

cd "$REPO_ROOT/dist/apps/conversation-tagger"
rm -f "$ZIP_PATH"
zip -r "$ZIP_PATH" index.js index.js.map

aws lambda update-function-code \
  --function-name support-agent-conversation-tagger \
  --zip-file "fileb://$ZIP_PATH" \
  --profile support-agent \
  --region us-east-1

echo "Done!"
