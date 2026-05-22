// search_emails tool — full-text search over the authenticated user's
// mailbox, returning subject/sender/date/preview.
//
// The tool logic lives behind a `Deps` interface so it can be unit-
// tested without spinning up Stalwart. `registerSearchEmails(server)`
// wires the live deps into the MCP server.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  emailGet,
  emailQuery,
  mailboxIdByName,
  type EmailGetParams,
  type EmailQueryParams,
} from "../jmap/email.ts";
import {
  accountIdForMail,
  fetchSession,
  SessionCache,
} from "../jmap/session.ts";
import type { EmailRecord } from "../jmap/types.ts";

export const searchEmailsInput = z.object({
  query: z.string().min(1).max(500),
  mailbox: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
});

export type SearchEmailsArgs = z.infer<typeof searchEmailsInput>;

export interface SearchEmailsDeps {
  resolveAccountId: (token: string) => Promise<string>;
  resolveMailbox: (token: string, name: string) => Promise<string | null>;
  emailQuery: (p: EmailQueryParams) => Promise<string[]>;
  emailGet: (p: EmailGetParams) => Promise<EmailRecord[]>;
}

export interface SearchEmailsContext {
  token: string;
  args: SearchEmailsArgs;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

function formatEmail(idx: number, e: EmailRecord): string {
  const subject = e.subject ?? "(no subject)";
  const from =
    e.from
      ?.map((f) => (f.name ? `${f.name} <${f.email}>` : f.email))
      .join(", ") ?? "(unknown sender)";
  const date = e.receivedAt ?? "";
  return `${idx}. ${subject}\n   from: ${from}\n   date: ${date}`;
}

export async function searchEmails(
  deps: SearchEmailsDeps,
  ctx: SearchEmailsContext,
): Promise<ToolResult> {
  const { token, args } = ctx;
  const accountId = await deps.resolveAccountId(token);

  let mailboxId: string | undefined;
  if (args.mailbox) {
    const id = await deps.resolveMailbox(token, args.mailbox);
    if (!id) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Mailbox not found: ${args.mailbox}`,
          },
        ],
      };
    }
    mailboxId = id;
  }

  const ids = await deps.emailQuery({
    apiUrl: "", // wired by live deps; mock deps ignore
    token,
    accountId,
    text: args.query,
    limit: args.limit,
    ...(mailboxId ? { mailboxId } : {}),
  });

  if (ids.length === 0) {
    return {
      content: [{ type: "text", text: "No messages matched." }],
    };
  }

  const list = await deps.emailGet({
    apiUrl: "",
    token,
    accountId,
    ids,
  });

  const lines = list.map((e, i) => formatEmail(i + 1, e));
  return {
    content: [
      {
        type: "text",
        text: `${list.length} message(s) matched:\n\n${lines.join("\n\n")}`,
      },
    ],
  };
}

// --- live-deps wiring ----------------------------------------------------

export interface LiveDepsConfig {
  stalwartUrl: string;
  sessionCache?: SessionCache;
}

export function makeLiveDeps(cfg: LiveDepsConfig): SearchEmailsDeps {
  const cache = cfg.sessionCache ?? new SessionCache();
  // Principal-keyed session cache lookup needs the principal; without
  // it we cache by token, which is fine for a single process. Cheaper
  // than re-deriving the principal from another userinfo call.
  const sessionByToken = new Map<string, Awaited<ReturnType<typeof fetchSession>>>();

  const getSession = async (token: string) => {
    const hit = sessionByToken.get(token);
    if (hit) return hit;
    const session = await fetchSession(cfg.stalwartUrl, token);
    sessionByToken.set(token, session);
    return session;
  };

  return {
    resolveAccountId: async (token) =>
      accountIdForMail(await getSession(token)),
    resolveMailbox: async (token, name) => {
      const s = await getSession(token);
      return mailboxIdByName({
        apiUrl: s.apiUrl,
        token,
        accountId: accountIdForMail(s),
        name,
      });
    },
    emailQuery: async (p) => {
      const s = await getSession(p.token);
      return emailQuery({ ...p, apiUrl: s.apiUrl });
    },
    emailGet: async (p) => {
      const s = await getSession(p.token);
      return emailGet({ ...p, apiUrl: s.apiUrl });
    },
  };
}

// --- MCP registration ----------------------------------------------------

export function registerSearchEmails(
  server: McpServer,
  deps: SearchEmailsDeps,
  // Tools execute outside the request lifecycle, so the bearer must be
  // threaded in via this getter (closed over per request — see
  // mcp/handler.ts).
  getToken: () => string,
): void {
  server.registerTool(
    "search_emails",
    {
      title: "Search emails",
      description:
        "Full-text search over the authenticated user's mailbox. " +
        "Returns matching messages with subject, sender, date, and a short preview.",
      inputSchema: searchEmailsInput.shape,
    },
    async (args) => {
      const parsed = searchEmailsInput.parse(args);
      return searchEmails(deps, { token: getToken(), args: parsed });
    },
  );
}
