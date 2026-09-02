resource "aws_elasticache_serverless_cache" "main" {
  count = local.active_count

  engine                   = "valkey"
  name                     = local.name
  description              = "Ephemeral BullMQ transport for ${local.name}"
  subnet_ids               = values(aws_subnet.private)[*].id
  security_group_ids       = [aws_security_group.cache.id]
  snapshot_retention_limit = 1

  cache_usage_limits {
    data_storage {
      maximum = 1
      unit    = "GB"
    }
    ecpu_per_second {
      maximum = 1000
    }
  }
}
