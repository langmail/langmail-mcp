// How a bind address (`MCP_HOST`) is told apart and spelled.

const LOOPBACK_V4_RE = /^127(?:\.\d{1,3}){3}$/u;
const BRACKETS_RE = /^\[|\]$/gu;

/** Whether a bind address is reachable from this machine only. */
export const isLoopbackHost = (host: string): boolean => {
	const bare = host.replace(BRACKETS_RE, "").toLowerCase();
	return bare === "localhost" || bare === "::1" || LOOPBACK_V4_RE.test(bare);
};

/** A host the way a URL (and the Host header) spells it: an IPv6 address in brackets. */
export const urlHostname = (host: string): string =>
	host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
