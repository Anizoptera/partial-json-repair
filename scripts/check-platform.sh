#!/usr/bin/env bash
set -euo pipefail
bun run build >&2
bun scripts/platform-check.ts "$@"
