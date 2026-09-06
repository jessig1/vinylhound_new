output "application_url" { value = local.app_url }
output "web_function_name" { value = aws_lambda_function.web.function_name }
output "worker_function_name" { value = aws_lambda_function.worker.function_name }
output "image_bucket" { value = aws_s3_bucket.images.id }
output "scan_queue_url" { value = aws_sqs_queue.scan.url }
output "scan_dead_letter_queue_url" { value = aws_sqs_queue.scan_dlq.url }
output "runtime_secret_arns" {
  value = { for name, secret in aws_secretsmanager_secret.runtime : name => secret.arn }
}
