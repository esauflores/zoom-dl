#!/usr/bin/env bash
# thin wrapper so the old entry point keeps working
exec bun "$(dirname "$0")/src/zoom-dl.ts" "$@"
