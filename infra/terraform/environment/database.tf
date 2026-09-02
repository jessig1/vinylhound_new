resource "random_password" "database" {
  length  = 32
  special = false
}

resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = values(aws_subnet.private)[*].id
}

resource "aws_rds_cluster" "main" {
  cluster_identifier                  = local.name
  engine                              = "aurora-postgresql"
  database_name                       = "vinylhound"
  master_username                     = "vinylhound"
  master_password                     = random_password.database.result
  db_subnet_group_name                = aws_db_subnet_group.main.name
  vpc_security_group_ids              = [aws_security_group.database.id]
  storage_encrypted                   = true
  backup_retention_period             = 30
  preferred_backup_window             = "05:00-06:00"
  preferred_maintenance_window        = "sun:06:00-sun:07:00"
  deletion_protection                 = true
  skip_final_snapshot                 = false
  final_snapshot_identifier           = "${local.name}-final"
  iam_database_authentication_enabled = false
  apply_immediately                   = true

  serverlessv2_scaling_configuration {
    min_capacity             = 0
    max_capacity             = var.database_max_acu
    seconds_until_auto_pause = 600
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_rds_cluster_instance" "writer" {
  identifier          = "${local.name}-writer"
  cluster_identifier  = aws_rds_cluster.main.id
  instance_class      = "db.serverless"
  engine              = aws_rds_cluster.main.engine
  engine_version      = aws_rds_cluster.main.engine_version
  publicly_accessible = false

  lifecycle {
    prevent_destroy = true
  }
}

resource "aws_secretsmanager_secret" "database_url" {
  name                    = "${local.name}/database-url"
  recovery_window_in_days = var.environment == "production" ? 30 : 7
}

resource "aws_secretsmanager_secret_version" "database_url" {
  secret_id     = aws_secretsmanager_secret.database_url.id
  secret_string = "postgresql://vinylhound:${random_password.database.result}@${aws_rds_cluster.main.endpoint}:5432/vinylhound"
}
