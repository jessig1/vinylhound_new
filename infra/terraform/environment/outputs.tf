output "application_url" {
  value = var.environment_active ? local.app_url : null
}

output "environment_active" {
  value = var.environment_active
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.main.name
}

output "private_subnet_ids" {
  value = values(aws_subnet.private)[*].id
}

output "worker_security_group_id" {
  value = aws_security_group.worker.id
}

output "worker_task_definition_arn" {
  value = var.environment_active ? aws_ecs_task_definition.worker[0].arn : null
}

output "image_bucket" {
  value = aws_s3_bucket.images.id
}

output "runtime_secret_arns" {
  value = {
    clerk_secret_key      = aws_secretsmanager_secret.clerk_secret_key.arn
    clerk_publishable_key = aws_secretsmanager_secret.clerk_publishable_key.arn
    openai_api_key        = aws_secretsmanager_secret.openai_api_key.arn
  }
}
