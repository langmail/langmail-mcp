// Renders a calendar share's feed: the iCalendar document Google Calendar,
// Apple Calendar and Outlook subscribe to. Pure in/out over the occurrences
// agenda.ts expands, so every level rule is testable without a server.
//
// Each occurrence goes out as its own VEVENT with an opaque UID, so free,
// cancelled, declined and private apply to each one on its own; a series is
// never passed through with its RRULE (a dropped override would bring back
// the master's occurrence). Timed events go out in UTC, all-day ones as dates.

import { createHash } from 'node:crypto'

import { type AgendaEntry, entryEndMs } from '../caldav/agenda.ts'

export type ShareLevel = 'busy' | 'full'

export interface FeedInput {
  entries: AgendaEntry[]
  level: ShareLevel
  // The calendar's display name, the only name the feed carries.
  name: string
  now: Date
  // The owner's address, to find the owner's own reply among the attendees.
  ownerAddress: string
  // Seeds the opaque UIDs, so two shares of one calendar don't share UIDs.
  shareId: string
}

const PRODID = '-//Langmail//Calendar share//EN'
const UID_DOMAIN = 'calendar-share.langmail.me'

// The name of a feed that shows nothing: an unknown or stopped link, or a
// calendar that is gone. Identical for all three, so the response tells a
// holder of the link nothing about which it is.
export const EMPTY_FEED_NAME = 'Calendar'

const PRIVATE_CLASSES = new Set(['PRIVATE', 'CONFIDENTIAL'])

// RFC 5545 §3.3.11 TEXT escaping.
const escapeText = (value: string): string =>
  value
    .replace(/\\/gu, '\\\\')
    .replace(/;/gu, '\\;')
    .replace(/,/gu, '\\,')
    .replace(/\r\n|[\r\n]/gu, '\\n')

// A parameter value: quoted, with the characters a quoted value can't hold
// dropped (RFC 5545 §3.2).
const paramValue = (value: string): string => `"${value.replace(/["\r\n]/gu, '')}"`

// RFC 5545 §3.1: lines longer than 75 octets are folded, without splitting a
// UTF-8 sequence.
const encoder = new TextEncoder()
const fold = (line: string): string => {
  if (encoder.encode(line).length <= 75) {
    return line
  }
  const parts: string[] = []
  let current = ''
  let size = 0
  for (const char of line) {
    const charSize = encoder.encode(char).length
    // The first line holds 75 octets, each continuation 74 after its space.
    if (size + charSize > (parts.length === 0 ? 75 : 74)) {
      parts.push(current)
      current = ''
      size = 0
    }
    current += char
    size += charSize
  }
  parts.push(current)
  return parts.join('\r\n ')
}

// What an ISO 8601 instant has beyond iCalendar's basic form: separators and
// milliseconds.
const NOT_BASIC_RE = /[-:]|\.\d{3}/gu

const utcStamp = (ms: number): string => new Date(ms).toISOString().replace(NOT_BASIC_RE, '')

const dateValue = (isoDate: string): string => isoDate.slice(0, 10).replace(NOT_BASIC_RE, '')

// DTSTART/DTEND: dates for an all-day entry, UTC date-times otherwise.
const timeLines = (entry: AgendaEntry): string[] => {
  const { event } = entry
  if (event.allDay) {
    // DTEND, else DURATION, else one day (entryEndMs).
    const end = event.end === '' ? new Date(entryEndMs(entry)).toISOString() : event.end
    return [`DTSTART;VALUE=DATE:${dateValue(event.start)}`, `DTEND;VALUE=DATE:${dateValue(end)}`]
  }
  return [`DTSTART:${utcStamp(entry.startMs)}`, `DTEND:${utcStamp(entryEndMs(entry))}`]
}

const opaqueUid = (shareId: string, entry: AgendaEntry): string => {
  const hash = createHash('sha256')
    .update(`${shareId}\n${entry.event.uid}\n${entry.event.recurrenceId ?? ''}`)
    .digest('hex')
  return `${hash.slice(0, 32)}@${UID_DOMAIN}`
}

const ownerDeclined = (entry: AgendaEntry, ownerAddress: string): boolean => {
  const owner = ownerAddress.toLowerCase()
  return entry.event.attendees.some((a) => a.email.toLowerCase() === owner && a.status?.toUpperCase() === 'DECLINED')
}

// The level one entry is shown at: a private or confidential event never shows
// more than busy, whatever the share's level.
const entryLevel = (entry: AgendaEntry, level: ShareLevel): ShareLevel =>
  level === 'full' && !PRIVATE_CLASSES.has(entry.event.classification ?? '') ? 'full' : 'busy'

// Whether the entry appears at all. Cancelled events and those the owner
// declined never do; free time doesn't appear as busy.
//
// Nor does a series agenda.ts could not expand into occurrences (a sub-daily
// or unreadable rule, a zone that is neither IANA nor a Windows name): passed through with
// its rule it would bring back cancelled occurrences and show moved ones twice.
const isShown = (entry: AgendaEntry, level: ShareLevel, ownerAddress: string): boolean => {
  if (
    entry.unexpanded ||
    Number.isNaN(entry.startMs) ||
    entry.event.status === 'CANCELLED' ||
    ownerDeclined(entry, ownerAddress)
  ) {
    return false
  }
  return level === 'full' || entry.event.showAs !== 'free'
}

const detailLines = (entry: AgendaEntry): string[] => {
  const { event } = entry
  return [
    `SUMMARY:${escapeText(event.title)}`,
    ...(event.location ? [`LOCATION:${escapeText(event.location)}`] : []),
    ...(event.description ? [`DESCRIPTION:${escapeText(event.description)}`] : []),
    ...event.attendees.map(
      (a) =>
        `ATTENDEE${a.name ? `;CN=${paramValue(a.name)}` : ''}${a.status ? `;PARTSTAT=${a.status.toUpperCase()}` : ''}:mailto:${a.email}`
    ),
    `TRANSP:${event.showAs === 'free' ? 'TRANSPARENT' : 'OPAQUE'}`,
  ]
}

const eventLines = (entry: AgendaEntry, input: FeedInput, stamp: string): string[] => {
  const level = entryLevel(entry, input.level)
  return [
    'BEGIN:VEVENT',
    `UID:${opaqueUid(input.shareId, entry)}`,
    `DTSTAMP:${stamp}`,
    ...timeLines(entry),
    ...(level === 'full' ? detailLines(entry) : ['SUMMARY:Busy', 'TRANSP:OPAQUE']),
    'END:VEVENT',
  ]
}

const document = (name: string, events: string[]): string =>
  [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `NAME:${escapeText(name)}`,
    `X-WR-CALNAME:${escapeText(name)}`,
    // RFC 7986 for the apps that honour it, and Outlook's own hint.
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
    ...events,
    'END:VCALENDAR',
  ]
    .map(fold)
    .join('\r\n')
    .concat('\r\n')

export const renderFeed = (input: FeedInput): string => {
  const stamp = utcStamp(input.now.getTime())
  // Every component of a series that could not be expanded goes with it: an
  // override whose RECURRENCE-ID could not be read was never completed from
  // its master, so it carries none of the series' CLASS.
  const unexpanded = new Set(input.entries.filter((e) => e.unexpanded).map((e) => e.event.uid))
  const events = input.entries
    .filter((entry) => !unexpanded.has(entry.event.uid))
    .filter((entry) => isShown(entry, entryLevel(entry, input.level), input.ownerAddress))
    .sort((a, b) => a.startMs - b.startMs)
    .flatMap((entry) => eventLines(entry, input, stamp))
  return document(input.name, events)
}

export const renderEmptyFeed = (): string => document(EMPTY_FEED_NAME, [])
