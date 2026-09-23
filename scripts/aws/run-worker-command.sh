#!/usr/bin/env bash
set -euo pipefail

operation="${1:-}"
# --experimental-transform-types: an ECS containerOverrides command replaces
# the image's own CMD entirely (Dockerfile.worker's CMD, not ENTRYPOINT), so
# this flag must be repeated here or the cross-package .ts resolution these
# scripts also hit (packages/*'s constructor parameter properties, e.g.
# scan-repository.ts's DatabaseCommandError) throws
# ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX in Node's default strip-only mode — see
# Dockerfile.worker's own CMD comment for the full explanation. Found live
# via P4.3 Task 3's staging cutover (the first real migrate invocation
# staging has ever run), not by inspection.
case "$operation" in
  migrate)
    command_json='["node","--experimental-transform-types","apps/worker/dist/migrate.js"]'
    ;;
  drain-check)
    command_json='["node","--experimental-transform-types","apps/worker/dist/ops.js","drain-check"]'
    ;;
  reconcile-queue)
    command_json='["node","--experimental-transform-types","apps/worker/dist/ops.js","reconcile-queue"]'
    ;;
  rollback)
    # P4.3 Task 4: count defaults to 1 (one migration reversed), matching
    # docs/OPERATIONS.md's "Scan/core schema and role rollback" runbook's
    # own step-by-step (022 alone, then a separate `rollback` call for 021).
    count="${2:-1}"
    command_json="$(jq -cn --arg count "$count" '["node","--experimental-transform-types","apps/worker/dist/rollback.js",$count]')"
    ;;
  validate-fks)
    # P4.3 Task 4: the deployed-environment-compatible VALIDATE CONSTRAINT
    # pass docs/OPERATIONS.md's rollback runbook flagged as "not yet built"
    # -- runs after reversing 022 (step 2) to confirm all eight FKs are
    # clean, or report exactly which have real violations to reconcile.
    command_json='["node","--experimental-transform-types","apps/worker/dist/validate-fks.js"]'
    ;;
  *)
    echo "Usage: $0 <migrate|drain-check|reconcile-queue|rollback|validate-fks> [count]" >&2
    exit 64
    ;;
esac

cluster="$(terraform -chdir=infra/terraform/environment output -raw ecs_cluster_name)"
task_definition="$(terraform -chdir=infra/terraform/environment output -raw worker_task_definition_arn)"
security_group="$(terraform -chdir=infra/terraform/environment output -raw worker_security_group_id)"
subnets="$(terraform -chdir=infra/terraform/environment output -json private_subnet_ids | jq -r 'join(",")')"
overrides="$(jq -cn --argjson command "$command_json" '{containerOverrides:[{name:"worker",command:$command}]}')"

max_attempts=4
for attempt in $(seq 1 "$max_attempts"); do
  task_arn="$(aws ecs run-task \
    --cluster "$cluster" \
    --task-definition "$task_definition" \
    --capacity-provider-strategy capacityProvider=FARGATE,weight=1 \
    --network-configuration "awsvpcConfiguration={subnets=[$subnets],securityGroups=[$security_group],assignPublicIp=DISABLED}" \
    --overrides "$overrides" \
    --query 'tasks[0].taskArn' \
    --output text)"

  if [[ -z "$task_arn" || "$task_arn" == "None" ]]; then
    echo "ECS did not start the $operation task." >&2
    exit 1
  fi

  aws ecs wait tasks-stopped --cluster "$cluster" --tasks "$task_arn"
  exit_code="$(aws ecs describe-tasks \
    --cluster "$cluster" \
    --tasks "$task_arn" \
    --query 'tasks[0].containers[?name==`worker`].exitCode | [0]' \
    --output text)"
  reason="$(aws ecs describe-tasks \
    --cluster "$cluster" \
    --tasks "$task_arn" \
    --query 'tasks[0].stoppedReason' \
    --output text)"

  echo "$operation task $task_arn stopped with exit code $exit_code: $reason"

  if [[ "$exit_code" == "0" ]]; then
    exit 0
  fi

  # A real application failure reports a numeric non-zero exit code. A task
  # that never started its container (e.g. a freshly created NAT gateway not
  # yet routing ECR pulls) reports no exit code at all and a provisioning
  # failure reason instead - that case is worth retrying, a real migration
  # failure is not.
  if [[ "$exit_code" != "None" && "$exit_code" != "null" ]]; then
    exit 1
  fi
  if [[ "$reason" != *"CannotPullContainerError"* ]]; then
    exit 1
  fi
  if ((attempt == max_attempts)); then
    echo "::error title=ECS task provisioning failed::Gave up after ${max_attempts} attempts." >&2
    exit 1
  fi

  delay_seconds=$((attempt * 30))
  echo "::warning title=Retrying $operation task::Container provisioning failed (attempt ${attempt}); retrying in ${delay_seconds}s to allow AWS networking to settle."
  sleep "$delay_seconds"
done
