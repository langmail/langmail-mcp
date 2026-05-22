// Typed JMAP wrappers for the Email and Mailbox capabilities. Narrow
// on purpose — see services/mcp/AGENTS.md and spec/02 §Phase 2 for the
// "extract to packages/jmap-client/ only when a second service needs
// it" rule.

import { JmapError } from "./session.ts";
import type {
  EmailRecord,
  JmapRequest,
  JmapResponse,
  MailboxRecord,
} from "./types.ts";

const MAIL_CAPABILITY = "urn:ietf:params:jmap:mail";

export const EMAIL_PROPERTIES = [
  "id",
  "subject",
  "from",
  "receivedAt",
  "preview",
  "mailboxIds",
] as const;

interface JmapCall {
  apiUrl: string;
  token: string;
}

async function call<T extends JmapResponse>(
  ctx: JmapCall,
  body: JmapRequest,
): Promise<T> {
  const res = await fetch(ctx.apiUrl, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ctx.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (res.status !== 200) {
    throw new JmapError(res.status, `jmap request returned ${res.status}`);
  }
  return (await res.json()) as T;
}

function methodResponse<T>(
  resp: JmapResponse,
  name: string,
  callId: string,
): T {
  const entry = resp.methodResponses.find(
    ([n, , id]) => n === name && id === callId,
  );
  if (!entry) {
    throw new JmapError(200, `missing method response for ${name}/${callId}`);
  }
  return entry[1] as T;
}

export interface EmailQueryParams extends JmapCall {
  accountId: string;
  text: string;
  mailboxId?: string;
  limit: number;
}

export async function emailQuery(p: EmailQueryParams): Promise<string[]> {
  const filter: Record<string, unknown> = { text: p.text };
  if (p.mailboxId) filter["inMailbox"] = p.mailboxId;
  const resp = await call(p, {
    using: [MAIL_CAPABILITY],
    methodCalls: [
      [
        "Email/query",
        {
          accountId: p.accountId,
          filter,
          limit: p.limit,
          // Stalwart FTS returns ids in mailbox order; full totals are
          // expensive on a big mailbox and we don't show them.
          calculateTotal: false,
        },
        "0",
      ],
    ],
  });
  const out = methodResponse<{ ids?: string[] }>(resp, "Email/query", "0");
  return out.ids ?? [];
}

export interface EmailGetParams extends JmapCall {
  accountId: string;
  ids: string[];
}

export async function emailGet(p: EmailGetParams): Promise<EmailRecord[]> {
  if (p.ids.length === 0) return [];
  const resp = await call(p, {
    using: [MAIL_CAPABILITY],
    methodCalls: [
      [
        "Email/get",
        {
          accountId: p.accountId,
          ids: p.ids,
          properties: [...EMAIL_PROPERTIES],
        },
        "0",
      ],
    ],
  });
  const out = methodResponse<{ list?: EmailRecord[] }>(resp, "Email/get", "0");
  return out.list ?? [];
}

export interface MailboxIdByNameParams extends JmapCall {
  accountId: string;
  name: string;
}

export async function mailboxIdByName(
  p: MailboxIdByNameParams,
): Promise<string | null> {
  // One round-trip: query all mailbox ids, hydrate names, match
  // case-insensitively. Stalwart's mailbox count is small enough that
  // skipping a name-filtered Mailbox/query (which JMAP doesn't directly
  // support anyway) is fine.
  const resp = await call(p, {
    using: [MAIL_CAPABILITY],
    methodCalls: [
      [
        "Mailbox/query",
        { accountId: p.accountId },
        "0",
      ],
      [
        "Mailbox/get",
        {
          accountId: p.accountId,
          "#ids": { resultOf: "0", name: "Mailbox/query", path: "/ids" },
          properties: ["id", "name"],
        },
        "1",
      ],
    ],
  });
  const got = methodResponse<{ list?: MailboxRecord[] }>(resp, "Mailbox/get", "1");
  const wanted = p.name.toLowerCase();
  const hit = (got.list ?? []).find((m) => m.name.toLowerCase() === wanted);
  return hit?.id ?? null;
}
