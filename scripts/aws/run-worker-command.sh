#!/usr/bin/env bash
set -euo pipefail

operation="${1:-}"
case "$operation" in
  migrate)
    command_json='["npm","run","db:migrate","--workspace","@vinylhound/database"]'
    ;;
  drain-check)
    command_json='["node","apps/worker/dist/ops.js","drain-check"]'
    ;;
  reconcile-queue)
    command_json='["node","apps/worker/dist/ops.js","reconcile-queue"]'
    ;;
  *)
    echo "Usage: $0 <migrate|drain-check|reconcile-queue>" >&2
    exit 64
    ;;
esac

cluster="$(terraform -chdir=infra/terraform/environment output -raw ecs_cluster_name)"
task_definition="$(terraform -chdir=infra/terraform/environment output -raw worker_task_definition_arn)"
security_group="$(terraform -chdir=infra/terraform/environment output -raw worker_security_group_id)"
subnets="$(terraform -chdir=infra/terraform/environment output -json private_subnet_ids | jq -r 'join(",")')"
overrides="$(jq -cn --argjson command "$command_json" '{containerOverrides:[{name:"worker",command:$command}]}')"

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
[[ "$exit_code" == "0" ]]
