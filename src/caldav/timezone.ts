import { TZDate } from '@date-fns/tz'
import { z } from 'zod'

const OFFSET_RE = /(?:Z|[+-]\d{2}:\d{2})$/iu
const DATE_TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?:Z|[+-]\d{2}:\d{2})?$/iu

export const UTC_TIME_ZONE = 'UTC'

export const isValidTimeZone = (timeZone: string): boolean => {
  if (timeZone === UTC_TIME_ZONE) {
    return true
  }
  if (Intl.supportedValuesOf('timeZone').includes(timeZone)) {
    return true
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date())
    return true
  } catch {
    return false
  }
}

export const timeZoneSchema = z.string().refine(isValidTimeZone, {
  message: 'timeZone must be a valid IANA timezone, e.g. Europe/Berlin',
})

export const dateTimeWithOptionalOffsetSchema = z.iso.datetime({ offset: true, local: true })

const hasExplicitOffset = (value: string): boolean => OFFSET_RE.test(value)

export const toZonedDate = (instant: Date, timeZone: string): Date =>
  timeZone === UTC_TIME_ZONE ? instant : TZDate.tz(timeZone, instant)

export const parseWallClockInZone = (value: string, timeZone: string): Date => {
  const match = DATE_TIME_RE.exec(value)
  if (!match) {
    throw new Error(`invalid date-time: ${value}`)
  }
  const [, year, month, day, hour, minute, second, millis = '0'] = match
  return TZDate.tz(
    timeZone,
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    Number(millis.padEnd(3, '0'))
  )
}

// An instant re-expressed as a naive wall-clock ISO string in `timeZone` (no
// offset suffix) — the inverse of parseWallClockInZone. Used wherever a stored
// instant has to re-enter the wall-clock pipeline, e.g. an occurrence's original
// start standing in for an omitted `start` on an update.
export const toWallClockIso = (instant: Date, timeZone: string): string => {
  const zoned = TZDate.tz(timeZone, instant)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return (
    `${zoned.getFullYear()}-${pad(zoned.getMonth() + 1)}-${pad(zoned.getDate())}` +
    `T${pad(zoned.getHours())}:${pad(zoned.getMinutes())}:${pad(zoned.getSeconds())}`
  )
}

export const resolveInputDateTime = (value: string, timeZone: string, explicitTimeZone: boolean): Date => {
  if (explicitTimeZone || !hasExplicitOffset(value)) {
    return parseWallClockInZone(value, timeZone)
  }
  return new Date(value)
}
