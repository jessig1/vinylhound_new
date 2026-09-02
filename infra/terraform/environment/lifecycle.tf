resource "aws_ssm_parameter" "environment_active" {
  name  = "/vinylhound/${var.environment}/active"
  type  = "String"
  value = tostring(var.environment_active)
}

resource "aws_ssm_parameter" "expires_at" {
  name  = "/vinylhound/${var.environment}/expires-at"
  type  = "String"
  value = var.expires_at
}
