#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"
COMPOSE_FILE="$PROJECT_ROOT/deploy/aws-ec2/compose.yaml"
ENV_FILE="$PROJECT_ROOT/deploy/aws-ec2/.env"

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$PROJECT_ROOT/deploy/aws-ec2/.env.example" "$ENV_FILE"
fi

cd "$PROJECT_ROOT"
sudo docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --build

echo "Waiting for the application health endpoint..."
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1/api/health >/tmp/quantum-uc-health.json 2>/dev/null; then
    cat /tmp/quantum-uc-health.json
    echo
    echo "Deployment is healthy."
    exit 0
  fi
  sleep 5
done

echo "Application did not become healthy in time. Recent logs:"
sudo docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" logs --tail=200 app
exit 1
