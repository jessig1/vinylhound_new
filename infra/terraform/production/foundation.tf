data "aws_caller_identity" "current" {}
data "aws_availability_zones" "available" { state = "available" }
data "aws_route53_zone" "main" {
  name         = "${var.domain_name}."
  private_zone = false
}
data "http" "rds_ca_bundle" {
  url = "https://truststore.pki.rds.amazonaws.com/${var.aws_region}/${var.aws_region}-bundle.pem"
}

locals {
  name               = "vinylhound-production"
  app_url            = "https://${var.hostname}"
  active_count       = var.environment_active ? 1 : 0
  availability_zones = slice(data.aws_availability_zones.available.names, 0, 2)
  common_tags = {
    Application = "vinylhound"
    Environment = "production"
    ManagedBy   = "terraform"
    Owner       = "jessig1"
    ExpiresAt   = var.expires_at
    CostProfile = "performance"
  }
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = local.name }
}
resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}
resource "aws_subnet" "public" {
  for_each                = { for index, az in local.availability_zones : az => index }
  vpc_id                  = aws_vpc.main.id
  availability_zone       = each.key
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, each.value)
  map_public_ip_on_launch = false
  tags                    = { Name = "${local.name}-public-${each.value + 1}" }
}
resource "aws_subnet" "private" {
  for_each          = { for index, az in local.availability_zones : az => index }
  vpc_id            = aws_vpc.main.id
  availability_zone = each.key
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, each.value + 8)
  tags = {
    Name                              = "${local.name}-private-${each.value + 1}"
    "kubernetes.io/role/internal-elb" = "1"
  }
}
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}
resource "aws_route_table_association" "public" {
  for_each       = aws_subnet.public
  subnet_id      = each.value.id
  route_table_id = aws_route_table.public.id
}
resource "aws_eip" "nat" {
  count  = local.active_count
  domain = "vpc"
}
resource "aws_nat_gateway" "main" {
  count         = local.active_count
  allocation_id = aws_eip.nat[0].id
  subnet_id     = values(aws_subnet.public)[0].id
  depends_on    = [aws_internet_gateway.main]
}
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.main.id
  dynamic "route" {
    for_each = var.environment_active ? [1] : []
    content {
      cidr_block     = "0.0.0.0/0"
      nat_gateway_id = aws_nat_gateway.main[0].id
    }
  }
}
resource "aws_route_table_association" "private" {
  for_each       = aws_subnet.private
  subnet_id      = each.value.id
  route_table_id = aws_route_table.private.id
}
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.aws_region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = [aws_route_table.private.id]
}

resource "aws_s3_bucket" "images" {
  bucket = "vinylhound-${data.aws_caller_identity.current.account_id}-production-images"
  lifecycle { prevent_destroy = true }
}
resource "aws_s3_bucket_public_access_block" "images" {
  bucket                  = aws_s3_bucket.images.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_ownership_controls" "images" {
  bucket = aws_s3_bucket.images.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "images" {
  bucket = aws_s3_bucket.images.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
    bucket_key_enabled = true
  }
}
resource "aws_s3_bucket_versioning" "images" {
  bucket = aws_s3_bucket.images.id
  versioning_configuration {
    status = "Enabled"
  }
}
resource "aws_s3_bucket_cors_configuration" "images" {
  bucket = aws_s3_bucket.images.id
  cors_rule {
    allowed_headers = ["content-type"]
    allowed_methods = ["PUT"]
    allowed_origins = [local.app_url]
    expose_headers  = ["etag"]
    max_age_seconds = 300
  }
}
resource "aws_s3_bucket_lifecycle_configuration" "images" {
  depends_on = [aws_s3_bucket_versioning.images]
  bucket     = aws_s3_bucket.images.id
  rule {
    id     = "protect-recovery-window"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration { noncurrent_days = 35 }
    abort_incomplete_multipart_upload { days_after_initiation = 7 }
  }
}

resource "random_password" "database" {
  length  = 32
  special = false
}
resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = values(aws_subnet.private)[*].id
}
resource "aws_security_group" "database" {
  name_prefix = "${local.name}-database-"
  description = "Aurora access from EKS nodes"
  vpc_id      = aws_vpc.main.id
}
resource "aws_rds_cluster" "main" {
  cluster_identifier        = local.name
  engine                    = "aurora-postgresql"
  database_name             = "vinylhound"
  master_username           = "vinylhound"
  master_password           = random_password.database.result
  db_subnet_group_name      = aws_db_subnet_group.main.name
  vpc_security_group_ids    = [aws_security_group.database.id]
  storage_encrypted         = true
  backup_retention_period   = 30
  deletion_protection       = true
  skip_final_snapshot       = false
  final_snapshot_identifier = "${local.name}-final"
  serverlessv2_scaling_configuration {
    min_capacity             = 0
    max_capacity             = var.database_max_acu
    seconds_until_auto_pause = 600
  }
  lifecycle { prevent_destroy = true }
}
resource "aws_rds_cluster_instance" "writer" {
  identifier          = "${local.name}-writer"
  cluster_identifier  = aws_rds_cluster.main.id
  instance_class      = "db.serverless"
  engine              = aws_rds_cluster.main.engine
  engine_version      = aws_rds_cluster.main.engine_version
  publicly_accessible = false
  lifecycle { prevent_destroy = true }
}

resource "aws_secretsmanager_secret" "database_url" {
  name                    = "${local.name}/database-url"
  recovery_window_in_days = 30
}
resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = "postgresql://vinylhound:${random_password.database.result}@${aws_rds_cluster.main.endpoint}:5432/vinylhound"
}
resource "aws_secretsmanager_secret" "clerk_secret_key" {
  name                    = "${local.name}/clerk-secret-key"
  recovery_window_in_days = 30
}
resource "aws_secretsmanager_secret" "clerk_publishable_key" {
  name                    = "${local.name}/clerk-publishable-key"
  recovery_window_in_days = 30
}
resource "aws_secretsmanager_secret" "openai_api_key" {
  name                    = "${local.name}/openai-api-key"
  recovery_window_in_days = 30
}

resource "aws_sqs_queue" "scan_dead_letter" {
  name                      = "${local.name}-scans-dlq.fifo"
  fifo_queue                = true
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}
resource "aws_sqs_queue" "scan" {
  name                       = "${local.name}-scans.fifo"
  fifo_queue                 = true
  message_retention_seconds  = 1209600
  visibility_timeout_seconds = 180
  receive_wait_time_seconds  = 20
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.scan_dead_letter.arn
    maxReceiveCount     = 5
  })
}
resource "aws_sqs_queue_redrive_allow_policy" "scan" {
  queue_url = aws_sqs_queue.scan_dead_letter.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.scan.arn]
  })
}

resource "aws_ssm_parameter" "environment_active" {
  name  = "/vinylhound/production/active"
  type  = "String"
  value = tostring(var.environment_active)
}
resource "aws_ssm_parameter" "expires_at" {
  name  = "/vinylhound/production/expires-at"
  type  = "String"
  value = var.expires_at
}
