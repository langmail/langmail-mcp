// Shared Email/set PatchObject construction.
//
// Extracted from email.ts once EmailSubmission became the second consumer:
// `onSuccessUpdateEmail` carries the same keyword/mailbox patch shape as a
// plain Email/set update, and the JSON-Pointer escaping has to be identical
// on both paths or a nested-label keyword silently patches the wrong key.

// Escape a keyword or mailbox id for use as an RFC 6901 JSON Pointer token in
// an Email/set PatchObject: `~` and `/` are structural and MUST be escaped
// (`~`→`~0`, `/`→`~1`), order matters (escape `~` first). Mirrors the Rust
// mirror in email-sync's `set_keywords`. Agent `$label:` keywords contain
// neither char, but keeping the escape correct means the same wrapper is safe
// for nested-label keywords too.
const jsonPointerEscape = (token: string): string =>
	token.replaceAll("~", "~0").replaceAll("/", "~1");

// Targeted membership changes for one email: `true` adds, `false` removes. Keys
// are the full JMAP keyword string (`$label:receipt`) or the mailbox id; both
// are JSON-pointer-escaped before hitting the wire. The two maps translate onto
// the wire differently (see `buildEmailSetPatch`): keyword removal follows
// email-sync's production-proven `false` convention, mailbox removal follows the
// RFC 8620 canonical `null`.
export interface EmailSetChanges {
	keywords?: Record<string, boolean>;
	mailboxIds?: Record<string, boolean>;
}

export const buildEmailSetPatch = (
	changes: EmailSetChanges
): Record<string, boolean | null> => {
	const patch: Record<string, boolean | null> = {};
	// Keywords: boolean value, `false` removes. This mirrors email-sync's Rust
	// `set_keywords` byte-for-byte and is production-proven against Stalwart
	// (read-state + label mirroring both drive the `false`=remove path).
	for (const [keyword, value] of Object.entries(changes.keywords ?? {})) {
		patch[`keywords/${jsonPointerEscape(keyword)}`] = value;
	}
	// MailboxIds: `true` adds, `null` removes. RFC 8621 requires mailboxIds map
	// values be `true`, so removal uses the RFC 8620 canonical PatchObject `null`
	// rather than `false` — and unlike keywords there's no proven `false`-removal
	// precedent for mailboxes (Rust only ever replaces the set wholesale).
	for (const [mailboxId, value] of Object.entries(changes.mailboxIds ?? {})) {
		patch[`mailboxIds/${jsonPointerEscape(mailboxId)}`] = value ? true : null;
	}
	return patch;
};
