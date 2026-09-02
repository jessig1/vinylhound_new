# Terraform bootstrap

This root creates the resources that must exist before environment state can
use the S3 backend: the state bucket, immutable ECR repositories, GitHub OIDC
provider, and GitHub plan/deployment roles.

```bash
terraform init
terraform apply -var="terraform_state_bucket=<globally-unique-name>"
```

Run it once with an AWS administrator identity. Store the output role ARNs and
state bucket name as GitHub repository or environment variables. If the AWS
account already has GitHub's OIDC provider, set
`create_github_oidc_provider=false`.

The deploy policy is action-scoped but intentionally broad across application
resources because Terraform creates and destroys the complete JIT stack. Keep
the OIDC subject restrictions intact and use a dedicated portfolio AWS account.
