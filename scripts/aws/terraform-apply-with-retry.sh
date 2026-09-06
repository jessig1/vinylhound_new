#!/usr/bin/env bash
set -euo pipefail

terraform_directory="${1:?Usage: terraform-apply-with-retry.sh <terraform-directory> [terraform apply arguments...]}"
shift

max_attempts=3

for attempt in {1..3}; do
  if terraform -chdir="$terraform_directory" apply -auto-approve "$@"; then
    exit 0
  fi

  if ((attempt == max_attempts)); then
    echo "Terraform apply failed after ${max_attempts} attempts." >&2
    exit 1
  fi

  delay_seconds=$((attempt * 20))
  echo "::warning title=Retrying Terraform apply::Attempt ${attempt} failed; retrying in ${delay_seconds}s to allow AWS eventual consistency to settle."
  sleep "$delay_seconds"
done
