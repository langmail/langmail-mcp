import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import { basicAuthorization, defaultPublicUrl, HELP, parseSelfHostedConfig } from './config.ts'

// node:test, not bun:test: CI runs this file under Node as well as Bun
// (scripts/test-node.ts).

const STALWART = {
  STALWART_PASSWORD: 'app-pass',
  STALWART_URL: 'https://mail.example.com/',
  STALWART_USERNAME: 'alice',
}

// The config carries at least these fields with these values.
const assertIncludes = (r: ReturnType<typeof parseSelfHostedConfig>, expected: Record<string, unknown>): void => {
  assert.ok(r.ok, r.ok ? '' : r.message)
  const config = r.config as unknown as Record<string, unknown>
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map((key) => [key, config[key]])), expected)
}

describe('parseSelfHostedConfig', () => {
  test('stdio by default, on loopback, with no port and no token needed', () => {
    const r = parseSelfHostedConfig([], STALWART)
    assert.deepEqual(r, {
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
    assertIncludes(r, { authToken: 'secret', host: '127.0.0.1', port: 8080, transport: 'http' })
  })

  test('STALWART_EMAIL (--email) is optional and carried through', () => {
    const r = parseSelfHostedConfig(['--email', 'alice@example.com'], STALWART)
    assert.equal(r.ok && r.config.email, 'alice@example.com')
    const env = parseSelfHostedConfig([], { ...STALWART, STALWART_EMAIL: 'a@example.com' })
    assert.equal(env.ok && env.config.email, 'a@example.com')
  })

  test('flags win over the environment', () => {
    const r = parseSelfHostedConfig(
      ['--stalwart-url', 'https://other.example.com', '--username', 'bob', '--host', '0.0.0.0', '--port', '9000'],
      { ...STALWART, MCP_HOST: '127.0.0.1', MCP_PORT: '1234' }
    )
    assertIncludes(r, {
      host: '0.0.0.0',
      port: 9000,
      stalwartUrl: 'https://other.example.com',
      username: 'bob',
    })
  })

  test('names every missing setting, with its flag and what to put there', () => {
    const r = parseSelfHostedConfig(['--transport', 'http'], {})
    assert.equal(r.ok, false)
    const message = r.ok ? '' : r.message
    assert.ok(message.includes('STALWART_URL (--stalwart-url): the base URL of your Stalwart server'))
    assert.ok(message.includes('STALWART_USERNAME (--username)'))
    assert.ok(message.includes('STALWART_PASSWORD: an app password'))
    assert.ok(message.includes('MCP_AUTH_TOKEN: a long random secret'))
  })

  test('http refuses to start without a token, on loopback too', () => {
    const r = parseSelfHostedConfig([], { ...STALWART, MCP_HOST: '127.0.0.1', MCP_TRANSPORT: 'http' })
    assert.equal(r.ok, false)
    assert.ok((r.ok ? '' : r.message).includes('MCP_AUTH_TOKEN'))
  })

  test('the secrets have no flag', () => {
    for (const flag of ['--password', '--auth-token']) {
      const r = parseSelfHostedConfig([flag, 'x'], STALWART)
      assert.equal(r.ok, false)
      assert.ok((r.ok ? '' : r.message).includes(`Unknown option '${flag}'`))
    }
  })

  test('rejects an unknown transport, a bad port and a non-http URL', () => {
    assert.equal(parseSelfHostedConfig(['--port', '0x50'], STALWART).ok, false)
    const r = parseSelfHostedConfig(['--transport', 'sse', '--port', 'eighty'], {
      ...STALWART,
      STALWART_URL: 'mail.example.com',
    })
    const message = r.ok ? '' : r.message
    assert.ok(message.includes('"sse" is not a transport'))
    assert.ok(message.includes('"eighty" is not a port number'))
    assert.ok(message.includes('"mail.example.com" is not an http(s) URL'))
  })
})

describe('--help', () => {
  test('lists every setting with its environment variable, and needs none of them', () => {
    for (const flag of ['--help', '-h']) {
      const r = parseSelfHostedConfig([flag], {})
      assert.deepEqual(r, { help: true, message: HELP, ok: false })
    }
    for (const variable of [
      'STALWART_URL (--stalwart-url)',
      'STALWART_USERNAME (--username)',
      'STALWART_PASSWORD:',
      'STALWART_EMAIL (--email)',
      'MCP_TRANSPORT (--transport)',
      'MCP_HOST (--host)',
      'MCP_PORT (--port)',
      'MCP_PUBLIC_URL (--public-url)',
      'MCP_AUTH_TOKEN:',
      'LOG_LEVEL:',
      'NODE_ENV:',
      'BETTERSTACK_SOURCE_TOKEN:',
      'BETTERSTACK_ENDPOINT:',
      'BETTERSTACK_ERRORS_DSN:',
    ]) {
      assert.ok(HELP.includes(`\n  ${variable}`), variable)
    }
  })
})

describe('helpers', () => {
  test('basicAuthorization', () => {
    assert.equal(basicAuthorization('alice', 'pa:ss'), `Basic ${btoa('alice:pa:ss')}`)
  })

  test('defaultPublicUrl replaces a wildcard bind with loopback', () => {
    assert.equal(defaultPublicUrl('0.0.0.0', 8080), 'http://127.0.0.1:8080')
    assert.equal(defaultPublicUrl('::1', 8080), 'http://[::1]:8080')
    assert.equal(defaultPublicUrl('mcp.internal', 80), 'http://mcp.internal:80')
  })
})
