locals {
  # Step Function Lambda functions (no special environment variables)
  step_function_lambdas = {
    acme-lookup = {
      memory  = 256
      timeout = 15
      handler = "index.handler"
    }
    integration-fetcher = {
      memory  = 256
      timeout = 15
      handler = "index.handler"
    }
    property-updater = {
      memory  = 256
      timeout = 15
      handler = "index.handler"
    }
    conversation-tagger = {
      memory  = 256
      timeout = 10
      handler = "index.handler"
    }
    note-creator = {
      memory  = 256
      timeout = 30
      handler = "index.handler"
    }
  }
}

# Archive Lambda code for Step Function lambdas
data "archive_file" "step_function_lambda" {
  for_each = local.step_function_lambdas

  type        = "zip"
  source_dir  = "${path.module}/../dist/apps/${each.key}"
  output_path = "${path.module}/.terraform/lambda-${each.key}.zip"
}

# Archive Lambda code for webhook-handler
data "archive_file" "webhook_handler" {
  type        = "zip"
  source_dir  = "${path.module}/../dist/apps/webhook-handler"
  output_path = "${path.module}/.terraform/lambda-webhook-handler.zip"
}

# CloudWatch Log Groups for Step Function lambdas
resource "aws_cloudwatch_log_group" "step_function_lambda" {
  for_each = local.step_function_lambdas

  name              = "/aws/lambda/support-agent-${each.key}"
  retention_in_days = 30
}

# CloudWatch Log Group for webhook-handler
resource "aws_cloudwatch_log_group" "webhook_handler" {
  name              = "/aws/lambda/support-agent-webhook-handler"
  retention_in_days = 30
}

# Step Function Lambda Functions
resource "aws_lambda_function" "step_function_lambdas" {
  for_each = local.step_function_lambdas

  function_name = "support-agent-${each.key}"
  role          = aws_iam_role.lambda_execution.arn
  handler       = each.value.handler
  runtime       = "nodejs18.x"
  architectures = ["arm64"]

  filename         = data.archive_file.step_function_lambda[each.key].output_path
  source_code_hash = data.archive_file.step_function_lambda[each.key].output_base64sha256

  memory_size = each.value.memory
  timeout     = each.value.timeout

  environment {
    variables = merge(
      {
        NODE_OPTIONS = "--enable-source-maps"
      },
      # Add DynamoDB table names for conversation-tagger and note-creator
      each.key == "conversation-tagger" ? {
        TAGGING_RULES_TABLE = aws_dynamodb_table.tagging_rules.name
      } : {},
      each.key == "note-creator" ? {
        RESEARCH_CAPABILITIES_TABLE = aws_dynamodb_table.research_capabilities.name
      } : {}
    )
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.step_function_lambda]
}

# Webhook Handler Lambda Function (created after Step Function so it can reference ARN)
resource "aws_lambda_function" "webhook_handler" {
  function_name = "support-agent-webhook-handler"
  role          = aws_iam_role.lambda_execution.arn
  handler       = "index.handler"
  runtime       = "nodejs18.x"
  architectures = ["arm64"]

  filename         = data.archive_file.webhook_handler.output_path
  source_code_hash = data.archive_file.webhook_handler.output_base64sha256

  memory_size = 256
  timeout     = 30

  environment {
    variables = {
      NODE_OPTIONS      = "--enable-source-maps"
      STATE_MACHINE_ARN = aws_sfn_state_machine.support_agent.arn
    }
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.webhook_handler]
}

# Archive Lambda code for slack-orchestrator
data "archive_file" "slack_orchestrator" {
  type        = "zip"
  source_dir  = "${path.module}/../dist/apps/slack-orchestrator"
  output_path = "${path.module}/.terraform/lambda-slack-orchestrator.zip"
}

# CloudWatch Log Group for slack-orchestrator
resource "aws_cloudwatch_log_group" "slack_orchestrator" {
  name              = "/aws/lambda/support-agent-slack-orchestrator"
  retention_in_days = 30
}

# Slack Orchestrator Lambda Function
resource "aws_lambda_function" "slack_orchestrator" {
  function_name = "support-agent-slack-orchestrator"
  role          = aws_iam_role.lambda_execution.arn
  handler       = "index.handler"
  runtime       = "nodejs18.x"
  architectures = ["arm64"]

  filename         = data.archive_file.slack_orchestrator.output_path
  source_code_hash = data.archive_file.slack_orchestrator.output_base64sha256

  memory_size = 512
  timeout     = 60

  environment {
    variables = {
      NODE_OPTIONS              = "--enable-source-maps"
      TAGGING_RULES_TABLE       = aws_dynamodb_table.tagging_rules.name
      RESEARCH_CAPABILITIES_TABLE = aws_dynamodb_table.research_capabilities.name
    }
  }

  tracing_config {
    mode = "Active"
  }

  depends_on = [aws_cloudwatch_log_group.slack_orchestrator]
}

# Combined output for all Lambda functions (for use in other resources)
locals {
  all_lambda_functions = merge(
    aws_lambda_function.step_function_lambdas,
    { "webhook-handler" = aws_lambda_function.webhook_handler },
    { "slack-orchestrator" = aws_lambda_function.slack_orchestrator }
  )
}
