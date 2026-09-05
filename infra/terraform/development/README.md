# Always-live development environment

This root deploys the lowest-idle-cost public portfolio tier: API Gateway and a
Next.js Lambda, SQS and an event-driven analysis Lambda, private S3 image
storage, and an externally managed PostgreSQL-compatible serverless database.
It deliberately has no VPC, NAT Gateway, load balancer, or idle worker.

Terraform creates four empty Secrets Manager containers. Populate the database
URL, Clerk keys, and OpenAI key before running the development deployment
workflow. CI reads those values without printing them and injects the Lambda
runtime environments after the infrastructure apply; Terraform ignores the
secret-bearing environment blocks so secret values never enter Terraform state.

The PostgreSQL endpoint must accept TLS connections from AWS Lambda's public
egress and support the repository's forward-only migrations. Development uses
the same schema and SQL implementation as staging and production.
