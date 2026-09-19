resource "aws_ecs_cluster" "main" {
  name = local.name

  setting {
    name  = "containerInsights"
    value = "disabled"
  }
}

resource "aws_ecs_cluster_capacity_providers" "main" {
  cluster_name       = aws_ecs_cluster.main.name
  capacity_providers = ["FARGATE", "FARGATE_SPOT"]

  default_capacity_provider_strategy {
    capacity_provider = "FARGATE"
    base              = 1
    weight            = 1
  }
}

resource "aws_cloudwatch_log_group" "service" {
  for_each = toset(["web", "worker", "discovery"])

  name              = "/vinylhound/${var.environment}/${each.key}"
  retention_in_days = var.environment == "production" ? 30 : 7
}

# Cloud Map HTTP namespace backing ECS Service Connect (P4.1 Task 5): lets
# web reach discovery at a stable in-cluster name ("discovery") without a
# second internal load balancer. An HTTP namespace (not a DNS namespace)
# creates no Route 53 hosted zone and therefore no extra fixed monthly cost —
# Service Connect's own proxy handles resolution, DNS is not involved.
resource "aws_service_discovery_http_namespace" "internal" {
  name = "${local.name}-internal"
}

data "aws_iam_policy_document" "ecs_task_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  for_each = toset(["web", "worker", "discovery"])

  name               = "${local.name}-${each.key}-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  for_each = aws_iam_role.execution

  role       = each.value.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role_policy" "execution_secrets" {
  for_each = {
    web = [
      aws_secretsmanager_secret.database_url.arn,
      aws_secretsmanager_secret.clerk_secret_key.arn,
      aws_secretsmanager_secret.clerk_publishable_key.arn,
      aws_secretsmanager_secret.discovery_shared_secret.arn
    ]
    worker = [
      aws_secretsmanager_secret.database_url.arn,
      aws_secretsmanager_secret.openai_api_key.arn
    ]
    discovery = [
      aws_secretsmanager_secret.discovery_shared_secret.arn
    ]
  }

  name = "runtime-secrets"
  role = aws_iam_role.execution[each.key].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = each.value
    }]
  })
}

resource "aws_iam_role" "web" {
  name               = "${local.name}-web"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

resource "aws_iam_role" "worker" {
  name               = "${local.name}-worker"
  assume_role_policy = data.aws_iam_policy_document.ecs_task_assume.json
}

resource "aws_iam_role_policy" "web" {
  name = "application-access"
  role = aws_iam_role.web.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
      Resource = "${aws_s3_bucket.images.arn}/*"
      }, {
      Effect   = "Allow"
      Action   = ["s3:ListBucket"]
      Resource = aws_s3_bucket.images.arn
    }]
  })
}

resource "aws_iam_role_policy" "worker" {
  name = "application-access"
  role = aws_iam_role.worker.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]
      Resource = "${aws_s3_bucket.images.arn}/*"
      }, {
      Effect = "Allow"
      Action = [
        "sqs:ChangeMessageVisibility",
        "sqs:DeleteMessage",
        "sqs:GetQueueAttributes",
        "sqs:ReceiveMessage",
        "sqs:SendMessage"
      ]
      Resource = [
        aws_sqs_queue.scan.arn,
        aws_sqs_queue.scan_dead_letter.arn,
        aws_sqs_queue.confirmation_processing.arn,
        aws_sqs_queue.confirmation_processing_dead_letter.arn,
        aws_sqs_queue.confirmation_completion.arn,
        aws_sqs_queue.confirmation_completion_dead_letter.arn
      ]
      }, {
      Effect   = "Allow"
      Action   = ["s3:ListBucket"]
      Resource = aws_s3_bucket.images.arn
      }, {
      Effect   = "Allow"
      Action   = ["cloudwatch:PutMetricData"]
      Resource = "*"
      Condition = {
        StringEquals = { "cloudwatch:namespace" = "VinylHound" }
      }
    }]
  })
}

locals {
  database_environment = [
    { name = "DATABASE_MAX_CONNECTIONS", value = "5" },
    { name = "DATABASE_CONNECT_TIMEOUT_MS", value = "30000" },
    { name = "DATABASE_SSL_MODE", value = "verify-full" },
    { name = "DATABASE_SSL_CA_BASE64", value = base64encode(data.http.rds_ca_bundle.response_body) }
  ]
  common_environment = [
    { name = "NODE_ENV", value = "production" },
    { name = "DEPLOYMENT_VERSION", value = var.deployment_version },
    { name = "QUEUE_DRIVER", value = "sqs" },
    { name = "SQS_QUEUE_URL", value = aws_sqs_queue.scan.url },
    { name = "SQS_DEAD_LETTER_QUEUE_URL", value = aws_sqs_queue.scan_dead_letter.url },
    # P4.2 Task 3 (ADR-0028): the two confirmation-pipeline hops.
    { name = "SQS_CONFIRMATION_PROCESSING_QUEUE_URL", value = aws_sqs_queue.confirmation_processing.url },
    { name = "SQS_CONFIRMATION_PROCESSING_DEAD_LETTER_QUEUE_URL", value = aws_sqs_queue.confirmation_processing_dead_letter.url },
    { name = "SQS_CONFIRMATION_COMPLETION_QUEUE_URL", value = aws_sqs_queue.confirmation_completion.url },
    { name = "SQS_CONFIRMATION_COMPLETION_DEAD_LETTER_QUEUE_URL", value = aws_sqs_queue.confirmation_completion_dead_letter.url },
    { name = "SQS_MAX_RECEIVE_COUNT", value = "5" },
    { name = "SQS_VISIBILITY_TIMEOUT_SECONDS", value = "180" },
    { name = "S3_REGION", value = var.aws_region },
    { name = "S3_BUCKET", value = aws_s3_bucket.images.id },
    { name = "S3_FORCE_PATH_STYLE", value = "false" }
  ]
}

resource "aws_ecs_task_definition" "web" {
  count = local.active_count

  family                   = "${local.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution["web"].arn
  task_role_arn            = aws_iam_role.web.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  volume { name = "tmp" }

  container_definitions = jsonencode([{
    name                   = "web"
    image                  = var.web_image
    essential              = true
    readonlyRootFilesystem = true
    linuxParameters        = { initProcessEnabled = true }
    portMappings = [{
      name          = "http"
      containerPort = 3000
      hostPort      = 3000
      protocol      = "tcp"
    }]
    mountPoints = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
    environment = concat(local.database_environment, local.common_environment, [
      { name = "APP_URL", value = local.app_url },
      { name = "AUTH_MODE", value = "production" },
      { name = "NEXT_PUBLIC_AUTH_MODE", value = "production" },
      { name = "USER_DAILY_ANALYSIS_LIMIT", value = tostring(var.user_daily_analysis_limit) },
      { name = "USER_ACTIVE_SCAN_LIMIT", value = tostring(var.user_active_scan_limit) },
      { name = "USER_MONTHLY_SPEND_LIMIT_USD", value = tostring(var.user_monthly_spend_limit_usd) },
      { name = "SCAN_COST_RESERVATION_USD", value = tostring(var.scan_cost_reservation_usd) },
      # "discovery" is the Service Connect client_alias name the discovery
      # service below publishes into this cluster's namespace, not a DNS
      # record — resolvable only from a task with Service Connect enabled
      # (P4.1 Task 5, ADR-0025).
      { name = "DISCOVERY_SERVICE_URL", value = "http://discovery:4001" }
    ])
    secrets = [
      { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
      { name = "CLERK_SECRET_KEY", valueFrom = aws_secretsmanager_secret.clerk_secret_key.arn },
      { name = "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", valueFrom = aws_secretsmanager_secret.clerk_publishable_key.arn },
      { name = "DISCOVERY_SERVICE_SHARED_SECRET", valueFrom = aws_secretsmanager_secret.discovery_shared_secret.arn }
    ]
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:3000/api/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))\""]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.service["web"].name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "web"
      }
    }
  }])
}

resource "aws_ecs_task_definition" "worker" {
  count = local.active_count

  family                   = "${local.name}-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 1024
  memory                   = 2048
  execution_role_arn       = aws_iam_role.execution["worker"].arn
  task_role_arn            = aws_iam_role.worker.arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  volume { name = "tmp" }

  container_definitions = jsonencode([{
    name                   = "worker"
    image                  = var.worker_image
    essential              = true
    readonlyRootFilesystem = true
    linuxParameters        = { initProcessEnabled = true }
    stopTimeout            = 120
    mountPoints            = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
    environment = concat(local.database_environment, local.common_environment, [
      { name = "OUTBOX_POLL_INTERVAL_MS", value = "1000" },
      { name = "ANALYSIS_CONCURRENCY", value = "1" },
      { name = "OPENAI_VISION_MODEL", value = "gpt-5.6-sol" },
      { name = "OPENAI_IMAGE_DETAIL", value = "high" },
      { name = "OPENAI_TIMEOUT_MS", value = "120000" },
      { name = "CLOUDWATCH_METRICS_ENABLED", value = "false" },
      { name = "CLOUDWATCH_METRIC_NAMESPACE", value = "VinylHound" },
      { name = "ENVIRONMENT_NAME", value = var.environment },
      { name = "WORKER_HEALTH_FILE", value = "/tmp/vinylhound-worker-health" }
    ])
    secrets = [
      { name = "DATABASE_URL", valueFrom = aws_secretsmanager_secret.database_url.arn },
      { name = "OPENAI_API_KEY", valueFrom = aws_secretsmanager_secret.openai_api_key.arn }
    ]
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"const{mtimeMs}=require('node:fs').statSync(process.env.WORKER_HEALTH_FILE);if(Date.now()-mtimeMs>120000)process.exit(1)\""]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 10
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.service["worker"].name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "worker"
      }
    }
  }])
}

# The extracted discovery service (ADR-0025, P4.1 Task 5): owns the
# MusicBrainz/Spotify provider adapters for staging, reached over an
# authenticated internal API. No database or object-storage access, no
# Spotify credentials configured here either — staging has never had
# working Spotify discovery (unconfigured in this environment before this
# task, same as today), so this is a pure lift of the existing
# catalog-search behavior into its own service, not a new capability.
resource "aws_ecs_task_definition" "discovery" {
  count = local.active_count

  family                   = "${local.name}-discovery"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 256
  memory                   = 512
  execution_role_arn       = aws_iam_role.execution["discovery"].arn

  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "ARM64"
  }

  volume { name = "tmp" }

  container_definitions = jsonencode([{
    name                   = "discovery"
    image                  = var.discovery_image
    essential              = true
    readonlyRootFilesystem = true
    linuxParameters        = { initProcessEnabled = true }
    portMappings = [{
      name          = "http"
      containerPort = 4001
      hostPort      = 4001
      protocol      = "tcp"
    }]
    mountPoints = [{ sourceVolume = "tmp", containerPath = "/tmp", readOnly = false }]
    environment = [
      { name = "NODE_ENV", value = "production" },
      { name = "DEPLOYMENT_VERSION", value = var.deployment_version },
      { name = "APP_URL", value = local.app_url },
      { name = "DISCOVERY_SERVICE_PORT", value = "4001" },
      { name = "ENVIRONMENT_NAME", value = var.environment }
    ]
    secrets = [
      { name = "DISCOVERY_SERVICE_SHARED_SECRET", valueFrom = aws_secretsmanager_secret.discovery_shared_secret.arn }
    ]
    healthCheck = {
      command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:4001/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))\""]
      interval    = 30
      timeout     = 5
      retries     = 3
      startPeriod = 30
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        "awslogs-group"         = aws_cloudwatch_log_group.service["discovery"].name
        "awslogs-region"        = var.aws_region
        "awslogs-stream-prefix" = "discovery"
      }
    }
  }])
}

resource "aws_ecs_service" "web" {
  count = local.service_count

  name                              = "web"
  cluster                           = aws_ecs_cluster.main.id
  task_definition                   = aws_ecs_task_definition.web[0].arn
  desired_count                     = 1
  health_check_grace_period_seconds = 180

  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    base              = 1
    weight            = 1
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = values(aws_subnet.private)[*].id
    security_groups  = [aws_security_group.web.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.web[0].arn
    container_name   = "web"
    container_port   = 3000
  }

  # Client-only Service Connect (P4.1 Task 5): web publishes no endpoint of
  # its own here (the ALB target group above reaches it directly by task IP,
  # unaffected by Service Connect either way) but needs the namespace enabled
  # to resolve discovery's "discovery" client alias below.
  service_connect_configuration {
    enabled   = true
    namespace = aws_service_discovery_http_namespace.internal.arn
  }

  lifecycle { ignore_changes = [desired_count] }
  depends_on = [aws_lb_listener.https]
}

resource "aws_ecs_service" "worker" {
  count = local.service_count

  name            = "worker"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.worker[0].arn
  desired_count   = 1

  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    base              = 1
    weight            = 1
  }
  capacity_provider_strategy {
    capacity_provider = "FARGATE_SPOT"
    base              = 0
    weight            = 4
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = values(aws_subnet.private)[*].id
    security_groups  = [aws_security_group.worker.id]
    assign_public_ip = false
  }

  lifecycle { ignore_changes = [desired_count] }
}

# ADR-0026: discovery is pinned to exactly one task with a stop-then-start
# rollout — deliberately not the web/worker pattern above. No
# capacity_provider_strategy including FARGATE_SPOT (avoids stacking a Spot
# interruption on top of the already-accepted single-instance availability
# tradeoff) and no lifecycle.ignore_changes (nothing else ever changes
# desired_count, since there is no autoscaling target below). The circuit
# breaker is kept despite minimum_healthy_percent = 0: it decides rollback
# eligibility from deployment history, not from an old task still running,
# so it is exactly what keeps a bad discovery image from leaving the
# service at zero healthy tasks indefinitely — more important here than for
# web/worker, which always keep a previous task up during their own rollout.
resource "aws_ecs_service" "discovery" {
  count = local.service_count

  name                               = "discovery"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = aws_ecs_task_definition.discovery[0].arn
  desired_count                      = 1
  deployment_minimum_healthy_percent = 0
  deployment_maximum_percent         = 100

  capacity_provider_strategy {
    capacity_provider = "FARGATE"
    base              = 1
    weight            = 1
  }

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    subnets          = values(aws_subnet.private)[*].id
    security_groups  = [aws_security_group.discovery.id]
    assign_public_ip = false
  }

  service_connect_configuration {
    enabled   = true
    namespace = aws_service_discovery_http_namespace.internal.arn

    service {
      port_name      = "http"
      discovery_name = "discovery"
      client_alias {
        port = 4001
      }
    }
  }
}

resource "aws_appautoscaling_target" "web" {
  count = local.service_count

  max_capacity       = 3
  min_capacity       = 1
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.web[0].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "web_cpu" {
  count = local.service_count

  name               = "${local.name}-web-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.web[0].resource_id
  scalable_dimension = aws_appautoscaling_target.web[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.web[0].service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = 60
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
  }
}

resource "aws_appautoscaling_target" "worker" {
  count = local.service_count

  max_capacity       = 5
  min_capacity       = 1
  resource_id        = "service/${aws_ecs_cluster.main.name}/${aws_ecs_service.worker[0].name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "worker_queue" {
  count = local.service_count

  name               = "${local.name}-worker-queue"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.worker[0].resource_id
  scalable_dimension = aws_appautoscaling_target.worker[0].scalable_dimension
  service_namespace  = aws_appautoscaling_target.worker[0].service_namespace

  target_tracking_scaling_policy_configuration {
    target_value       = 5
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
    customized_metric_specification {
      metric_name = "ApproximateNumberOfMessagesVisible"
      namespace   = "AWS/SQS"
      statistic   = "Average"
      unit        = "Count"
      dimensions {
        name  = "QueueName"
        value = aws_sqs_queue.scan.name
      }
    }
  }
}
