#!/usr/bin/env bash
set -euo pipefail

limit="${1:-15}"
break_glass="${2:-false}"
start="$(date -u +%Y-%m-01)"
end="$(date -u -d tomorrow +%Y-%m-%d)"
amount="$(aws ce get-cost-and-usage \
  --time-period "Start=$start,End=$end" \
  --granularity MONTHLY \
  --metrics UnblendedCost \
  --query 'ResultsByTime[0].Total.UnblendedCost.Amount' \
  --output text 2>/dev/null || echo 0)"

python3 - "$amount" "$limit" "$break_glass" <<'PY'
import sys

amount = float(sys.argv[1] if sys.argv[1] not in {"", "None"} else 0)
limit = float(sys.argv[2])
break_glass = sys.argv[3].lower() == "true"
print(f"Month-to-date AWS spend: ${amount:.2f}; activation guard: ${limit:.2f}")
if amount >= limit and not break_glass:
    raise SystemExit("Activation refused: use the explicit break-glass input after reviewing cost.")
PY
