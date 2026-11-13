// bun test preload (see bunfig.toml): when a test database is configured,
// bring it to the current drizzle migration state once per test run, for the
// activity-record tests. `migrateToLatest` is idempotent and fast.
import { migrateToLatest } from '@langmail/database'

if (process.env.TEST_DATABASE_URL) {
  await migrateToLatest(process.env.TEST_DATABASE_URL)
}
