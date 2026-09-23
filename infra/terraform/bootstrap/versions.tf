terraform {
  required_version = ">= 1.10.0"

  # Bootstrap is applied only by a human administrator (never a GitHub Actions
  # workflow), so unlike the other three roots this backend is hardcoded
  # rather than supplied via -backend-config at init time. Key deliberately
  # sits outside the "environments/" prefix the other three roots use, since
  # that prefix is what vinylhound-github-plan's lock-object IAM grant scopes
  # to, and no CI role ever touches bootstrap's state.
  backend "s3" {
    bucket       = "vinylhound-tf"
    key          = "bootstrap/terraform.tfstate"
    region       = "us-east-1"
    use_lockfile = true
    encrypt      = true
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = {
      Application = "vinylhound"
      ManagedBy   = "terraform"
      Component   = "bootstrap"
    }
  }
}
