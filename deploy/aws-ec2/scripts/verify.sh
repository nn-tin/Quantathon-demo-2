#!/usr/bin/env bash
set -euo pipefail

PUBLIC_HOST="${1:-127.0.0.1}"
SCHEME="${SCHEME:-http}"

nvidia-smi
printf '\nHost health response:\n'
curl -fsS "$SCHEME://$PUBLIC_HOST/api/health"
printf '\n\nDeployment metadata:\n'
curl -fsS "$SCHEME://$PUBLIC_HOST/api/deployment"
printf '\n'
