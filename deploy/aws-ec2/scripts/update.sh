#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/../../.." && pwd)"

cd "$PROJECT_ROOT"
if [[ -d .git ]]; then
  git pull --ff-only
fi
bash deploy/aws-ec2/scripts/deploy.sh
