// Address classification: relay/machine detection (never become cards) and
// the work/private context split (freemail domains are private, everything
// else is presumed an organization domain).

import { type AddressContext } from './types.ts'

// Machine local parts: bounce plumbing, digest senders, and the no-reply
// family. Anchored on separator boundaries so a human like
// `annareply@…` is not swallowed.
const RELAY_LOCAL_RE =
  /(^|[+._-])(no-?reply|do-?not-?reply|donotreply|mailer-daemon|postmaster|bounces?|notifications?|messaging-digest|newsletters?|digest)([+._-]|$)/iu

// Domains that only ever relay platform traffic — mail from them pairs the
// platform's name with the platform's address, never a person's.
const RELAY_DOMAINS = new Set([
  'amazonses.com',
  'facebookmail.com',
  'glassdoor.com',
  'indeedemail.com',
  'instagram.com',
  'linkedin.com',
  'mailchimpapp.net',
  'mandrillapp.com',
  'medium.com',
  'pinterest.com',
  'redditmail.com',
  'sendgrid.net',
  'substack.com',
  'tiktok.com',
  'twitter.com',
  'x.com',
])

// Freemail (and our own) domains: an address here is a person's private
// address; anything else is presumed a work/organization domain. People who
// use one address for everything make the split a no-op, which is fine.
const PRIVATE_DOMAINS = new Set([
  'aol.com',
  'fastmail.com',
  'freenet.de',
  'gmail.com',
  'gmx.at',
  'gmx.ch',
  'gmx.de',
  'gmx.net',
  'googlemail.com',
  'hotmail.com',
  'hotmail.de',
  'icloud.com',
  'langmail.me',
  'live.com',
  'mac.com',
  'mail.com',
  'me.com',
  'outlook.com',
  'outlook.de',
  'posteo.de',
  'proton.me',
  'protonmail.com',
  't-online.de',
  'web.de',
  'yahoo.com',
  'yahoo.de',
])

export const normalizeAddress = (address: string): string => address.trim().toLowerCase()

const domainOf = (address: string): string => normalizeAddress(address).split('@')[1] ?? ''

const localOf = (address: string): string => normalizeAddress(address).split('@')[0] ?? ''

// The domain itself or any parent domain (bounce.linkedin.com → linkedin.com).
const inDomainSet = (domain: string, set: ReadonlySet<string>): boolean => {
  let d = domain
  while (d) {
    if (set.has(d)) {
      return true
    }
    const dot = d.indexOf('.')
    if (dot === -1) {
      return false
    }
    d = d.slice(dot + 1)
  }
  return false
}

export const isRelayAddress = (address: string): boolean =>
  RELAY_LOCAL_RE.test(localOf(address)) || inDomainSet(domainOf(address), RELAY_DOMAINS)

export const classifyContext = (address: string): AddressContext =>
  inDomainSet(domainOf(address), PRIVATE_DOMAINS) ? 'private' : 'work'
