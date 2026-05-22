import { describe, test, expect } from "bun:test";
import { searchEmails, searchEmailsInput } from "./searchEmails.ts";
import type { EmailRecord } from "../jmap/types.ts";

function fakeDeps(opts: {
  accountId?: string;
  mailboxByName?: (name: string) => string | null;
  queryIds?: string[];
  emails?: EmailRecord[];
}) {
  return {
    resolveAccountId: async () => opts.accountId ?? "acct",
    resolveMailbox: async (_token: string, name: string) =>
      opts.mailboxByName ? opts.mailboxByName(name) : null,
    emailQuery: async () => opts.queryIds ?? [],
    emailGet: async () => opts.emails ?? [],
  };
}

describe("searchEmailsInput schema", () => {
  test("rejects empty query", () => {
    const r = searchEmailsInput.safeParse({ query: "" });
    expect(r.success).toBe(false);
  });

  test("rejects limit > 100", () => {
    const r = searchEmailsInput.safeParse({ query: "x", limit: 9999 });
    expect(r.success).toBe(false);
  });

  test("defaults limit to 20 when omitted", () => {
    const r = searchEmailsInput.parse({ query: "x" });
    expect(r.limit).toBe(20);
  });

  test("rejects query > 500 chars", () => {
    const r = searchEmailsInput.safeParse({ query: "a".repeat(501) });
    expect(r.success).toBe(false);
  });
});

describe("searchEmails", () => {
  test("returns a formatted text block with subject/sender/date", async () => {
    const result = await searchEmails(
      fakeDeps({
        queryIds: ["e1"],
        emails: [
          {
            id: "e1",
            subject: "smoke-12345",
            from: [{ name: "Smoketest", email: "smoketest@langmail.me" }],
            receivedAt: "2026-01-01T00:00:00Z",
            preview: "hello",
            mailboxIds: { mbx: true },
          },
        ],
      }),
      { token: "tok", args: { query: "smoke-12345", limit: 20 } },
    );
    expect(result.content[0]?.type).toBe("text");
    const txt = result.content[0]?.text ?? "";
    expect(txt).toContain("smoke-12345");
    expect(txt).toContain("smoketest@langmail.me");
    expect(txt).toContain("2026-01-01");
  });

  test("reports 'no messages' on empty hit set", async () => {
    const result = await searchEmails(
      fakeDeps({ queryIds: [], emails: [] }),
      { token: "tok", args: { query: "nothing", limit: 20 } },
    );
    const txt = result.content[0]?.text ?? "";
    expect(txt.toLowerCase()).toContain("no messages");
  });

  test("resolves mailbox name to id before querying", async () => {
    let seenMailboxId: string | undefined;
    const result = await searchEmails(
      {
        resolveAccountId: async () => "acct",
        resolveMailbox: async (_token, name) => (name === "Inbox" ? "m1" : null),
        emailQuery: async (p) => {
          seenMailboxId = p.mailboxId;
          return [];
        },
        emailGet: async () => [],
      },
      { token: "tok", args: { query: "x", mailbox: "Inbox", limit: 5 } },
    );
    expect(seenMailboxId).toBe("m1");
    // Empty result still returns a valid response.
    expect(result.content[0]?.text).toBeDefined();
  });

  test("returns a user-readable error when the named mailbox is unknown", async () => {
    const result = await searchEmails(
      fakeDeps({ mailboxByName: () => null }),
      { token: "tok", args: { query: "x", mailbox: "DoesNotExist", limit: 5 } },
    );
    expect(result.isError).toBe(true);
    const txt = result.content[0]?.text ?? "";
    expect(txt.toLowerCase()).toContain("mailbox");
    expect(txt).toContain("DoesNotExist");
  });
});
