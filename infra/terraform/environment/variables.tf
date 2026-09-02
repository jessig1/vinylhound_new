variable "aws_region" {
  type    = string
  default = "us-east-1"
}

variable "environment" {
  description = "Isolated VinylHound environment."
  type        = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "environment_active" {
  description = "Create hourly-cost runtime resources."
  type        = bool
  default     = false
}

variable "deploy_services" {
  description = "Create ECS services and autoscaling after migrations succeed."
  type        = bool
  default     = false
  validation {
    condition     = !var.deploy_services || var.environment_active
    error_message = "deploy_services requires environment_active=true."
  }
}

variable "vpc_cidr" {
  type = string
  validation {
    condition     = can(cidrnetmask(var.vpc_cidr))
    error_message = "vpc_cidr must be a valid IPv4 CIDR."
  }
}

variable "domain_name" {
  description = "Existing Route 53 public hosted-zone domain without a trailing dot."
  type        = string
}

variable "hostname" {
  description = "Fully qualified application hostname."
  type        = string
}

variable "web_image" {
  description = "Immutable ECR web image reference including sha256 digest."
  type        = string
  default     = ""
  validation {
    condition     = !var.environment_active || can(regex("@sha256:[0-9a-f]{64}$", var.web_image))
    error_message = "An active environment requires a digest-pinned web_image."
  }
}

variable "worker_image" {
  description = "Immutable ECR worker image reference including sha256 digest."
  type        = string
  default     = ""
  validation {
    condition     = !var.environment_active || can(regex("@sha256:[0-9a-f]{64}$", var.worker_image))
    error_message = "An active environment requires a digest-pinned worker_image."
  }
}

variable "deployment_version" {
  description = "Git commit or release identifier included in runtime logs."
  type        = string
  default     = "inactive"
}

variable "expires_at" {
  description = "UTC RFC3339 expiry recorded on active resources."
  type        = string
  default     = "inactive"
}

variable "budget_alert_email" {
  description = "Email address for AWS Budget and alarm notifications."
  type        = string
}

variable "database_max_acu" {
  type    = number
  default = 2
  validation {
    condition     = var.database_max_acu >= 0.5 && var.database_max_acu <= 8
    error_message = "database_max_acu must be between 0.5 and 8."
  }
}

variable "user_daily_analysis_limit" {
  type    = number
  default = 25
}

variable "user_active_scan_limit" {
  type    = number
  default = 5
}

variable "user_monthly_spend_limit_usd" {
  type    = number
  default = 5
}

variable "scan_cost_reservation_usd" {
  type    = number
  default = 0.25
}
