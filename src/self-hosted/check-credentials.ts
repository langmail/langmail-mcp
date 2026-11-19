// The self-hosted server's one startup check: ask Stalwart for the JMAP
// session with the configured username and app password. Wrong credentials,
// an unreachable server and a server that advertises its API somewhere other
// than STALWART_URL all stop the start with a message that names what to fix,
// instead of failing on the agent's first tool call.

export interface CheckedSession {
  // The account's login as Stalwart reports it; the sending identity is
  // picked by it (tools/draft-common.ts), falling back to the only identity.
  principal: string
}

export type CheckResult = { ok: true; session: CheckedSession } | { message: string; ok: false }

const TIMEOUT_MS = 15_000

// Every URL the session advertises must be on STALWART_URL's origin: the tools
// call them verbatim, so a server that advertises a different public URL would
// send the mailbox's traffic to another host, or nowhere.
const ADVERTISED = ['apiUrl', 'downloadUrl', 'uploadUrl'] as const

const originOf = (raw: string): string | undefined => {
  try {
    // The download and upload URLs are RFC 6570 templates; braces are not
    // part of the origin.
    return new URL(raw.replaceAll(/[{}]/gu, '')).origin
  } catch {
    return undefined
  }
}

export const checkStalwartCredentials = async (
  stalwartUrl: string,
  username: string,
  authorization: string,
  fetchImpl: typeof fetch = fetch
): Promise<CheckResult> => {
  const url = `${stalwartUrl}/.well-known/jmap`
  let res: Response
  try {
    res = await fetchImpl(url, { headers: { authorization }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (error) {
    return {
      message: `Could not reach Stalwart at ${stalwartUrl} (${error instanceof Error ? error.message : String(error)}). Check STALWART_URL (--stalwart-url).`,
      ok: false,
    }
  }
  if (res.status === 401 || res.status === 403) {
    return {
      message: `Stalwart at ${stalwartUrl} rejected username "${username}" with that password. Check STALWART_USERNAME (--username) and STALWART_PASSWORD; an app password from Stalwart's account settings works where a password with two-factor sign-in does not.`,
      ok: false,
    }
  }
  if (res.status !== 200) {
    return {
      message: `Stalwart at ${stalwartUrl} answered the JMAP session request (${url}) with HTTP ${res.status}. Check that STALWART_URL (--stalwart-url) is the server's base URL.`,
      ok: false,
    }
  }
  let body: Record<string, unknown>
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    return {
      message: `${url} did not answer with a JMAP session. Check that STALWART_URL (--stalwart-url) points at Stalwart.`,
      ok: false,
    }
  }
  const expected = originOf(stalwartUrl)
  for (const key of ADVERTISED) {
    const value = body[key]
    if (typeof value !== 'string') {
      return { message: `${url} did not answer with a JMAP session (no ${key}).`, ok: false }
    }
    if (originOf(value) !== expected) {
      return {
        message: `Stalwart advertises its JMAP ${key} as ${value}, which is not on ${stalwartUrl}. Set STALWART_URL (--stalwart-url) to the URL Stalwart advertises (its public URL setting), or change that setting to match.`,
        ok: false,
      }
    }
  }
  const principal = typeof body.username === 'string' && body.username ? body.username : username
  return { ok: true, session: { principal } }
}
