variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "domain_name" {
  description = "Existing Route 53 public hosted-zone domain."
  type        = string
}

variable "hostname" {
  description = "Development application hostname."
  type        = string

  validation {
    condition = (
      length(var.hostname) <= 253 &&
      can(regex("^[a-z0-9][a-z0-9.-]*[a-z0-9]$", var.hostname)) &&
      endswith(var.hostname, ".${var.domain_name}")
    )
    error_message = "hostname must be a valid fully qualified subdomain of domain_name."
  }
}

variable "web_image" {
  description = "Digest-pinned ECR image for the Next.js Lambda."
  type        = string
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.web_image))
    error_message = "web_image must be digest pinned."
  }
}

variable "worker_lambda_image" {
  description = "Digest-pinned ECR image for the SQS worker Lambda."
  type        = string
  validation {
    condition     = can(regex("@sha256:[0-9a-f]{64}$", var.worker_lambda_image))
    error_message = "worker_lambda_image must be digest pinned."
  }
}

variable "deployment_version" {
  type = string
}

variable "runtime_configured" {
  description = "Enable public/events integrations after CI injects secret-backed runtime environment variables."
  type        = bool
  default     = false
}

variable "budget_alert_email" {
  type = string
}
