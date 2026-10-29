// Shared by the live Stalwart suites (`bun run test:stalwart`). Stalwart 1.0
// indexes for search asynchronously: a write turns up in (or drops out of) a
// text, `from` or `email` query a moment after it returns, not at once. A step
// that reads through the index after an earlier write waits for it here rather
// than racing it.
//
// It throws once 3 s of wall clock are spent, reads included, naming what it
// waited for, so a suite fails on the wait that never settled rather than on a
// later assertion that only shows its symptom — or not at all, when the caller
// asserts nothing. The budget stays inside bun's 5 s hook and test timeout, or
// bun's generic timeout would fire first and hide this message.
export const untilIndexed = async <T>(
  read: () => Promise<T>,
  settled: (value: T) => boolean,
  waitingFor: string
): Promise<T> => {
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const value = await read()
    if (settled(value)) {
      return value
    }
    await Bun.sleep(100)
  }
  throw new Error(`search index never caught up: ${waitingFor}`)
}
