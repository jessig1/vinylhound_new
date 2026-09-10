#!/usr/bin/env bash
set -euo pipefail

# A just-in-time deploy can find its Aurora cluster in AWS's explicit
# `stopped` state (an administrative stop, e.g. an out-of-band cost-saving
# action) rather than merely paused at zero ACU. A stopped cluster refuses
# connections outright and nothing auto-resumes it, so a migration retrying
# its own connection attempt cannot recover - the cluster has to actually be
# started first. This is unrelated to Aurora Serverless v2's normal 0-ACU
# auto-pause/resume, which stays reachable while "available" and typically
# resumes in well under a minute.

cluster_id="${1:?Usage: $0 <db-cluster-identifier>}"
max_wait_seconds=1200
poll_interval_seconds=15
elapsed=0

status="$(aws rds describe-db-clusters --db-cluster-identifier "$cluster_id" --query 'DBClusters[0].Status' --output text)"
echo "Database cluster $cluster_id status: $status"

if [[ "$status" == "stopped" ]]; then
  echo "Starting stopped database cluster $cluster_id..."
  aws rds start-db-cluster --db-cluster-identifier "$cluster_id" >/dev/null
fi

while [[ "$status" != "available" ]]; do
  case "$status" in
  stopped | starting | backing-up | configuring-iam-database-auth | migrating)
    ;;
  *)
    echo "::error title=Database cluster in unexpected state::$cluster_id reported status '$status', which this script does not know how to wait through." >&2
    exit 1
    ;;
  esac

  if ((elapsed >= max_wait_seconds)); then
    echo "::error title=Database cluster did not become available::Gave up waiting for $cluster_id after ${max_wait_seconds}s (last status: $status)." >&2
    exit 1
  fi

  sleep "$poll_interval_seconds"
  elapsed=$((elapsed + poll_interval_seconds))
  status="$(aws rds describe-db-clusters --db-cluster-identifier "$cluster_id" --query 'DBClusters[0].Status' --output text)"
  echo "Database cluster $cluster_id status: $status (waited ${elapsed}s)"
done

echo "Database cluster $cluster_id is available."
