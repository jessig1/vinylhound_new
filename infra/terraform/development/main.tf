data "aws_caller_identity" "current" {}
data "aws_route53_zone" "main" {
  name         = "${var.domain_name}."
  private_zone = false
}

locals {
  name    = "vinylhound-development"
  app_url = "https://${var.hostname}"
  common_tags = {
    Application = "vinylhound"
    Environment = "development"
    ManagedBy   = "terraform"
    Owner       = "jessig1"
    CostProfile = "scale-to-zero"
  }
}

resource "aws_s3_bucket" "images" {
  bucket = "vinylhound-${data.aws_caller_identity.current.account_id}-development-images"
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
    apply_server_side_encryption_by_default { sse_algorithm = "AES256" }
  }
}

resource "aws_s3_bucket_versioning" "images" {
  bucket = aws_s3_bucket.images.id
  versioning_configuration { status = "Enabled" }
}

resource "aws_s3_bucket_lifecycle_configuration" "images" {
  depends_on = [aws_s3_bucket_versioning.images]
  bucket     = aws_s3_bucket.images.id
  rule {
    id     = "protect-recovery-window"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 14
    }
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
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

resource "aws_sqs_queue" "scan_dlq" {
  name                      = "${local.name}-scans-dlq.fifo"
  fifo_queue                = true
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "scan" {
  name                      = "${local.name}-scans.fifo"
  fifo_queue                = true
  message_retention_seconds = 1209600
  # AWS recommends at least six times the Lambda timeout (150 seconds).
  visibility_timeout_seconds = 900
  receive_wait_time_seconds  = 20
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.scan_dlq.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "scan" {
  queue_url = aws_sqs_queue.scan_dlq.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.scan.arn]
  })
}

resource "aws_secretsmanager_secret" "runtime" {
  for_each = toset([
    "database-url",
    "clerk-secret-key",
    "clerk-publishable-key",
    "openai-api-key"
  ])
  name                    = "${local.name}/${each.key}"
  recovery_window_in_days = 7
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "lambda" {
  for_each           = toset(["web", "worker"])
  name               = "${local.name}-${each.key}"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  for_each   = aws_iam_role.lambda
  role       = each.value.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "web" {
  role = aws_iam_role.lambda["web"].id
  name = "application-access"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
      Resource = "${aws_s3_bucket.images.arn}/*"
      }, {
      Effect   = "Allow"
      Action   = ["s3:ListBucket"]
      Resource = aws_s3_bucket.images.arn
    }]
  })
}

resource "aws_iam_role_policy" "worker" {
  role = aws_iam_role.lambda["worker"].id
  name = "application-access"
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"]
      Resource = [aws_s3_bucket.images.arn, "${aws_s3_bucket.images.arn}/*"]
      }, {
      Effect = "Allow"
      Action = [
        "sqs:ChangeMessageVisibility",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:ReceiveMessage",
        "sqs:SendMessage"
      ]
      Resource = [aws_sqs_queue.scan.arn, aws_sqs_queue.scan_dlq.arn]
    }]
  })
}

resource "aws_cloudwatch_log_group" "lambda" {
  for_each          = toset(["web", "worker"])
  name              = "/aws/lambda/${local.name}-${each.key}"
  retention_in_days = 7
}

resource "aws_lambda_function" "web" {
  function_name = "${local.name}-web"
  package_type  = "Image"
  image_uri     = var.web_image
  architectures = ["arm64"]
  role          = aws_iam_role.lambda["web"].arn
  memory_size   = 1024
  timeout       = 60
  environment {
    variables = { RUNTIME_CONFIGURATION_PENDING = "true" }
  }
  lifecycle { ignore_changes = [environment] }
  depends_on = [aws_cloudwatch_log_group.lambda]
}

resource "aws_lambda_function" "worker" {
  function_name = "${local.name}-worker"
  package_type  = "Image"
  image_uri     = var.worker_lambda_image
  architectures = ["arm64"]
  role          = aws_iam_role.lambda["worker"].arn
  memory_size   = 2048
  timeout       = 150
  environment {
    variables = { RUNTIME_CONFIGURATION_PENDING = "true" }
  }
  lifecycle { ignore_changes = [environment] }
  depends_on = [aws_cloudwatch_log_group.lambda]
}

resource "aws_lambda_event_source_mapping" "scan" {
  count                              = var.runtime_configured ? 1 : 0
  event_source_arn                   = aws_sqs_queue.scan.arn
  function_name                      = aws_lambda_function.worker.arn
  batch_size                         = 1
  function_response_types            = ["ReportBatchItemFailures"]
  maximum_batching_window_in_seconds = 0
  scaling_config { maximum_concurrency = 2 }
}

resource "aws_cloudwatch_event_rule" "outbox" {
  count               = var.runtime_configured ? 1 : 0
  name                = "${local.name}-outbox"
  schedule_expression = "rate(1 minute)"
}

resource "aws_cloudwatch_event_target" "outbox" {
  count     = var.runtime_configured ? 1 : 0
  rule      = aws_cloudwatch_event_rule.outbox[0].name
  target_id = "worker"
  arn       = aws_lambda_function.worker.arn
}

resource "aws_lambda_permission" "outbox" {
  count         = var.runtime_configured ? 1 : 0
  statement_id  = "AllowEventBridgeOutbox"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.worker.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.outbox[0].arn
}

resource "aws_apigatewayv2_api" "web" {
  name          = local.name
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "web" {
  api_id                 = aws_apigatewayv2_api.web.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.web.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "default" {
  count     = var.runtime_configured ? 1 : 0
  api_id    = aws_apigatewayv2_api.web.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.web.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.web.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "api" {
  count         = var.runtime_configured ? 1 : 0
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.web.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.web.execution_arn}/*/*"
}

resource "aws_acm_certificate" "app" {
  domain_name       = var.hostname
  validation_method = "DNS"
  lifecycle { create_before_destroy = true }
}

resource "aws_route53_record" "certificate" {
  for_each = {
    for option in aws_acm_certificate.app.domain_validation_options : option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  }
  zone_id = data.aws_route53_zone.main.zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 60
}

resource "aws_acm_certificate_validation" "app" {
  certificate_arn         = aws_acm_certificate.app.arn
  validation_record_fqdns = [for record in aws_route53_record.certificate : record.fqdn]
}

resource "aws_apigatewayv2_domain_name" "app" {
  domain_name = var.hostname
  domain_name_configuration {
    certificate_arn = aws_acm_certificate_validation.app.certificate_arn
    endpoint_type   = "REGIONAL"
    security_policy = "TLS_1_2"
  }
}

resource "aws_apigatewayv2_api_mapping" "app" {
  api_id      = aws_apigatewayv2_api.web.id
  domain_name = aws_apigatewayv2_domain_name.app.id
  stage       = aws_apigatewayv2_stage.default.id
}

resource "aws_route53_record" "app" {
  zone_id = data.aws_route53_zone.main.zone_id
  name    = var.hostname
  type    = "A"
  alias {
    name                   = aws_apigatewayv2_domain_name.app.domain_name_configuration[0].target_domain_name
    zone_id                = aws_apigatewayv2_domain_name.app.domain_name_configuration[0].hosted_zone_id
    evaluate_target_health = false
  }
}

resource "aws_sns_topic" "budget" { name = "${local.name}-budget" }
resource "aws_sns_topic_subscription" "budget" {
  topic_arn = aws_sns_topic.budget.arn
  protocol  = "email"
  endpoint  = var.budget_alert_email
}

resource "aws_budgets_budget" "monthly" {
  name         = "${local.name}-monthly"
  budget_type  = "COST"
  limit_amount = "10"
  limit_unit   = "USD"
  time_unit    = "MONTHLY"
  notification {
    comparison_operator        = "GREATER_THAN"
    threshold                  = 80
    threshold_type             = "PERCENTAGE"
    notification_type          = "ACTUAL"
    subscriber_email_addresses = [var.budget_alert_email]
  }
}
