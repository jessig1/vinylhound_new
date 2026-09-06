# Terraform bootstrap

This root creates the resources that must exist before environment state can
use the S3 backend: the state bucket, immutable ECR repositories, GitHub OIDC
provider, and GitHub plan/deployment roles.

```bash
terraform init
terraform apply -var="terraform_state_bucket=vinylhound-tf-<aws-account-id>"
```

S3 bucket names are global across all AWS accounts. Use only lowercase letters,
numbers, periods, and hyphens; underscores are invalid. Replace
`<aws-account-id>` with your 12-digit AWS account ID or another unique suffix.

The GitHub OIDC trust policies use this repository's exact stable-ID subject
prefix. Before bootstrapping a fork or transferred repository, retrieve its
prefix and pass it as `github_oidc_subject_prefix`:

```bash
gh api repos/<owner>/<repository>/actions/oidc/customization/sub --jq .sub_claim_prefix
terraform apply \
  -var="terraform_state_bucket=<globally-unique-name>" \
  -var="github_oidc_subject_prefix=<reported-prefix>"
```

Run it once with an AWS administrator identity. Store the output role ARNs and
state bucket name as GitHub repository or environment variables. If the AWS
account already has GitHub's OIDC provider, set
`create_github_oidc_provider=false`.

The deploy policy is action-scoped but intentionally broad across application
resources because Terraform creates and destroys the complete JIT stack. Keep
the OIDC subject restrictions intact and use a dedicated portfolio AWS account.
