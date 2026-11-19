import { describe, expect, test } from 'bun:test'

import { basicAuthorization, defaultPublicUrl, parseSelfHostedConfig } from './config.ts'

const STALWART = {
  STALWART_PASSWORD: 'app-pass',
  STALWART_URL: 'https://mail.example.com/',
  STALWART_USERNAME: 'alice',
}

describe('parseSelfHostedConfig', () => {
  test('stdio by default, on loopback, with no port and no token needed', () => {
    const r = parseSelfHostedConfig([], STALWART)
    expect(r).toEqual({
      config: {
        host: '127.0.0.1',
        password: 'app-pass',
        stalwartUrl: 'https://mail.example.com',
        transport: 'stdio',
        username: 'alice',
      },
      ok: true,
    })
  })

  test('http defaults to 127.0.0.1:8080 and carries the token', () => {
    const r = parseSelfHostedConfig(['--transport', 'http'], { ...STALWART, MCP_AUTH_TOKEN: 'secret' })
    expect(r.ok && r.config).toMatchObject({ authToken: 'secret', host: '127.0.0.1', port: 8080, transport: 'http' })
  })

  test('STALWART_EMAIL (--email) is optional and carried through', () => {
    const r = parseSelfHostedConfig(['--email', 'alice@example.com'], STALWART)
    expect(r.ok && r.config.email).toBe('alice@example.com')
    const env = parseSelfHostedConfig([], { ...STALWART, STALWART_EMAIL: 'a@example.com' })
    expect(env.ok && env.config.email).toBe('a@example.com')
  })

  test('flags win over the environment', () => {
    const r = parseSelfHostedConfig(
      ['--stalwart-url', 'https://other.example.com', '--username', 'bob', '--host', '0.0.0.0', '--port', '9000'],
      { ...STALWART, MCP_HOST: '127.0.0.1', MCP_PORT: '1234' }
    )
    expect(r.ok && r.config).toMatchObject({
      host: '0.0.0.0',
      port: 9000,
      stalwartUrl: 'https://other.example.com',
      username: 'bob',
    })
  })

  test('names every missing setting, with its flag and what to put there', () => {
    const r = parseSelfHostedConfig(['--transport', 'http'], {})
    expect(r.ok).toBe(false)
    const message = r.ok ? '' : r.message
    expect(message).toContain('STALWART_URL (--stalwart-url): the base URL of your Stalwart server')
    expect(message).toContain('STALWART_USERNAME (--username)')
    expect(message).toContain('STALWART_PASSWORD: an app password')
    expect(message).toContain('MCP_AUTH_TOKEN: a long random secret')
  })

  test('http refuses to start without a token, on loopback too', () => {
    const r = parseSelfHostedConfig([], { ...STALWART, MCP_HOST: '127.0.0.1', MCP_TRANSPORT: 'http' })
    expect(r.ok).toBe(false)
    expect(r.ok ? '' : r.message).toContain('MCP_AUTH_TOKEN')
  })

  test('the secrets have no flag', () => {
    for (const flag of ['--password', '--auth-token']) {
      const r = parseSelfHostedConfig([flag, 'x'], STALWART)
      expect(r.ok).toBe(false)
      expect(r.ok ? '' : r.message).toContain(`Unknown option '${flag}'`)
    }
  })

  test('rejects an unknown transport, a bad port and a non-http URL', () => {
    expect(parseSelfHostedConfig(['--port', '0x50'], STALWART).ok).toBe(false)
    const r = parseSelfHostedConfig(['--transport', 'sse', '--port', 'eighty'], {
      ...STALWART,
      STALWART_URL: 'mail.example.com',
    })
    const message = r.ok ? '' : r.message
    expect(message).toContain('"sse" is not a transport')
    expect(message).toContain('"eighty" is not a port number')
    expect(message).toContain('"mail.example.com" is not an http(s) URL')
  })
})

describe('helpers', () => {
  test('basicAuthorization', () => {
    expect(basicAuthorization('alice', 'pa:ss')).toBe(`Basic ${btoa('alice:pa:ss')}`)
  })

  test('defaultPublicUrl replaces a wildcard bind with loopback', () => {
    expect(defaultPublicUrl('0.0.0.0', 8080)).toBe('http://127.0.0.1:8080')
    expect(defaultPublicUrl('::1', 8080)).toBe('http://[::1]:8080')
    expect(defaultPublicUrl('mcp.internal', 80)).toBe('http://mcp.internal:80')
  })
})
