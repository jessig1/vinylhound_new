variable "aws_region" {
  description = "AWS region for shared platform resources."
  type        = string
  default     = "us-east-1"
}

variable "terraform_state_bucket" {
  description = "Globally unique S3 bucket name for Terraform state."
  type        = string
}

variable "github_repository" {
  description = "GitHub owner/repository allowed to assume deployment roles."
  type        = string
  default     = "jessig1/vinylhound_new"
}

variable "create_github_oidc_provider" {
  description = "Disable when the account already has GitHub's OIDC provider."
  type        = bool
  default     = true
}
