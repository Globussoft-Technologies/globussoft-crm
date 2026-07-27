#!/bin/bash
# Wrapper to run Prisma Client Go generator from the backend-go module context.
# Prisma invokes this from the backend/ directory, so we switch to backend-go/
# where the go.mod file lives.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/../../backend-go"
SCHEMA_PATH="${PRISMA_SCHEMA_PATH:-../backend/prisma/schema.prisma}"
exec go run github.com/steebchen/prisma-client-go generate --schema "$SCHEMA_PATH" "$@"
