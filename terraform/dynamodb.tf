# DynamoDB tables for storing dynamic agent rules

# Table for tagging rules (keyword -> tag mappings)
resource "aws_dynamodb_table" "tagging_rules" {
  name         = "support-agent-tagging-rules"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "keyword"

  attribute {
    name = "keyword"
    type = "S"
  }

  tags = {
    Project = "support-agent"
  }
}

# Table for research capabilities
resource "aws_dynamodb_table" "research_capabilities" {
  name         = "support-agent-research-capabilities"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "capabilityId"

  attribute {
    name = "capabilityId"
    type = "S"
  }

  tags = {
    Project = "support-agent"
  }
}
