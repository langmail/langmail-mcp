// Thin glue over `tsdav`: RFC 6764 discovery + calendar listing + event
// PUT, each authenticated with the request's bearer. A fresh, stateless
// call per request — same model as the JMAP wrappers in jmap/email.ts.
//
// The transport details (well-known redirect to /dav/cal, principal ->
// calendar-home-set -> calendars) live inside tsdav; we only thread the
// bearer through and reshape the result into our CalendarSummary /
// DiscoveredAccount types.

import type { DAVAccount, DAVCalendar } from 'tsdav'
import { createAccount, createCalendarObject, fetchCalendarUserAddresses } from 'tsdav'

import type { CalendarSummary, DiscoveredAccount } from './types.ts'

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
