// Shared by the live Stalwart suites (`bun run test:stalwart`). Stalwart 1.0
// indexes for search asynchronously: a write turns up in (or drops out of) a
// text, `from` or `email` query a moment after it returns, not at once. A step
// that reads through the index after an earlier write waits for it here rather
// than racing it.
//
// It throws once the 5 s budget is spent, naming what it waited for, so a
// suite fails on the wait that never settled rather than on a later assertion
// that only shows its symptom — or not at all, when the caller asserts nothing.
export const untilIndexed = async <T>(
  read: () => Promise<T>,
  settled: (value: T) => boolean,
  waitingFor: string
): Promise<T> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const value = await read()
    if (settled(value)) {
      return value
    }
    await Bun.sleep(100)
  }
  throw new Error(`search index never caught up: ${waitingFor}`)
}
