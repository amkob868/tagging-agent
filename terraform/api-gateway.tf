# IAM role for API Gateway CloudWatch logging
resource "aws_iam_role" "api_gateway_cloudwatch" {
  name = "support-agent-apigw-cloudwatch-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "apigateway.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "api_gateway_cloudwatch" {
  role       = aws_iam_role.api_gateway_cloudwatch.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs"
}

resource "aws_api_gateway_account" "main" {
  cloudwatch_role_arn = aws_iam_role.api_gateway_cloudwatch.arn
}

# REST API
resource "aws_api_gateway_rest_api" "support_agent" {
  name        = "support-agent-api"
  description = "Support Agent Webhook API"

  endpoint_configuration {
    types = ["REGIONAL"]
  }
}

# /webhook resource
resource "aws_api_gateway_resource" "webhook" {
  rest_api_id = aws_api_gateway_rest_api.support_agent.id
  parent_id   = aws_api_gateway_rest_api.support_agent.root_resource_id
  path_part   = "webhook"
}

# POST method
resource "aws_api_gateway_method" "webhook_post" {
  rest_api_id   = aws_api_gateway_rest_api.support_agent.id
  resource_id   = aws_api_gateway_resource.webhook.id
  http_method   = "POST"
  authorization = "NONE"
}

# Lambda integration
resource "aws_api_gateway_integration" "webhook_lambda" {
  rest_api_id = aws_api_gateway_rest_api.support_agent.id
  resource_id = aws_api_gateway_resource.webhook.id
  http_method = aws_api_gateway_method.webhook_post.http_method

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.webhook_handler.invoke_arn
}

# Lambda permission for API Gateway
resource "aws_lambda_permission" "apigw" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.webhook_handler.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.support_agent.execution_arn}/*/*"
}

# Health check endpoint
resource "aws_api_gateway_resource" "health" {
  rest_api_id = aws_api_gateway_rest_api.support_agent.id
  parent_id   = aws_api_gateway_rest_api.support_agent.root_resource_id
  path_part   = "health"
}

resource "aws_api_gateway_method" "health_get" {
  rest_api_id   = aws_api_gateway_rest_api.support_agent.id
  resource_id   = aws_api_gateway_resource.health.id
  http_method   = "GET"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "health_mock" {
  rest_api_id = aws_api_gateway_rest_api.support_agent.id
  resource_id = aws_api_gateway_resource.health.id
  http_method = aws_api_gateway_method.health_get.http_method
  type        = "MOCK"

  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "health_200" {
  rest_api_id = aws_api_gateway_rest_api.support_agent.id
  resource_id = aws_api_gateway_resource.health.id
  http_method = aws_api_gateway_method.health_get.http_method
  status_code = "200"
}

resource "aws_api_gateway_integration_response" "health_200" {
  rest_api_id = aws_api_gateway_rest_api.support_agent.id
  resource_id = aws_api_gateway_resource.health.id
  http_method = aws_api_gateway_method.health_get.http_method
  status_code = aws_api_gateway_method_response.health_200.status_code

  response_templates = {
    "application/json" = "{\"status\": \"healthy\"}"
  }
}

# /slack-webhook resource
resource "aws_api_gateway_resource" "slack_webhook" {
  rest_api_id = aws_api_gateway_rest_api.support_agent.id
  parent_id   = aws_api_gateway_rest_api.support_agent.root_resource_id
  path_part   = "slack-webhook"
}

# POST method for Slack events
resource "aws_api_gateway_method" "slack_webhook_post" {
  rest_api_id   = aws_api_gateway_rest_api.support_agent.id
  resource_id   = aws_api_gateway_resource.slack_webhook.id
  http_method   = "POST"
  authorization = "NONE"
}

# Lambda integration for Slack webhook
resource "aws_api_gateway_integration" "slack_webhook_lambda" {
  rest_api_id = aws_api_gateway_rest_api.support_agent.id
  resource_id = aws_api_gateway_resource.slack_webhook.id
  http_method = aws_api_gateway_method.slack_webhook_post.http_method

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.slack_orchestrator.invoke_arn
}

# Lambda permission for Slack API Gateway
resource "aws_lambda_permission" "slack_apigw" {
  statement_id  = "AllowSlackAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.slack_orchestrator.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.support_agent.execution_arn}/*/*"
}

# Deployment
resource "aws_api_gateway_deployment" "prod" {
  rest_api_id = aws_api_gateway_rest_api.support_agent.id

  depends_on = [
    aws_api_gateway_integration.webhook_lambda,
    aws_api_gateway_integration.health_mock,
    aws_api_gateway_integration_response.health_200,
    aws_api_gateway_integration.slack_webhook_lambda
  ]

  lifecycle {
    create_before_destroy = true
  }

  # Force new deployment when resources change
  triggers = {
    redeployment = sha1(jsonencode([
      aws_api_gateway_resource.webhook.id,
      aws_api_gateway_method.webhook_post.id,
      aws_api_gateway_integration.webhook_lambda.id,
      aws_api_gateway_resource.health.id,
      aws_api_gateway_method.health_get.id,
      aws_api_gateway_integration.health_mock.id,
      aws_api_gateway_resource.slack_webhook.id,
      aws_api_gateway_method.slack_webhook_post.id,
      aws_api_gateway_integration.slack_webhook_lambda.id,
    ]))
  }
}

# Stage
resource "aws_api_gateway_stage" "prod" {
  deployment_id = aws_api_gateway_deployment.prod.id
  rest_api_id   = aws_api_gateway_rest_api.support_agent.id
  stage_name    = "prod"

  depends_on = [aws_api_gateway_account.main]

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_gateway.arn
    format = jsonencode({
      requestId          = "$context.requestId"
      ip                 = "$context.identity.sourceIp"
      requestTime        = "$context.requestTime"
      httpMethod         = "$context.httpMethod"
      resourcePath       = "$context.resourcePath"
      status             = "$context.status"
      responseLength     = "$context.responseLength"
      integrationLatency = "$context.integrationLatency"
    })
  }
}

# CloudWatch Log Group for API Gateway
resource "aws_cloudwatch_log_group" "api_gateway" {
  name              = "/aws/apigateway/support-agent"
  retention_in_days = 14
}
