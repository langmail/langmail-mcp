// Turns a thrown value into the few fields an error log line may carry.
//
// Log lines go to stderr, where an MCP client may show or store them, and
// people paste them into bug reports. Upstream error bodies routinely embed
// the mailbox address that produced them (JMAP/CalDAV echo the principal, tool
// results quote event content), and a fetch error can echo the credential. So
// the raw message is never logged verbatim: the class name and status carry
// the triage signal, and the message is redacted and truncated first.

export interface ErrorDetail {
	errorClass: string;
	errorMessage: string;
	// Upstream HTTP status when the error carries one (JmapError and CalDavError
	// do) — the single most useful triage field after the class.
	status?: number;
}

// Deliberately broad: any `local@host.tld`-shaped run is treated as an address,
// including the ones embedded mid-sentence in an upstream error body.
const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/gu;
// An `Authorization` value (`Bearer <token>`, or `Basic <base64>` for an app
// password) as it appears in a fetch error or an upstream echo.
const CREDENTIAL_RE = /\b(bearer|basic)\s+\S+/giu;
const MAX_MESSAGE_LENGTH = 200;

const redact = (message: string): string =>
	message
		.replace(CREDENTIAL_RE, (_match, scheme: string) =>
			scheme.toLowerCase() === "basic"
				? "Basic [redacted]"
				: "Bearer [redacted]"
		)
		.replace(EMAIL_RE, "[email]");

const truncate = (message: string): string =>
	message.length > MAX_MESSAGE_LENGTH
		? `${message.slice(0, MAX_MESSAGE_LENGTH)}…`
		: message;

const statusOf = (error: unknown): number | undefined => {
	const status = (error as { status?: unknown }).status;
	return typeof status === "number" ? status : undefined;
};

export const describeError = (error: unknown): ErrorDetail => {
	if (!(error instanceof Error)) {
		return {
			errorClass: typeof error,
			errorMessage: truncate(redact(String(error))),
		};
	}
	const status = statusOf(error);
	return {
		errorClass: error.name || error.constructor.name,
		errorMessage: truncate(redact(error.message)),
		...(status === undefined ? {} : { status }),
	};
};
