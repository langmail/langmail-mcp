// The server's logger: pino, writing to STDERR only.
//
// stdout belongs to the stdio transport — one stray byte there corrupts the
// JSON-RPC stream — so nothing in this process may log to it. There are no
// other destinations: no log shipping, no error tracking, no files.

import { createHash } from "node:crypto";
import pino from "pino";

const STDERR_FD = 2;
const HASH_LENGTH = 12;

const LEVELS: ReadonlySet<string> = new Set([
	"fatal",
	"error",
	"warn",
	"info",
	"debug",
	"trace",
	"silent",
]);

// Quiet unless something is wrong: an MCP client shows or stores whatever a
// stdio server writes to stderr. `LOG_LEVEL=info` adds one line per tool call.
export const DEFAULT_LOG_LEVEL = "warn";

/**
 * Normalizes a `LOG_LEVEL` value to a pino level. Pino level strings are
 * case-sensitive and an unknown one throws at start-up, so the input is
 * lowercased and an unknown value falls back to the default with a note on
 * stderr.
 */
export const resolveLevel = (raw: string | undefined): pino.LevelWithSilent => {
	const level = raw?.trim().toLowerCase();
	if (!level) {
		return DEFAULT_LOG_LEVEL;
	}
	if (LEVELS.has(level)) {
		return level as pino.LevelWithSilent;
	}
	process.stderr.write(
		`langmail-mcp: unknown LOG_LEVEL "${raw}", falling back to "${DEFAULT_LOG_LEVEL}"\n`
	);
	return DEFAULT_LOG_LEVEL;
};

// Synchronous writes: an async destination loses buffered lines when the
// process exits, and a line per tool call costs nothing at this volume.
// `base: undefined` leaves pid and hostname out of every line.
export const logger: pino.Logger = pino(
	{ base: undefined, level: resolveLevel(process.env.LOG_LEVEL) },
	pino.destination({ dest: STDERR_FD, sync: true })
);

// A short, stable stand-in for an address (or any other identifying token) in
// a log line: lines can be correlated without carrying the plaintext.
export const hashEmail = (email: string): string =>
	createHash("sha256")
		.update(email.toLowerCase())
		.digest("hex")
		.slice(0, HASH_LENGTH);
