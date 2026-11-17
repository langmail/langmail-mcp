#!/usr/bin/env bash
# Starts a throwaway Stalwart on http://127.0.0.1:9090 and bootstraps it for
# the e2e suites. Safe to run again: a running, bootstrapped server is left
# as it is.
#
#   scripts/stalwart/up.sh                               # docker
#   STALWART_BIN=/path/to/stalwart scripts/stalwart/up.sh # release binary
#
# Then: STALWART_ADMIN_URL=http://127.0.0.1:9090 npm run test:e2e
# Stop and delete everything with scripts/stalwart/down.sh.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
VERSION="$(tr -d '[:space:]' <"$ROOT/.stalwart-version")"
PORT="${STALWART_PORT:-9090}"
URL="http://127.0.0.1:$PORT"
CONTAINER="langmail-mcp-stalwart"

if [ -n "${STALWART_BIN:-}" ]; then
	if ! "$STALWART_BIN" --version 2>/dev/null | grep -qF "$VERSION"; then
		echo "warning: $STALWART_BIN is not Stalwart $VERSION (.stalwart-version)" >&2
	fi
	"$HERE/local.sh" start
	export STALWART_RESTART_CMD="$HERE/local.sh restart"
	export STALWART_DATA_DIR="${STALWART_LOCAL_DIR:-${TMPDIR:-/tmp}/langmail-mcp-stalwart}/data"
	export STALWART_HTTP_BIND="127.0.0.1:$PORT"
	show_logs() { tail -n 50 "$(dirname "$STALWART_DATA_DIR")/stalwart.log" >&2 || true; }
else
	if [ "$PORT" != "9090" ]; then
		echo "STALWART_PORT only applies with STALWART_BIN; docker publishes 9090" >&2
		exit 1
	fi
	STALWART_VERSION="$VERSION" docker compose -f "$HERE/docker-compose.yml" up -d
	export STALWART_RESTART_CMD="docker restart $CONTAINER"
	show_logs() { docker logs --tail 50 "$CONTAINER" >&2 || true; }
fi

echo "waiting for Stalwart $VERSION at $URL ..."
ready=""
for _ in $(seq 1 60); do
	code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/jmap/session" || true)
	if [ "$code" = "401" ] || [ "$code" = "200" ]; then
		ready=1
		break
	fi
	sleep 1
done
if [ -z "$ready" ]; then
	echo "Stalwart did not answer at $URL" >&2
	show_logs
	exit 1
fi

# Plain node runs the TypeScript bootstrap: the flag is needed on Node 22
# before 22.18 and is accepted (as a no-op) on later versions.
if ! STALWART_ADMIN_URL="$URL" node --experimental-strip-types --disable-warning=ExperimentalWarning "$HERE/bootstrap.ts"; then
	show_logs
	exit 1
fi
