data "aws_iam_policy_document" "eks_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}
resource "aws_iam_role" "eks" {
  name               = "${local.name}-cluster"
  assume_role_policy = data.aws_iam_policy_document.eks_assume.json
}
resource "aws_iam_role_policy_attachment" "eks" {
  role       = aws_iam_role.eks.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

resource "aws_cloudwatch_log_group" "eks" {
  name              = "/aws/eks/${local.name}/cluster"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "application" {
  name              = "/aws/containerinsights/${local.name}/application"
  retention_in_days = 30
}
resource "aws_eks_cluster" "main" {
  count    = local.active_count
  name     = local.name
  role_arn = aws_iam_role.eks.arn
  version  = var.kubernetes_version
  vpc_config {
    subnet_ids              = values(aws_subnet.private)[*].id
    endpoint_private_access = true
    endpoint_public_access  = true
  }
  access_config {
    authentication_mode                         = "API"
    bootstrap_cluster_creator_admin_permissions = true
  }
  enabled_cluster_log_types = ["api", "audit", "authenticator"]
  depends_on                = [aws_cloudwatch_log_group.eks, aws_iam_role_policy_attachment.eks]
}

data "aws_iam_policy_document" "node_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}
resource "aws_iam_role" "node" {
  name               = "${local.name}-node"
  assume_role_policy = data.aws_iam_policy_document.node_assume.json
}
resource "aws_iam_role_policy_attachment" "node" {
  for_each = toset([
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPullOnly",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
  ])
  role       = aws_iam_role.node.name
  policy_arn = each.value
}
resource "aws_eks_node_group" "main" {
  count           = local.active_count
  cluster_name    = aws_eks_cluster.main[0].name
  node_group_name = "application"
  node_role_arn   = aws_iam_role.node.arn
  subnet_ids      = values(aws_subnet.private)[*].id
  instance_types  = ["t4g.medium"]
  capacity_type   = "ON_DEMAND"
  disk_size       = 30
  scaling_config {
    desired_size = 2
    min_size     = 2
    max_size     = 4
  }
  update_config {
    max_unavailable = 1
  }
  depends_on = [aws_iam_role_policy_attachment.node]
}
resource "aws_eks_addon" "main" {
  for_each                    = var.environment_active ? toset(["vpc-cni", "kube-proxy", "coredns", "eks-pod-identity-agent", "metrics-server"]) : toset([])
  cluster_name                = aws_eks_cluster.main[0].name
  addon_name                  = each.key
  resolve_conflicts_on_update = "PRESERVE"
  depends_on                  = [aws_eks_node_group.main]
}

resource "aws_iam_role" "observability" {
  name               = "${local.name}-observability"
  assume_role_policy = data.aws_iam_policy_document.pod_assume.json
}

resource "aws_iam_role_policy_attachment" "observability" {
  for_each = toset([
    "arn:aws:iam::aws:policy/AWSXrayWriteOnlyAccess",
    "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy",
  ])
  role       = aws_iam_role.observability.name
  policy_arn = each.value
}

resource "aws_eks_addon" "observability" {
  count                       = local.active_count
  cluster_name                = aws_eks_cluster.main[0].name
  addon_name                  = "amazon-cloudwatch-observability"
  resolve_conflicts_on_update = "PRESERVE"
  pod_identity_association {
    role_arn        = aws_iam_role.observability.arn
    service_account = "cloudwatch-agent"
  }
  depends_on = [
    aws_cloudwatch_log_group.application,
    aws_eks_addon.main["eks-pod-identity-agent"],
    aws_iam_role_policy_attachment.observability,
  ]
}

data "aws_iam_policy_document" "pod_assume" {
  statement {
    actions = ["sts:AssumeRole", "sts:TagSession"]
    principals {
      type        = "Service"
      identifiers = ["pods.eks.amazonaws.com"]
    }
  }
}
resource "aws_iam_role" "pod" {
  for_each           = toset(["web", "worker"])
  name               = "${local.name}-${each.key}-pod"
  assume_role_policy = data.aws_iam_policy_document.pod_assume.json
}
resource "aws_iam_role_policy" "web" {
  role = aws_iam_role.pod["web"].id
  name = "application-access"
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect   = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
    Resource = [aws_s3_bucket.images.arn, "${aws_s3_bucket.images.arn}/*"]
  }] })
}
resource "aws_iam_role_policy" "worker" {
  role = aws_iam_role.pod["worker"].id
  name = "application-access"
  policy = jsonencode({ Version = "2012-10-17", Statement = [{
    Effect   = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:ListBucket"],
    Resource = [aws_s3_bucket.images.arn, "${aws_s3_bucket.images.arn}/*"]
    }, {
    Effect   = "Allow", Action = ["sqs:ChangeMessageVisibility", "sqs:DeleteMessage", "sqs:GetQueueAttributes", "sqs:ReceiveMessage", "sqs:SendMessage"],
    Resource = [aws_sqs_queue.scan.arn, aws_sqs_queue.scan_dead_letter.arn]
  }] })
}
resource "aws_eks_pod_identity_association" "pod" {
  for_each        = var.environment_active ? aws_iam_role.pod : {}
  cluster_name    = aws_eks_cluster.main[0].name
  namespace       = "vinylhound"
  service_account = each.key
  role_arn        = each.value.arn
  depends_on      = [aws_eks_addon.main]
}

resource "aws_vpc_security_group_ingress_rule" "database_from_eks" {
  count                        = local.active_count
  security_group_id            = aws_security_group.database.id
  referenced_security_group_id = aws_eks_cluster.main[0].vpc_config[0].cluster_security_group_id
  from_port                    = 5432
  to_port                      = 5432
  ip_protocol                  = "tcp"
}
