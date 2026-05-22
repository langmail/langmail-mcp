// Resolves a Stalwart-issued bearer token to a principal identity via
// the OIDC `/auth/userinfo` endpoint. The caller maps a throw to a 401.
//
// We don't try to validate the token cryptographically — Stalwart owns
// that. See spec/03 §MCP RS auth model for why this is correct under
// 0.16.6: scopes are absent, audience binding is absent, and userinfo
// is the cheapest path that gives us a usable principal.

export interface UserinfoResult {
  principal: string;
  exp: number; // Unix seconds
}

export class UserinfoError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "UserinfoError";
  }
}

const DEFAULT_TTL_SECONDS = 3600;

export async function fetchUserinfo(
  stalwartBase: string,
  token: string,
): Promise<UserinfoResult> {
  const url = `${stalwartBase.replace(/\/+$/, "")}/auth/userinfo`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status !== 200) {
    throw new UserinfoError(res.status, `userinfo returned ${res.status}`);
  }
  const body = (await res.json()) as Record<string, unknown>;
  const principal =
    (typeof body["preferred_username"] === "string"
      ? (body["preferred_username"] as string)
      : undefined) ??
    (typeof body["sub"] === "string" ? (body["sub"] as string) : undefined);
  if (!principal) {
    throw new UserinfoError(
      200,
      "userinfo response missing preferred_username and sub",
    );
  }
  const exp =
    typeof body["exp"] === "number"
      ? (body["exp"] as number)
      : Math.floor(Date.now() / 1000) + DEFAULT_TTL_SECONDS;
  return { principal, exp };
}
