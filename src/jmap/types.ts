// Minimal subset of JMAP types used by the MCP service.
//
// JMAP is huge; this file declares only the properties we actually read
// or send. Adding fields when a new tool needs them is preferable to
// trying to mirror the whole RFC up front.

export interface JmapSession {
  apiUrl: string;
  primaryAccounts: Record<string, string>;
}

export interface JmapRequest {
  using: string[];
  methodCalls: [string, Record<string, unknown>, string][];
}

export interface JmapResponse {
  methodResponses: [string, Record<string, unknown>, string][];
}

// Properties we ask for in Email/get.
export interface EmailRecord {
  id: string;
  subject?: string | null;
  from?: { name?: string | null; email: string }[] | null;
  receivedAt?: string | null;
  preview?: string | null;
  mailboxIds?: Record<string, boolean> | null;
}

export interface MailboxRecord {
  id: string;
  name: string;
}
