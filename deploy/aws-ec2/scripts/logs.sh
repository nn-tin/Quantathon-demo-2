#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
ENV_FILE="$PROJECT_ROOT/deploy/aws-ec2/.env"
sudo docker compose --env-file "$ENV_FILE" \
  -f "$PROJECT_ROOT/deploy/aws-ec2/compose.yaml" logs -f --tail=200 app
