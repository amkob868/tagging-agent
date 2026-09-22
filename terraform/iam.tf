# Lambda execution role
data "aws_caller_identity" "current" {}

resource "aws_iam_role" "lambda_execution" {
  name = "support-agent-lambda-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
    }]
  })
}

# Lambda basic execution policy
resource "aws_iam_role_policy_attachment" "lambda_basic" {
  role       = aws_iam_role.lambda_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# Lambda X-Ray policy
resource "aws_iam_role_policy_attachment" "lambda_xray" {
  role       = aws_iam_role.lambda_execution.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

# Secrets Manager read policy for Lambda
resource "aws_iam_role_policy" "lambda_secrets_read" {
  name = "secrets-read"
  role = aws_iam_role.lambda_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "secretsmanager:GetSecretValue"
      ]
      Resource = [
        aws_secretsmanager_secret.helpscout_credentials.arn,
        aws_secretsmanager_secret.acme_api_key.arn,
        aws_secretsmanager_secret.helpscout_oauth_token.arn,
        aws_secretsmanager_secret.claude_api_key.arn,
        aws_secretsmanager_secret.jev_api_key.arn,
        aws_secretsmanager_secret.slack_credentials.arn
      ]
    }]
  })
}

# Secrets Manager write policy for OAuth token updates
resource "aws_iam_role_policy" "lambda_secrets_write" {
  name = "secrets-write"
  role = aws_iam_role.lambda_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "secretsmanager:PutSecretValue"
      ]
      Resource = [
        aws_secretsmanager_secret.helpscout_oauth_token.arn
      ]
    }]
  })
}

# Step Functions execution role
resource "aws_iam_role" "step_functions" {
  name = "support-agent-sfn-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "states.amazonaws.com"
      }
    }]
  })
}

# Step Functions Lambda invoke policy
resource "aws_iam_role_policy" "sfn_lambda_invoke" {
  name = "lambda-invoke"
  role = aws_iam_role.step_functions.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = "arn:aws:lambda:${var.aws_region}:*:function:support-agent-*"
    }]
  })
}

# Step Functions CloudWatch Logs policy
resource "aws_iam_role_policy" "sfn_cloudwatch" {
  name = "cloudwatch-logs"
  role = aws_iam_role.step_functions.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogDelivery",
        "logs:GetLogDelivery",
        "logs:UpdateLogDelivery",
        "logs:DeleteLogDelivery",
        "logs:ListLogDeliveries",
        "logs:PutResourcePolicy",
        "logs:DescribeResourcePolicies",
        "logs:DescribeLogGroups"
      ]
      Resource = "*"
    }]
  })
}

# Step Functions X-Ray policy
resource "aws_iam_role_policy_attachment" "sfn_xray" {
  role       = aws_iam_role.step_functions.name
  policy_arn = "arn:aws:iam::aws:policy/AWSXRayDaemonWriteAccess"
}

# Policy for webhook-handler to start Step Functions
resource "aws_iam_role_policy" "lambda_sfn_start" {
  name = "sfn-start-execution"
  role = aws_iam_role.lambda_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "states:StartExecution"
      Resource = aws_sfn_state_machine.support_agent.arn
    }]
  })
}

# Policy for slack-orchestrator to invoke note-creator and conversation-tagger
resource "aws_iam_role_policy" "lambda_invoke_lambdas" {
  name = "lambda-invoke"
  role = aws_iam_role.lambda_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = [
        aws_lambda_function.step_function_lambdas["note-creator"].arn,
        aws_lambda_function.step_function_lambdas["conversation-tagger"].arn
      ]
    }]
  })
}

# Policy for Lambda to read/write DynamoDB tables
resource "aws_iam_role_policy" "lambda_dynamodb" {
  name = "dynamodb-access"
  role = aws_iam_role.lambda_execution.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:DeleteItem",
        "dynamodb:Scan",
        "dynamodb:Query",
        "dynamodb:UpdateItem"
      ]
      Resource = [
        aws_dynamodb_table.tagging_rules.arn,
        aws_dynamodb_table.research_capabilities.arn,
        "arn:aws:dynamodb:${var.aws_region}:${data.aws_caller_identity.current.account_id}:table/support-agent-tag-confidence"
      ]
    }]
  })
}
