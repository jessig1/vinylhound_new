# Just-in-time production environment

This root retains private S3, Aurora Serverless v2, SQS, secrets, DNS
validation, alarms, and state. Setting `environment_active=true` adds NAT,
two ARM EKS nodes, Kubernetes control plane/add-ons, an internal ALB,
CloudFront VPC origin/distribution, and AWS WAF. The public hostname resolves
only while production is active.

CloudFront caches only immutable `/_next/static/*` assets. All authenticated
HTML and API requests use the managed caching-disabled policy and forward
viewer cookies and headers to the private ALB. Kubernetes uses fixed NodePort
`30080`; Terraform attaches the managed-node-group Auto Scaling group to the
ALB target group. Application pods remain stateless and use Aurora, S3, and
SQS outside the cluster.

Production activation is intentionally slower and more expensive than staging:
expect EKS, VPC-origin, and CloudFront provisioning to take tens of minutes.
The environment must be drained before the Kubernetes runtime is destroyed.
