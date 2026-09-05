variable "aws_region" {
  description = "AWS region for shared platform resources."
  type        = string
  default     = "us-east-1"
}

variable "terraform_state_bucket" {
  description = "Globally unique S3 bucket name for Terraform state."
  type        = string

  validation {
    condition = (
      length(var.terraform_state_bucket) >= 3 &&
      length(var.terraform_state_bucket) <= 63 &&
      can(regex("^[a-z0-9][a-z0-9.-]*[a-z0-9]$", var.terraform_state_bucket)) &&
      !strcontains(var.terraform_state_bucket, "..") &&
      !can(regex("^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$", var.terraform_state_bucket)) &&
      !startswith(var.terraform_state_bucket, "xn--") &&
      !startswith(var.terraform_state_bucket, "sthree-") &&
      !startswith(var.terraform_state_bucket, "amzn_s3_demo_") &&
      !endswith(var.terraform_state_bucket, "-s3alias") &&
      !endswith(var.terraform_state_bucket, "--ol-s3") &&
      !endswith(var.terraform_state_bucket, ".mrap") &&
      !endswith(var.terraform_state_bucket, "--x-s3") &&
      !endswith(var.terraform_state_bucket, "--table-s3")
    )
    error_message = "terraform_state_bucket must be a valid globally unique S3 bucket name: 3-63 lowercase letters, numbers, periods, or hyphens; it must begin and end with a letter or number and cannot contain underscores."
  }
}

variable "github_oidc_subject_prefix" {
  description = "Exact GitHub OIDC sub claim prefix for the repository, including immutable owner and repository IDs when GitHub supplies them."
  type        = string
  default     = "repo:jessig1@13804284/vinylhound_new@1345526931"

  validation {
    condition     = startswith(var.github_oidc_subject_prefix, "repo:") && !endswith(var.github_oidc_subject_prefix, ":")
    error_message = "github_oidc_subject_prefix must be the exact GitHub OIDC prefix beginning with repo: and without a trailing colon."
  }
}

variable "create_github_oidc_provider" {
  description = "Disable when the account already has GitHub's OIDC provider."
  type        = bool
  default     = true
}
