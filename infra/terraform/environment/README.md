# AWS environment

This Terraform root owns the isolated ECS staging environment. Development and
production have dedicated sibling roots; do not use Terraform workspaces.

```bash
terraform init -backend-config=backend.hcl
terraform plan -var-file=environment.tfvars
```

`environment_active=false` keeps the VPC, S3 data, Aurora Serverless cluster,
secrets, logs, certificate, SQS queues, and ECS cluster while removing NAT, ALB,
task definitions, and services. Aurora uses a zero-ACU minimum and auto-pauses
after ten idle minutes. Both Aurora and the image bucket have Terraform
`prevent_destroy`; decommissioning them requires a deliberate code change.

Activation is deliberately two-step. Apply with `environment_active=true` and
`deploy_services=false` to create the network, load balancer, and task
definitions; run the migration task; then apply with `deploy_services=true`.
This prevents a failed migration from rolling out application services.

Before the first activation, populate the three secret containers output by
Terraform:

```bash
aws secretsmanager put-secret-value --secret-id <clerk-secret-arn> --secret-string '<value>'
aws secretsmanager put-secret-value --secret-id <clerk-publishable-arn> --secret-string '<value>'
aws secretsmanager put-secret-value --secret-id <openai-secret-arn> --secret-string '<value>'
```

Never place those values in tfvars or GitHub secrets. GitHub stores only role
ARNs, state coordinates, domain inputs, and notification email configuration.
