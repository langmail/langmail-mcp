// Shared JMAP live-deps plumbing: a per-credential session cache plus the
// account-id resolution every JMAP call needs, shared by every tool.

import { accountIdForMail, fetchSession } from "./session.ts";
import type { JmapSession } from "./types.ts";

export interface JmapLive {
	getSession: (authorization: string) => Promise<JmapSession>;
	resolveAccountId: (authorization: string) => Promise<string>;
}

export const makeJmapLive = (stalwartUrl: string): JmapLive => {
	// Cache by the Authorization header value (single process). The JMAP
	// session resource is stable for a mailbox's lifetime.
	const sessionByAuthorization = new Map<string, JmapSession>();

	const getSession = async (authorization: string): Promise<JmapSession> => {
		const hit = sessionByAuthorization.get(authorization);
		if (hit) {
			return hit;
		}
		const session = await fetchSession(stalwartUrl, authorization);
		sessionByAuthorization.set(authorization, session);
		return session;
	};

	return {
		getSession,
		resolveAccountId: async (authorization) =>
			accountIdForMail(await getSession(authorization)),
	};
};
