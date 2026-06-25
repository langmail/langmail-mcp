// Thin glue over `tsdav`: RFC 6764 discovery + calendar listing + event
// PUT, each authenticated with the request's bearer. A fresh, stateless
// call per request — same model as the JMAP wrappers in jmap/email.ts.
//
// The transport details (well-known redirect to /dav/cal, principal ->
// calendar-home-set -> calendars) live inside tsdav; we only thread the
// bearer through and reshape the result into our CalendarSummary /
// DiscoveredAccount types.

import type { DAVAccount, DAVCalendar, DAVCalendarObject } from 'tsdav'
import {
  createAccount,
  createCalendarObject,
  deleteCalendarObject,
  fetchCalendarObjects,
  fetchCalendarUserAddresses,
  updateCalendarObject,
} from 'tsdav'

import { parseEvents } from './ical-parse.ts'
import type { CalendarObject, CalendarSummary, DiscoveredAccount } from './types.ts'

class CalDavError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'CalDavError'
  }
}

export interface CalDavConfig {
  // Stalwart base URL; tsdav discovers /dav/cal via /.well-known/caldav.
  serverUrl: string
}

const DEFAULT_CAL_RE = /\/default\/?$/u
const MAILTO_RE = /^mailto:/iu

const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

// CalDAV collection URLs are canonically trailing-slashed; tsdav resolves
// object URLs via `new URL(filename, url)`, which silently drops the last
// path segment without it. Normalize before comparing or PUTting so the
// membership check and the PUT can't disagree on the same calendar.
export const withTrailingSlash = (url: string): string => (url.endsWith('/') ? url : `${url}/`)

const toSummary = (cal: DAVCalendar): CalendarSummary => ({
  displayName: typeof cal.displayName === 'string' ? cal.displayName : '',
  url: cal.url,
})

// The calendar an unqualified event lands in: Stalwart auto-provisions a
// `.../default/` collection, so prefer that; otherwise the first listed.
export const pickDefaultCalendar = (calendars: CalendarSummary[]): string | null => {
  const def = calendars.find((c) => DEFAULT_CAL_RE.test(c.url))
  return (def ?? calendars[0])?.url ?? null
}

// Resolves the calendar a tool should act on. With no explicit request it
// falls back to the discovered default; an explicit URL must name one of
// the principal's calendars (matched modulo trailing slash). Shared by the
// create/update/delete event tools so they agree on selection + errors.
export type ResolvedCalendar = { ok: true; url: string } | { ok: false; reason: 'none' | 'not-found' }

export const resolveCalendarUrl = (account: DiscoveredAccount, requested?: string): ResolvedCalendar => {
  const url = requested ?? account.defaultCalendarUrl
  if (!url) {
    return { ok: false, reason: 'none' }
  }
  if (requested && !account.calendars.some((c) => withTrailingSlash(c.url) === withTrailingSlash(requested))) {
    return { ok: false, reason: 'not-found' }
  }
  return { ok: true, url }
}

// The principal's `mailto:` calendar-user-address as a bare email.
// calendar-user-address-set (RFC 6638) can list several hrefs — often
// the principal URL alongside the mailto — so we must pick the mailto
// one specifically; a non-mailto organizer would break iMIP routing.
export const pickOrganizer = (addresses: string[]): string | null => {
  const mail = addresses.find((a) => MAILTO_RE.test(a))
  return mail ? mail.replace(MAILTO_RE, '') : null
}

const loadAccount = (cfg: CalDavConfig, token: string): Promise<DAVAccount> =>
  createAccount({
    account: { accountType: 'caldav', serverUrl: cfg.serverUrl },
    headers: bearer(token),
    loadCollections: true,
  })

export const fetchCalendarList = async (cfg: CalDavConfig, token: string): Promise<CalendarSummary[]> => {
  const account = await loadAccount(cfg, token)
  return (account.calendars ?? []).map(toSummary)
}

export const discoverAccount = async (cfg: CalDavConfig, token: string): Promise<DiscoveredAccount> => {
  const account = await loadAccount(cfg, token)
  const addresses = await fetchCalendarUserAddresses({ account, headers: bearer(token) })
  const calendars = (account.calendars ?? []).map(toSummary)
  return {
    calendars,
    defaultCalendarUrl: pickDefaultCalendar(calendars),
    organizer: pickOrganizer(addresses),
  }
}

export interface PutEventParams {
  calendarUrl: string
  ical: string
  token: string
  uid: string
}

export const putEvent = async (p: PutEventParams): Promise<void> => {
  const res = await createCalendarObject({
    calendar: { url: withTrailingSlash(p.calendarUrl) },
    filename: `${p.uid}.ics`,
    headers: bearer(p.token),
    iCalString: p.ical,
  })
  if (!res.ok) {
    throw new CalDavError(res.status, `caldav PUT returned ${res.status}`)
  }
}

// tsdav stringifies a missing getetag as the literal "undefined"; treat
// that as no ETag so we never send a bogus `If-Match: undefined`.
const normalizeEtag = (etag?: string): string | undefined => (etag && etag !== 'undefined' ? etag : undefined)

// Reshapes a tsdav object into our CalendarObject, dropping anything the
// server returned without calendar data (e.g. a 404'd multiget href).
const toCalendarObject = (obj: DAVCalendarObject): CalendarObject | null => {
  if (typeof obj.data !== 'string' || obj.data.length === 0) {
    return null
  }
  const etag = normalizeEtag(obj.etag)
  return { data: obj.data, url: obj.url, ...(etag ? { etag } : {}) }
}

export interface FetchEventsParams {
  calendarUrl: string
  // Optional inclusive window; without it every event in the calendar is
  // returned. Both bounds are iCalendar-style UTC or ISO 8601 strings.
  timeRange?: { end: string; start: string }
  token: string
}

// Lists the event objects in a calendar (optionally bounded by a time
// range) so the agent can discover UIDs to update/delete.
export const fetchEvents = async (p: FetchEventsParams): Promise<CalendarObject[]> => {
  const objects = await fetchCalendarObjects({
    calendar: { url: withTrailingSlash(p.calendarUrl) },
    headers: bearer(p.token),
    ...(p.timeRange ? { timeRange: p.timeRange } : {}),
  })
  return objects.map(toCalendarObject).filter((o): o is CalendarObject => o !== null)
}

export interface FetchEventParams {
  calendarUrl: string
  token: string
  uid: string
}

// Finds the stored object holding a given iCalendar UID among a collection's
// objects. CalDAV resource names are server-assigned and need NOT equal the
// UID (only events created by our own tool happen to be named `${uid}.ics`),
// so we match on the parsed VEVENT UID rather than guessing the filename.
export const findEventObject = (objects: CalendarObject[], uid: string): CalendarObject | null =>
  objects.find((o) => parseEvents(o.data).some((e) => e.uid === uid)) ?? null

// Fetches the single event object carrying `uid`. Lists the collection and
// matches by UID (see findEventObject) so it works regardless of how the
// object was named — including events synced in from other clients. Returns
// null when no object carries the UID, surfaced as a friendly "not found".
export const fetchEvent = async (p: FetchEventParams): Promise<CalendarObject | null> => {
  const objects = await fetchEvents({ calendarUrl: p.calendarUrl, token: p.token })
  return findEventObject(objects, p.uid)
}

export interface UpdateEventParams {
  etag?: string
  ical: string
  token: string
  url: string
}

export const updateEvent = async (p: UpdateEventParams): Promise<void> => {
  const res = await updateCalendarObject({
    calendarObject: { data: p.ical, etag: p.etag, url: p.url },
    headers: bearer(p.token),
  })
  if (!res.ok) {
    throw new CalDavError(res.status, `caldav PUT returned ${res.status}`)
  }
}

export interface DeleteEventParams {
  etag?: string
  token: string
  url: string
}

export const deleteEvent = async (p: DeleteEventParams): Promise<void> => {
  const res = await deleteCalendarObject({
    calendarObject: { data: '', etag: p.etag, url: p.url },
    headers: bearer(p.token),
  })
  if (!res.ok) {
    throw new CalDavError(res.status, `caldav DELETE returned ${res.status}`)
  }
}
