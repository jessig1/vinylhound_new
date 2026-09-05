resource "aws_sqs_queue" "scan_dead_letter" {
  name                      = "${local.name}-scans-dlq.fifo"
  fifo_queue                = true
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
}

resource "aws_sqs_queue" "scan" {
  name                       = "${local.name}-scans.fifo"
  fifo_queue                 = true
  message_retention_seconds  = 1209600
  visibility_timeout_seconds = 180
  receive_wait_time_seconds  = 20
  sqs_managed_sse_enabled    = true

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.scan_dead_letter.arn
    maxReceiveCount     = 5
  })
}

resource "aws_sqs_queue_redrive_allow_policy" "scan" {
  queue_url = aws_sqs_queue.scan_dead_letter.id
  redrive_allow_policy = jsonencode({
    redrivePermission = "byQueue"
    sourceQueueArns   = [aws_sqs_queue.scan.arn]
  })
}
