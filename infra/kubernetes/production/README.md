# Production workloads

The committed manifests contain no credentials and intentionally use invalid
image placeholders. The production workflow creates the runtime ConfigMap and
Secrets from Terraform outputs and Secrets Manager, sets digest-addressed ECR
images, runs the migration Job, then applies the web/worker Deployments.

The web Service uses fixed NodePort `30080` because Terraform owns the internal
ALB and attaches the EKS managed-node-group Auto Scaling group directly. This
keeps the basic Kubernetes demonstration independent of an in-cluster load
balancer controller.
