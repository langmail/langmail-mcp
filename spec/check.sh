#!/usr/bin/env bash
# Model-check SendProtocol.tla with TLC. Needs Java 11+ and network access on
# the first run, to fetch the pinned tla2tools.jar into a local cache.
#
#   ./check.sh
#
# Two runs: the model itself, which must find no error, and a non-vacuity run,
# which must find a message being sent — a spec that can never send anything
# satisfies every "at most once" property trivially.
set -euo pipefail

TLA_VERSION=1.7.4
TLA_SHA256=936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88

here="$(cd "$(dirname "$0")" && pwd)"
cache="${XDG_CACHE_HOME:-$HOME/.cache}/langmail/tla-$TLA_VERSION"
jar="$cache/tla2tools.jar"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if [[ ! -f "$jar" ]]; then
  mkdir -p "$cache"
  curl -sSLf -o "$jar.tmp" "https://github.com/tlaplus/tlaplus/releases/download/v$TLA_VERSION/tla2tools.jar"
  mv "$jar.tmp" "$jar"
fi
echo "$TLA_SHA256  $jar" | sha256sum -c --quiet -

tlc() {
  java -XX:+UseParallelGC -cp "$jar" tlc2.TLC -workers auto -cleanup -metadir "$work/states" "$@" MCSendProtocol
}

cd "$here"

echo "== SendProtocol: safety and liveness"
if ! tlc -config MCSendProtocol.cfg | tee "$work/main.log" | grep -v '^Picked up JAVA_TOOL_OPTIONS'; then
  echo "TLC failed" >&2
  exit 1
fi
grep -q '^Model checking completed. No error has been found.' "$work/main.log"

echo "== SendProtocol: non-vacuity (NothingEverSent must be violated)"
sed '/^INVARIANTS/,$d' MCSendProtocol.cfg > "$work/vacuity.cfg"
echo 'INVARIANT NothingEverSent' >> "$work/vacuity.cfg"
tlc -config "$work/vacuity.cfg" > "$work/vacuity.log" 2>&1 || true
if ! grep -q 'Invariant NothingEverSent is violated' "$work/vacuity.log"; then
  cat "$work/vacuity.log" >&2
  echo "the model never sends a message — its properties hold vacuously" >&2
  exit 1
fi
echo "ok"
