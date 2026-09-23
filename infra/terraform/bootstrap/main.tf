data "aws_caller_identity" "current" {}

resource "aws_s3_bucket" "terraform_state" {
  bucket = var.terraform_state_bucket

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_s3_bucket_public_access_block" "terraform_state" {
  bucket                  = aws_s3_bucket.terraform_state.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "terraform_state" {
  bucket = aws_s3_bucket.terraform_state.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "terraform_state" {
  depends_on = [aws_s3_bucket_versioning.terraform_state]
  bucket     = aws_s3_bucket.terraform_state.id

  rule {
    id     = "expire-old-state-versions"
    status = "Enabled"
    filter {}
    noncurrent_version_expiration {
      noncurrent_days = 90
    }
  }
}

resource "aws_ecr_repository" "application" {
  for_each             = toset(["web", "worker", "worker-lambda", "discovery"])
  name                 = "vinylhound-${each.key}"
  image_tag_mutability = "IMMUTABLE"
  force_delete         = false

  image_scanning_configuration {
    scan_on_push = true
  }

  encryption_configuration {
    encryption_type = "AES256"
  }
}

resource "aws_ecr_lifecycle_policy" "application" {
  for_each   = aws_ecr_repository.application
  repository = each.value.name
  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Retain the newest twenty immutable images"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 20
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 1 : 0

  url             = "https://token.actions.githubusercontent.com"
  client_id_list  = ["sts.amazonaws.com"]
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

data "aws_iam_openid_connect_provider" "github" {
  count = var.create_github_oidc_provider ? 0 : 1
  url   = "https://token.actions.githubusercontent.com"
}

locals {
  github_oidc_arn = var.create_github_oidc_provider ? aws_iam_openid_connect_provider.github[0].arn : data.aws_iam_openid_connect_provider.github[0].arn
  state_arn       = aws_s3_bucket.terraform_state.arn
  deploy_actions = [
    "acm:*", "apigateway:*", "application-autoscaling:*", "autoscaling:*",
    "budgets:*", "cloudfront:*", "cloudwatch:*", "ec2:*", "ecr:*", "ecs:*",
    "eks:*", "elasticloadbalancing:*", "events:*", "lambda:*", "sqs:*", "wafv2:*",
    "iam:AttachRolePolicy", "iam:CreatePolicy", "iam:CreateRole", "iam:CreateServiceLinkedRole",
    "iam:DeletePolicy", "iam:DeleteRole", "iam:DetachRolePolicy",
    "iam:DeleteRolePolicy", "iam:GetPolicy", "iam:GetPolicyVersion", "iam:GetRole",
    "iam:GetRolePolicy", "iam:ListAttachedRolePolicies", "iam:ListInstanceProfilesForRole",
    "iam:ListPolicyVersions", "iam:ListRolePolicies", "iam:PassRole", "iam:PutRolePolicy",
    "iam:TagPolicy", "iam:TagRole", "iam:UntagPolicy", "iam:UntagRole", "iam:UpdateAssumeRolePolicy",
    "logs:*", "rds:*", "route53:*", "s3:*", "secretsmanager:*", "sns:*", "ssm:*", "sts:GetCallerIdentity"
  ]

  # Which repository subject may assume each environment's deploy role.
  # "development" was transferred to the platform repository (P4.3 Task 3,
  # 2026-09-22): the old repository's writer is frozen
  # (deploy-development.yml disabled in vinylhound_new) and the cutover
  # deploy from vinylhound-platform is verified live, so only the platform
  # repository is trusted now — single-writer discipline, no dual trust left
  # over. "staging" is mid-transfer (P4.3 Task 3, 2026-09-23): dual-trusted
  # while vinylhound-platform's deploy-staging.yml is rehearsed and cut over;
  # narrow to the platform prefix alone (delete the application-repo entry)
  # once the cutover deploy is verified live. "production" is untouched,
  # still trusting only the application repository, pending its own future
  # transfer.
  deploy_trusted_subjects = {
    development = ["${var.github_oidc_subject_prefix_platform}:environment:development"]
    staging = [
      "${var.github_oidc_subject_prefix}:environment:staging",
      "${var.github_oidc_subject_prefix_platform}:environment:staging",
    ]
    production = ["${var.github_oidc_subject_prefix}:environment:production"]
  }
}

data "aws_iam_policy_document" "plan_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        # Application repository: platform.yml's terraform-plan job, which
        # only ever plans the environment (staging) root. Removed once that
        # root is deleted from the application repository (P4.3 Task 3).
        "${var.github_oidc_subject_prefix}:pull_request",
        "${var.github_oidc_subject_prefix}:ref:refs/heads/main",
        # Platform repository: its own PR-plan job for a transferred root.
        "${var.github_oidc_subject_prefix_platform}:pull_request",
        "${var.github_oidc_subject_prefix_platform}:ref:refs/heads/main",
      ]
    }
  }
}

resource "aws_iam_role" "github_plan" {
  name               = "vinylhound-github-plan"
  assume_role_policy = data.aws_iam_policy_document.plan_assume.json
}

resource "aws_iam_role_policy_attachment" "github_plan_readonly" {
  role       = aws_iam_role.github_plan.name
  policy_arn = "arn:aws:iam::aws:policy/ReadOnlyAccess"
}

resource "aws_iam_role_policy" "github_plan_state" {
  name = "terraform-state"
  role = aws_iam_role.github_plan.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:PutObject", "s3:DeleteObject"]
      Resource = ["${local.state_arn}/environments/*.tfstate.tflock"]
    }]
  })
}

data "aws_iam_policy_document" "deploy_assume" {
  for_each = local.deploy_trusted_subjects
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values   = each.value
    }
  }
}

resource "aws_iam_role" "github_deploy" {
  for_each             = data.aws_iam_policy_document.deploy_assume
  name                 = "vinylhound-github-${each.key}-deploy"
  assume_role_policy   = each.value.json
  max_session_duration = 14400 # 4h; production activation/deactivation can run long (issue #9)
}

resource "aws_iam_role_policy" "github_deploy" {
  for_each = aws_iam_role.github_deploy
  name     = "vinylhound-environment-deployment"
  role     = each.value.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = local.deploy_actions
      Resource = "*"
    }]
  })
}

# P4.3 Task 3 (ADR-0031's two-axis OIDC narrowing): a narrow role for the
# application repository's own build-and-push workflow, replacing its prior
# use of the broad per-environment deploy role for a plain `docker push`.
data "aws_iam_policy_document" "ecr_push_assume" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [local.github_oidc_arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringLike"
      variable = "token.actions.githubusercontent.com:sub"
      values   = ["${var.github_oidc_subject_prefix}:ref:refs/heads/main"]
    }
  }
}

resource "aws_iam_role" "github_ecr_push" {
  name               = "vinylhound-github-ecr-push"
  assume_role_policy = data.aws_iam_policy_document.ecr_push_assume.json
}

resource "aws_iam_role_policy" "github_ecr_push" {
  name = "ecr-push"
  role = aws_iam_role.github_ecr_push.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "ecr:GetAuthorizationToken"
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability", "ecr:GetDownloadUrlForLayer",
          "ecr:PutImage", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload", "ecr:DescribeImages", "ecr:DescribeRepositories",
          "ecr:BatchGetImage"
        ]
        Resource = [for r in aws_ecr_repository.application : r.arn]
      }
    ]
  })
}
