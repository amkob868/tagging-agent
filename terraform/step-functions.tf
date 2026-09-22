# CloudWatch Log Group for Step Functions
resource "aws_cloudwatch_log_group" "step_functions" {
  name              = "/aws/stepfunctions/support-agent"
  retention_in_days = 30
}

# Step Functions State Machine
resource "aws_sfn_state_machine" "support_agent" {
  name     = "support-agent-workflow"
  role_arn = aws_iam_role.step_functions.arn

  definition = jsonencode({
    Comment = "Support Agent Ticket Processing Workflow"
    StartAt = "AcmeLookup"
    States = {
      AcmeLookup = {
        Type     = "Task"
        Resource = aws_lambda_function.step_function_lambdas["acme-lookup"].arn
        Next     = "CheckDesignOrg"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "HandleError"
          ResultPath  = "$.error"
        }]
      }
      CheckDesignOrg = {
        Type = "Choice"
        Choices = [{
          Variable  = "$.context.designOrg"
          IsPresent = true
          Next      = "FetchIntegrations"
        }]
        Default = "UpdateProperties"
      }
      FetchIntegrations = {
        Type     = "Task"
        Resource = aws_lambda_function.step_function_lambdas["integration-fetcher"].arn
        Next     = "UpdateProperties"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "UpdateProperties"
          ResultPath  = "$.integrationError"
        }]
      }
      UpdateProperties = {
        Type     = "Task"
        Resource = aws_lambda_function.step_function_lambdas["property-updater"].arn
        Next     = "TagConversation"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "TagConversation"
          ResultPath  = "$.propertyError"
        }]
      }
      TagConversation = {
        Type     = "Task"
        Resource = aws_lambda_function.step_function_lambdas["conversation-tagger"].arn
        Next     = "CreateNote"
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "CreateNote"
          ResultPath  = "$.tagError"
        }]
      }
      CreateNote = {
        Type     = "Task"
        Resource = aws_lambda_function.step_function_lambdas["note-creator"].arn
        End      = true
        Catch = [{
          ErrorEquals = ["States.ALL"]
          Next        = "HandleError"
          ResultPath  = "$.noteError"
        }]
      }
      HandleError = {
        Type = "Pass"
        End  = true
      }
    }
  })

  logging_configuration {
    level                  = "ALL"
    include_execution_data = true
    log_destination        = "${aws_cloudwatch_log_group.step_functions.arn}:*"
  }

  tracing_configuration {
    enabled = true
  }
}
