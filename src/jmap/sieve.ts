// Typed JMAP wrappers for the SieveScript capability (RFC 9661) — the
// storage surface behind persistent mail rules. A mailbox holds at most a
// handful of scripts (Stalwart allows one *active* script), so the read
// side is a single SieveScript/get with `ids: null` (fetch all).
//
// Script content itself is a blob: upload via `blobUpload` first, then
// reference the blobId here. Activation rides on SieveScript/set's
// `onSuccessActivateScript` argument (RFC 9661 §2.3) so create/update and
// activation are one atomic call.

import { type JmapCall, jmapCall, methodResponse } from "./request.ts";
import { JmapError } from "./session.ts";

const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:sieve"];

export interface SieveScriptRecord {
	blobId: string;
	id: string;
	isActive: boolean;
	name: string;
}

interface SetError {
	description?: string;
	type?: string;
}

// An invalidScript SetError carries the Sieve compiler diagnostic in
// `description` — the one string that explains a rejected script.
const setErrorDetail = (err: SetError | undefined): string =>
	[err?.type ?? "unknown", err?.description].filter(Boolean).join(" — ");

// --- SieveScript/get -------------------------------------------------------

export interface SieveScriptListParams extends JmapCall {
	accountId: string;
}

export const sieveScriptList = async (
	p: SieveScriptListParams
): Promise<SieveScriptRecord[]> => {
	const resp = await jmapCall(p, {
		methodCalls: [
			["SieveScript/get", { accountId: p.accountId, ids: null }, "0"],
		],
		using: USING,
	});
	const out = methodResponse<{ list?: SieveScriptRecord[] }>(
		resp,
		"SieveScript/get",
		"0"
	);
	return out.list ?? [];
};

// --- SieveScript/set -------------------------------------------------------

export interface SieveScriptCreateParams extends JmapCall {
	accountId: string;
	blobId: string;
	name: string;
}

// Create a script from an uploaded blob and activate it. Returns the
// server-assigned script id.
export const sieveScriptCreate = async (
	p: SieveScriptCreateParams
): Promise<string> => {
	const resp = await jmapCall(p, {
		methodCalls: [
			[
				"SieveScript/set",
				{
					accountId: p.accountId,
					create: { s0: { blobId: p.blobId, name: p.name } },
					onSuccessActivateScript: "#s0",
				},
				"0",
			],
		],
		using: USING,
	});
	const out = methodResponse<{
		created?: { s0?: { id?: string } };
		notCreated?: { s0?: SetError };
	}>(resp, "SieveScript/set", "0");
	const id = out.created?.s0?.id;
	if (!id) {
		throw new JmapError(
			200,
			`SieveScript/set did not create ${p.name}: ${setErrorDetail(out.notCreated?.s0)}`
		);
	}
	return id;
};

export interface SieveScriptUpdateParams extends JmapCall {
	accountId: string;
	blobId: string;
	scriptId: string;
}

// Point an existing script at a new content blob and (re)activate it —
// activating the already-active script is a no-op per RFC 9661.
export const sieveScriptUpdate = async (
	p: SieveScriptUpdateParams
): Promise<void> => {
	const resp = await jmapCall(p, {
		methodCalls: [
			[
				"SieveScript/set",
				{
					accountId: p.accountId,
					onSuccessActivateScript: p.scriptId,
					update: { [p.scriptId]: { blobId: p.blobId } },
				},
				"0",
			],
		],
		using: USING,
	});
	const out = methodResponse<{
		notUpdated?: Record<string, SetError>;
		updated?: Record<string, unknown>;
	}>(resp, "SieveScript/set", "0");
	if (!(out.updated && p.scriptId in out.updated)) {
		throw new JmapError(
			200,
			`SieveScript/set did not update ${p.scriptId}: ${setErrorDetail(out.notUpdated?.[p.scriptId])}`
		);
	}
};
