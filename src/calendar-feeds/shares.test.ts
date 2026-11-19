import { afterEach, describe, expect, test } from 'bun:test'

import { type InternalAuthStub, startInternalAuthStub } from '../test-support/internal-auth-stub.ts'
import { findShareBySecretHash } from './live-deps.ts'
import { makeCalendarShareStore } from './shares.ts'

const SHARE = { calendarUrl: '/dav/cal/ana%40example.com/personal/', id: 'share-1', label: 'Sam', level: 'busy' }
const ok = (body: unknown) => Response.json(body)
const noContent = () => new Response(null, { status: 204 })

describe('calendar share store over Auth', () => {
  let stub: InternalAuthStub | undefined
  afterEach(() => stub?.stop())

  test("sends each operation with the caller's user id", async () => {
    stub = startInternalAuthStub((path) => (path.endsWith('/list') ? ok({ shares: [SHARE] }) : noContent()))
    const store = makeCalendarShareStore(stub.auth)

    await store.create('user-1', { calendarUrl: SHARE.calendarUrl, label: 'Sam', level: 'busy', secretHash: 'h' })
    expect(await store.list('user-1')).toEqual([{ ...SHARE, level: 'busy' }])
    await store.setLevel('user-1', 'share-1', 'full')
    await store.remove('user-1', ['share-1'])
    await store.remove('user-1', [])

    expect(stub.requests.map(({ body, path }) => ({ body, path }))).toEqual([
      {
        body: { calendarUrl: SHARE.calendarUrl, label: 'Sam', level: 'busy', secretHash: 'h', userId: 'user-1' },
        path: '/internal/calendar-shares/create',
      },
      { body: { userId: 'user-1' }, path: '/internal/calendar-shares/list' },
      { body: { id: 'share-1', level: 'full', userId: 'user-1' }, path: '/internal/calendar-shares/set-level' },
      { body: { ids: ['share-1'], userId: 'user-1' }, path: '/internal/calendar-shares/remove' },
    ])
    expect(stub.requests.every((r) => r.authorization === 'Bearer internal-token')).toBe(true)
  })

  test('a failed call reads the same to the tools, whatever went wrong', async () => {
    stub = startInternalAuthStub(() => new Response(null, { status: 500 }))
    const message = 'the calendar shares could not be read or changed; try again later'
    await expect(makeCalendarShareStore(stub.auth).list('user-1')).rejects.toThrow(message)
    await expect(
      makeCalendarShareStore({ baseUrl: 'http://127.0.0.1:1', internalToken: 'x' }).list('user-1')
    ).rejects.toThrow(message)
  })

  test('the feed finds a share by its secret hash, or nothing', async () => {
    const record = { calendarUrl: SHARE.calendarUrl, id: 'share-1', level: 'full', userId: 'user-1' }
    stub = startInternalAuthStub((_path, body) =>
      ok({ share: (body as { secretHash: string }).secretHash === 'known' ? record : null })
    )
    const findShare = findShareBySecretHash(stub.auth)
    expect(await findShare('known')).toEqual({ ...record, level: 'full' })
    expect(await findShare('unknown')).toBeNull()
    expect(stub.requests[0]?.path).toBe('/internal/calendar-shares/find')
  })
})
