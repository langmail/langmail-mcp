// The scopes an MCP client should request: advertised by the AS facade, the
// protected-resource metadata and the 401 challenge, so a client that builds
// its `scope` from any of them asks for a refresh token (`offline_access`).
// The auth service grants the same set to clients that send no scope
// (`defaultScope` in services/auth/src/auth.ts).
export const MCP_SCOPES = ['openid', 'email', 'offline_access'] as const
