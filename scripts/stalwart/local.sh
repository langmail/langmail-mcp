#!/usr/bin/env bash
# Runs a Stalwart release binary as a throwaway server on 127.0.0.1:9090, for
# machines without docker. It is the binary counterpart of docker-compose.yml:
# same environment, same admin login, same address.
#
#   STALWART_BIN=/path/to/stalwart scripts/stalwart/local.sh start|stop|restart|status|logs|clean
#
# Normally you call `up.sh` and `down.sh` instead, which also bootstrap.
#
# Environment:
#   STALWART_BIN        the binary (required for start and restart)
#   STALWART_LOCAL_DIR  where config, data, log and pid file live
#                       (default: ${TMPDIR:-/tmp}/langmail-mcp-stalwart)
#   STALWART_PORT       HTTP port (default 9090)
#   STALWART_RECOVERY_MODE=1  start in recovery mode: only the admin HTTP
#                       listener, on STALWART_PORT. The bootstrap uses it once,
#                       to replace the default listeners (ports 25, 443, 993,
#                       8080 and others on every interface) before they open.
set -euo pipefail

DIR="${STALWART_LOCAL_DIR:-${TMPDIR:-/tmp}/langmail-mcp-stalwart}"
PORT="${STALWART_PORT:-9090}"
PID_FILE="$DIR/stalwart.pid"
LOG_FILE="$DIR/stalwart.log"

running_pid() {
	[ -f "$PID_FILE" ] || return 1
	local pid
	pid=$(cat "$PID_FILE")
	[ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || return 1
	echo "$pid"
}

start() {
	if pid=$(running_pid); then
		echo "stalwart already running (pid $pid)"
		return 0
	fi
	if [ -z "${STALWART_BIN:-}" ] || [ ! -x "$STALWART_BIN" ]; then
		echo "STALWART_BIN must point at an executable Stalwart binary" >&2
		exit 1
	fi
	mkdir -p "$DIR/etc" "$DIR/data"
	# The image runs `stalwart --config /etc/stalwart/config.json` with the data
	# directory as working directory. A missing config file means first boot:
	# Stalwart then serves only the setup API, on STALWART_RECOVERY_MODE_PORT,
	# and writes the file when the bootstrap completes.
	(
		cd "$DIR/data"
		STALWART_RECOVERY_ADMIN="admin:devpassword" \
			STALWART_HOSTNAME="127.0.0.1" \
			STALWART_PUBLIC_URL="http://127.0.0.1:$PORT" \
			STALWART_RECOVERY_MODE_PORT="$PORT" \
			nohup "$STALWART_BIN" --config "$DIR/etc/config.json" >>"$LOG_FILE" 2>&1 &
		echo $! >"$PID_FILE"
	)
	echo "stalwart started (pid $(cat "$PID_FILE"), log $LOG_FILE)"
}

stop() {
	if ! pid=$(running_pid); then
		rm -f "$PID_FILE"
		echo "stalwart not running"
		return 0
	fi
	kill "$pid"
	for _ in $(seq 1 50); do
		kill -0 "$pid" 2>/dev/null || break
		sleep 0.2
	done
	if kill -0 "$pid" 2>/dev/null; then
		kill -9 "$pid"
	fi
	rm -f "$PID_FILE"
	echo "stalwart stopped"
}

case "${1:-}" in
start) start ;;
stop) stop ;;
restart)
	stop
	start
	;;
status)
	if pid=$(running_pid); then
		echo "running (pid $pid, dir $DIR)"
	else
		echo "stopped"
		exit 1
	fi
	;;
logs) cat "$LOG_FILE" ;;
clean)
	stop
	rm -rf "$DIR"
	echo "removed $DIR"
	;;
*)
	echo "usage: $0 start|stop|restart|status|logs|clean" >&2
	exit 2
	;;
esac
