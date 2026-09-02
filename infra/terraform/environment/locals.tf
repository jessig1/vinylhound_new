data "aws_caller_identity" "current" {}
data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  name               = "vinylhound-${var.environment}"
  availability_zones = slice(data.aws_availability_zones.available.names, 0, 2)
  app_url            = "https://${var.hostname}"
  active_count       = var.environment_active ? 1 : 0
  service_count      = var.environment_active && var.deploy_services ? 1 : 0
  common_tags = {
    Application = "vinylhound"
    Environment = var.environment
    ManagedBy   = "terraform"
    Owner       = "jessig1"
    ExpiresAt   = var.expires_at
  }
}

data "http" "rds_ca_bundle" {
  url = "https://truststore.pki.rds.amazonaws.com/${var.aws_region}/${var.aws_region}-bundle.pem"
}
