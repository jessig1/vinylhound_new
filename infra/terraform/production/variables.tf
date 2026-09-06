variable "aws_region" {
  type    = string
  default = "us-east-1"
  validation {
    condition     = var.aws_region == "us-east-1"
    error_message = "Production stays in us-east-1 so its CloudFront certificate is valid."
  }
}
variable "environment_active" {
  type    = bool
  default = false
}

variable "vpc_cidr" {
  type = string
  validation {
    condition     = can(cidrnetmask(var.vpc_cidr))
    error_message = "vpc_cidr must be a valid IPv4 CIDR."
  }
}

variable "domain_name" {
  type = string
}

variable "hostname" {
  type = string
}

variable "budget_alert_email" {
  type = string
}

variable "deployment_version" {
  type    = string
  default = "inactive"
}

variable "expires_at" {
  type    = string
  default = "inactive"
}
variable "kubernetes_version" {
  description = "Supported EKS Kubernetes version; null lets EKS choose its current default."
  type        = string
  default     = null
  nullable    = true
}
variable "web_image" {
  type    = string
  default = ""
  validation {
    condition     = !var.environment_active || can(regex("@sha256:[0-9a-f]{64}$", var.web_image))
    error_message = "An active production environment requires a digest-pinned web image."
  }
}
variable "worker_image" {
  type    = string
  default = ""
  validation {
    condition     = !var.environment_active || can(regex("@sha256:[0-9a-f]{64}$", var.worker_image))
    error_message = "An active production environment requires a digest-pinned worker image."
  }
}
variable "database_max_acu" {
  type    = number
  default = 4
  validation {
    condition     = var.database_max_acu >= 0.5 && var.database_max_acu <= 16
    error_message = "database_max_acu must be between 0.5 and 16."
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
