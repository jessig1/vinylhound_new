output "application_url" {
  value = var.environment_active ? local.app_url : null
}

output "environment_active" {
  value = var.environment_active
}

output "eks_cluster_name" {
  value = var.environment_active ? aws_eks_cluster.main[0].name : null
}

output "image_bucket" {
  value = aws_s3_bucket.images.id
}

output "scan_queue_url" {
  value = aws_sqs_queue.scan.url
}

output "scan_dead_letter_queue_url" {
  value = aws_sqs_queue.scan_dead_letter.url
}

output "database_ca_base64" {
  value     = base64encode(data.http.rds_ca_bundle.response_body)
  sensitive = true
}
output "runtime_secret_arns" {
  value = {
    database_url          = aws_secretsmanager_secret.database_url.arn
    clerk_secret_key      = aws_secretsmanager_secret.clerk_secret_key.arn
    clerk_publishable_key = aws_secretsmanager_secret.clerk_publishable_key.arn
    openai_api_key        = aws_secretsmanager_secret.openai_api_key.arn
  }
}
output "kubernetes_runtime" {
  value = var.environment_active ? {
    app_url                      = local.app_url
    deployment_version           = var.deployment_version
    image_bucket                 = aws_s3_bucket.images.id
    scan_queue_url               = aws_sqs_queue.scan.url
    scan_dlq_url                 = aws_sqs_queue.scan_dead_letter.url
    database_max_connections     = 5
    user_daily_analysis_limit    = var.user_daily_analysis_limit
    user_active_scan_limit       = var.user_active_scan_limit
    user_monthly_spend_limit_usd = var.user_monthly_spend_limit_usd
    scan_cost_reservation_usd    = var.scan_cost_reservation_usd
    web_image                    = var.web_image
    worker_image                 = var.worker_image
  } : null
  sensitive = true
}
