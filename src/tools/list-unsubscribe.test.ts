import { describe, expect, test } from 'bun:test'

import { type EmailUnsubscribeRecord } from '@langmail/jmap'

import {
  deliveredTo,
  describeUrl,
  footerLink,
  parseListUnsubscribe,
  scopeNote,
  unfoldHeader,
} from './list-unsubscribe.ts'

const ONE_CLICK = 'List-Unsubscribe=One-Click'

describe('unfoldHeader', () => {
  test('removes CRLF (and bare LF) before whitespace, keeping the whitespace', () => {
    expect(unfoldHeader(' <https://a.example/u>,\r\n <mailto:u@a.example>')).toBe(
      ' <https://a.example/u>, <mailto:u@a.example>'
    )
    expect(unfoldHeader(' <https://a.example/u>,\n\t<mailto:u@a.example>')).toBe(
      ' <https://a.example/u>,\t<mailto:u@a.example>'
    )
  })
})

describe('parseListUnsubscribe', () => {
  test('a folded header with https + mailto and the Post header is one-click', () => {
    const raw =
      ' <https://news.example.com/unsubscribe?u=1&id=2>,\r\n <mailto:leave@news.example.com?subject=unsubscribe>'
    expect(parseListUnsubscribe(raw, ONE_CLICK)).toEqual({
      http: [],
      https: ['https://news.example.com/unsubscribe?u=1&id=2'],
      mailto: [{ address: 'leave@news.example.com', subject: 'unsubscribe' }],
      oneClick: true,
    })
  })

  test('a fold inside the angle brackets is ignored, as RFC 2369 asks', () => {
    const raw = ' <https://news.example.com/unsubscribe/\r\n abc123>'
    expect(parseListUnsubscribe(raw, ONE_CLICK).https).toEqual(['https://news.example.com/unsubscribe/abc123'])
  })

  test('https without the Post header is not one-click', () => {
    expect(parseListUnsubscribe(' <https://news.example.com/u>', null).oneClick).toBe(false)
    expect(parseListUnsubscribe(' <https://news.example.com/u>', 'List-Unsubscribe=Other').oneClick).toBe(false)
  })

  test('http + mailto is never one-click, even with the Post header', () => {
    const parsed = parseListUnsubscribe(
      ' <http://lists.example.org/options/news>,\n <mailto:news-request@lists.example.org?subject=unsubscribe>',
      ONE_CLICK
    )
    expect(parsed.oneClick).toBe(false)
    expect(parsed.http).toEqual(['http://lists.example.org/options/news'])
    expect(parsed.mailto[0]?.address).toBe('news-request@lists.example.org')
  })

  test('mailto-only keeps subject and body', () => {
    const parsed = parseListUnsubscribe(' <mailto:off@shop.example?subject=Remove%20me&body=please>', ONE_CLICK)
    expect(parsed).toEqual({
      http: [],
      https: [],
      mailto: [{ address: 'off@shop.example', body: 'please', subject: 'Remove me' }],
      oneClick: false,
    })
  })

  test('no header yields nothing', () => {
    expect(parseListUnsubscribe(null, null)).toEqual({ http: [], https: [], mailto: [], oneClick: false })
    expect(parseListUnsubscribe(undefined, ONE_CLICK).oneClick).toBe(false)
  })
})

describe('scopeNote', () => {
  test('names an unsubscribe-all link', () => {
    expect(scopeNote('https://hs.example.com/hs/manage-preferences/unsubscribe-all?x=1')).toContain('all marketing')
    expect(scopeNote('https://m.example.com/u?action=unsubscribe_all')).toContain('all marketing')
  })

  test('says nothing about an ordinary list link', () => {
    expect(scopeNote('https://news.example.com/unsubscribe?id=2')).toBeNull()
  })
})

describe('describeUrl', () => {
  test('drops the query string with its tracking token', () => {
    expect(describeUrl('https://news.example.com/unsubscribe?token=secret')).toBe('news.example.com/unsubscribe')
  })
})

const record = (over: Partial<EmailUnsubscribeRecord>): EmailUnsubscribeRecord => ({ id: 'e1', ...over })

describe('footerLink', () => {
  test('finds an unsubscribe URL in a plain-text body', () => {
    const rec = record({
      bodyValues: {
        '1': {
          value: 'Thanks!\n\nRead more: https://shop.example/blog\nUnsubscribe: https://shop.example/optout?id=9',
        },
      },
      textBody: [{ partId: '1' }],
    })
    expect(footerLink(rec)).toBe('https://shop.example/optout?id=9')
  })

  test('finds an href in an HTML-only body and unescapes &amp;', () => {
    const rec = record({
      bodyValues: { '1': { value: '<a href="https://shop.example/unsubscribe?a=1&amp;b=2">Unsubscribe</a>' } },
      textBody: [{ partId: '1' }],
    })
    expect(footerLink(rec)).toBe('https://shop.example/unsubscribe?a=1&b=2')
  })

  test('returns null when no URL names itself an unsubscribe link', () => {
    const rec = record({ bodyValues: { '1': { value: 'See https://shop.example/' } }, textBody: [{ partId: '1' }] })
    expect(footerLink(rec)).toBeNull()
  })
})

describe('deliveredTo', () => {
  test('takes the first (newest) Delivered-To header', () => {
    const rec = record({
      'header:Delivered-To:asText:all': ['jo@langmail.example', 'jo.forwarded@old.example'],
      to: [{ email: 'list@news.example.com' }],
    })
    expect(deliveredTo(rec)).toBe('jo@langmail.example')
  })

  test('falls back to the To recipients', () => {
    expect(deliveredTo(record({ to: [{ email: 'jo@langmail.example' }] }))).toBe('jo@langmail.example')
    expect(deliveredTo(record({}))).toBeNull()
  })
})
