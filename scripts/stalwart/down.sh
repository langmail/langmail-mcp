#!/usr/bin/env bash
# Stops the throwaway Stalwart started by up.sh and deletes its data, whichever
# way it was started. Safe to run when nothing is running.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
VERSION="$(tr -d '[:space:]' <"$ROOT/.stalwart-version")"

"$HERE/local.sh" clean

if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
	STALWART_VERSION="$VERSION" docker compose -f "$HERE/docker-compose.yml" down -v --remove-orphans
fi
