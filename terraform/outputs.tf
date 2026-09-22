output "webhook_url" {
  description = "URL for Help Scout webhook"
  value       = "${aws_api_gateway_stage.prod.invoke_url}/webhook"
}

output "health_check_url" {
  description = "Health check URL"
  value       = "${aws_api_gateway_stage.prod.invoke_url}/health"
}

output "step_function_arn" {
  description = "Step Functions state machine ARN"
  value       = aws_sfn_state_machine.support_agent.arn
}

output "lambda_function_arns" {
  description = "ARNs of all Lambda functions"
  value = merge(
    { for name, fn in aws_lambda_function.step_function_lambdas : name => fn.arn },
    { "webhook-handler" = aws_lambda_function.webhook_handler.arn }
  )
}

output "secrets_to_update" {
  description = "Secrets that need to be updated with real values"
  value = [
    aws_secretsmanager_secret.helpscout_credentials.name,
    aws_secretsmanager_secret.acme_api_key.name,
    aws_secretsmanager_secret.slack_credentials.name
  ]
}

output "slack_webhook_url" {
  description = "URL for Slack Events API webhook"
  value       = "${aws_api_gateway_stage.prod.invoke_url}/slack-webhook"
}

output "api_gateway_id" {
  description = "API Gateway REST API ID"
  value       = aws_api_gateway_rest_api.support_agent.id
}
