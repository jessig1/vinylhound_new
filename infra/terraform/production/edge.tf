data "aws_cloudfront_cache_policy" "disabled" { name = "Managed-CachingDisabled" }
data "aws_cloudfront_cache_policy" "optimized" { name = "Managed-CachingOptimized" }
data "aws_cloudfront_origin_request_policy" "all_viewer" { name = "Managed-AllViewer" }
data "aws_cloudfront_response_headers_policy" "security" { name = "Managed-SecurityHeadersPolicy" }

resource "aws_security_group" "alb" {
  name_prefix = "${local.name}-alb-"
  description = "Private CloudFront VPC origin"
  vpc_id      = aws_vpc.main.id
  ingress {
    description = "HTTP from CloudFront VPC-origin ENIs inside the dedicated VPC"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_lb" "app" {
  count                      = local.active_count
  name                       = local.name
  internal                   = true
  load_balancer_type         = "application"
  security_groups            = [aws_security_group.alb.id]
  subnets                    = values(aws_subnet.private)[*].id
  drop_invalid_header_fields = true
}
resource "aws_lb_target_group" "web" {
  count       = local.active_count
  name        = "${local.name}-web"
  port        = 30080
  protocol    = "HTTP"
  target_type = "instance"
  vpc_id      = aws_vpc.main.id
  health_check {
    path     = "/api/readyz"
    matcher  = "200"
    interval = 30
    timeout  = 5
  }
}
resource "aws_lb_listener" "web" {
  count             = local.active_count
  load_balancer_arn = aws_lb.app[0].arn
  port              = 80
  protocol          = "HTTP"
  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.web[0].arn
  }
}
resource "aws_autoscaling_attachment" "web" {
  count                  = local.active_count
  autoscaling_group_name = aws_eks_node_group.main[0].resources[0].autoscaling_groups[0].name
  lb_target_group_arn    = aws_lb_target_group.web[0].arn
}
resource "aws_vpc_security_group_ingress_rule" "node_from_alb" {
  count                        = local.active_count
  security_group_id            = aws_eks_cluster.main[0].vpc_config[0].cluster_security_group_id
  referenced_security_group_id = aws_security_group.alb.id
  from_port                    = 30080
  to_port                      = 30080
  ip_protocol                  = "tcp"
}

resource "aws_cloudfront_vpc_origin" "app" {
  count = local.active_count
  vpc_origin_endpoint_config {
    name                   = local.name
    arn                    = aws_lb.app[0].arn
    http_port              = 80
    https_port             = 443
    origin_protocol_policy = "http-only"
    origin_ssl_protocols {
      items    = ["TLSv1.2"]
      quantity = 1
    }
  }
}

resource "aws_wafv2_web_acl" "app" {
  count = local.active_count
  name  = local.name
  scope = "CLOUDFRONT"
  default_action {
    allow {}
  }
  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = local.name
    sampled_requests_enabled   = true
  }
  rule {
    name     = "aws-common"
    priority = 10
    override_action {
      none {}
    }
    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-common"
      sampled_requests_enabled   = true
    }
  }
  rule {
    name     = "rate-limit"
    priority = 20
    action {
      block {}
    }
    statement {
      rate_based_statement {
        aggregate_key_type    = "IP"
        limit                 = 1000
        evaluation_window_sec = 300
      }
    }
    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${local.name}-rate"
      sampled_requests_enabled   = true
    }
  }
}

resource "aws_acm_certificate" "app" {
  domain_name       = var.hostname
  validation_method = "DNS"
  lifecycle { create_before_destroy = true }
}
resource "aws_route53_record" "certificate" {
  for_each = {
    for option in aws_acm_certificate.app.domain_validation_options : option.domain_name => {
      name   = option.resource_record_name
      record = option.resource_record_value
      type   = option.resource_record_type
    }
  }
  zone_id = data.aws_route53_zone.main.zone_id
  name    = each.value.name
  type    = each.value.type
  records = [each.value.record]
  ttl     = 60
}
resource "aws_acm_certificate_validation" "app" {
  certificate_arn         = aws_acm_certificate.app.arn
  validation_record_fqdns = [for record in aws_route53_record.certificate : record.fqdn]
}

resource "aws_cloudfront_distribution" "app" {
  count               = local.active_count
  enabled             = true
  aliases             = [var.hostname]
  price_class         = "PriceClass_100"
  web_acl_id          = aws_wafv2_web_acl.app[0].arn
  http_version        = "http2and3"
  is_ipv6_enabled     = true
  wait_for_deployment = true
  origin {
    domain_name = aws_lb.app[0].dns_name
    origin_id   = "eks-web"
    vpc_origin_config {
      vpc_origin_id       = aws_cloudfront_vpc_origin.app[0].id
      origin_read_timeout = 60
    }
  }
  default_cache_behavior {
    target_origin_id           = "eks-web"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id   = data.aws_cloudfront_origin_request_policy.all_viewer.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security.id
    compress                   = true
  }
  ordered_cache_behavior {
    path_pattern               = "/_next/static/*"
    target_origin_id           = "eks-web"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD", "OPTIONS"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = data.aws_cloudfront_response_headers_policy.security.id
    compress                   = true
  }
  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }
  viewer_certificate {
    acm_certificate_arn      = aws_acm_certificate_validation.app.certificate_arn
    ssl_support_method       = "sni-only"
    minimum_protocol_version = "TLSv1.2_2021"
  }
  depends_on = [aws_lb_listener.web]
}
resource "aws_route53_record" "app" {
  count   = local.active_count
  zone_id = data.aws_route53_zone.main.zone_id
  name    = var.hostname
  type    = "A"
  alias {
    name                   = aws_cloudfront_distribution.app[0].domain_name
    zone_id                = aws_cloudfront_distribution.app[0].hosted_zone_id
    evaluate_target_health = false
  }
}
