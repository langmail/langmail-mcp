import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { eq, inArray } from 'drizzle-orm'

import { closeDatabaseClient, createDatabaseClient, type DatabaseClient } from '@langmail/database'
import { createUserFactory } from '@langmail/database/factories'
import { user, user_activity } from '@langmail/database/schema'

import { makeAgentActivityRecorder } from './record-agent-activity.ts'

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL

describe.skipIf(!TEST_DATABASE_URL)('agent activity record', () => {
  let db: DatabaseClient
  const created: string[] = []
  beforeAll(() => {
    db = createDatabaseClient(TEST_DATABASE_URL ?? '')
  })
  afterAll(async () => {
    await db.delete(user).where(inArray(user.id, created))
    await closeDatabaseClient(db)
  })

  const createUser = async () => {
    const someone = await createUserFactory(db).create()
    created.push(someone.id)
    return someone
  }

  const rowsFor = (userId: string) =>
    db.select().from(user_activity).where(eq(user_activity.user_id, userId)).orderBy(user_activity.day)

  test('records one row per user and UTC day, however many calls', async () => {
    const someone = await createUser()
    let now = new Date('2026-11-09T23:30:00Z')
    const record = makeAgentActivityRecorder(db, () => now)

    await record(someone.id)
    await record(someone.id)
    await record(someone.id)
    // 00:30 in Berlin is still the 9th in UTC; 00:30 UTC is the next day.
    now = new Date('2026-11-10T00:30:00Z')
    await record(someone.id)

    expect(await rowsFor(someone.id)).toEqual([
      { day: '2026-11-09', surface: 'mcp', user_id: someone.id },
      { day: '2026-11-10', surface: 'mcp', user_id: someone.id },
    ])
  })

  test("deleting the account deletes the user's activity", async () => {
    const someone = await createUser()
    await makeAgentActivityRecorder(db)(someone.id)
    expect(await rowsFor(someone.id)).toHaveLength(1)

    await db.delete(user).where(eq(user.id, someone.id))

    expect(await rowsFor(someone.id)).toEqual([])
  })

  test('a failed write does not throw', async () => {
    // No such user: the foreign key rejects the row.
    await makeAgentActivityRecorder(db)('00000000-0000-4000-8000-000000000000')
  })
})
