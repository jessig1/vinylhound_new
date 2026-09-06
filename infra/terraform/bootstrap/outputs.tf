output "terraform_state_bucket" {
  value = aws_s3_bucket.terraform_state.id
}

output "ecr_repository_urls" {
  value = { for name, repository in aws_ecr_repository.application : name => repository.repository_url }
}

output "github_plan_role_arn" {
  value = aws_iam_role.github_plan.arn
}

output "github_deploy_role_arns" {
  value = { for environment, role in aws_iam_role.github_deploy : environment => role.arn }
}
