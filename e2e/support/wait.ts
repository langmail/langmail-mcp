// Waiting for things Stalwart does after a request has returned: search
// indexing, mail delivery, calendar scheduling messages.

export const sleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

interface PollOptions {
	/** Pause between reads. Default 100 ms. */
	intervalMs?: number;
	/** Wall-clock budget, reads included. Default 3000 ms. */
	timeoutMs?: number;
	/** Names the awaited state in the error thrown on timeout. */
	waitingFor: string;
}

/**
 * Reads until `settled` accepts the value and returns it. Throws once the
 * budget is spent, naming what it waited for, so a suite fails on the wait
 * that never settled rather than on a later assertion that only shows its
 * symptom. The read always runs at least once.
 */
export const pollUntil = <T>(
	read: () => Promise<T>,
	settled: (value: T) => boolean,
	options: PollOptions
): Promise<T> => {
	const { intervalMs = 100, timeoutMs = 3000, waitingFor } = options;
	const deadline = Date.now() + timeoutMs;
	const attempt = async (): Promise<T> => {
		const value = await read();
		if (settled(value)) {
			return value;
		}
		if (Date.now() + intervalMs >= deadline) {
			throw new Error(`timed out after ${timeoutMs} ms: ${waitingFor}`);
		}
		await sleep(intervalMs);
		return attempt();
	};
	return attempt();
};

/**
 * Stalwart indexes for search asynchronously: a write turns up in (or drops
 * out of) a text, `from` or `email` query a moment after it returns, not at
 * once. A step that reads through the index after an earlier write waits for
 * it here rather than racing it.
 *
 * Indexing normally takes well under a second. The 3 s default budget stays
 * far inside the e2e test timeout, so this error is the one reported, not a
 * generic timeout.
 */
export const untilIndexed = <T>(
	read: () => Promise<T>,
	settled: (value: T) => boolean,
	waitingFor: string,
	timeoutMs = 3000
): Promise<T> =>
	pollUntil(read, settled, {
		timeoutMs,
		waitingFor: `search index never caught up: ${waitingFor}`,
	});
