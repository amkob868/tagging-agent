variable "aws_region" {
  description = "AWS region to deploy resources"
  type        = string
  default     = "us-west-2"
}

variable "aws_profile" {
  description = "AWS CLI profile to use"
  type        = string
  default     = "support-agent"
}

variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
  default     = "prod"
}

variable "helpscout_mailbox_id" {
  description = "Help Scout mailbox ID"
  type        = string
  default     = "100001"
}

variable "alert_email" {
  description = "Email address for alerts"
  type        = string
  default     = ""
}
