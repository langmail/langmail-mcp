import { describe, test, expect, mock } from "bun:test";
import { emailQuery, emailGet, mailboxIdByName } from "./email.ts";

const API = "https://mail.example.com/jmap/";

function withFetch<T>(impl: (url: string, init?: RequestInit) => Promise<Response>, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as unknown as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

describe("emailQuery", () => {
  test("sends Email/query with FTS filter and parses ids", async () => {
    const f = mock(async (url: string, init?: RequestInit) => {
      expect(url).toBe(API);
      const body = JSON.parse((init?.body as string) ?? "{}");
      expect(body.using).toContain("urn:ietf:params:jmap:mail");
      expect(body.methodCalls[0][0]).toBe("Email/query");
      expect(body.methodCalls[0][1].accountId).toBe("acct");
      expect(body.methodCalls[0][1].filter.text).toBe("hello");
      expect(body.methodCalls[0][1].limit).toBe(20);
      // We always disable totals — cheap counts on a big mailbox blow up.
      expect(body.methodCalls[0][1].calculateTotal).toBe(false);
      return new Response(
        JSON.stringify({
          methodResponses: [
            ["Email/query", { ids: ["e1", "e2"] }, "0"],
          ],
        }),
        { status: 200 },
      );
    });
    const ids = await withFetch(f, () =>
      emailQuery({
        apiUrl: API,
        token: "tok",
        accountId: "acct",
        text: "hello",
        limit: 20,
      }),
    );
    expect(ids).toEqual(["e1", "e2"]);
  });

  test("adds inMailbox filter when mailboxId provided", async () => {
    const f = mock(async (_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      expect(body.methodCalls[0][1].filter.inMailbox).toBe("mbx");
      expect(body.methodCalls[0][1].filter.text).toBe("hi");
      return new Response(
        JSON.stringify({ methodResponses: [["Email/query", { ids: [] }, "0"]] }),
        { status: 200 },
      );
    });
    await withFetch(f, () =>
      emailQuery({
        apiUrl: API,
        token: "tok",
        accountId: "acct",
        text: "hi",
        mailboxId: "mbx",
        limit: 5,
      }),
    );
    expect(f).toHaveBeenCalled();
  });
});

describe("emailGet", () => {
  test("requests the declared properties and returns the list", async () => {
    const f = mock(async (_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      expect(body.methodCalls[0][0]).toBe("Email/get");
      expect(body.methodCalls[0][1].ids).toEqual(["e1"]);
      expect(body.methodCalls[0][1].properties).toEqual([
        "id",
        "subject",
        "from",
        "receivedAt",
        "preview",
        "mailboxIds",
      ]);
      return new Response(
        JSON.stringify({
          methodResponses: [
            [
              "Email/get",
              {
                list: [
                  {
                    id: "e1",
                    subject: "Test",
                    from: [{ name: "Alice", email: "a@x" }],
                    receivedAt: "2026-01-01T00:00:00Z",
                    preview: "...",
                    mailboxIds: { mbx: true },
                  },
                ],
              },
              "0",
            ],
          ],
        }),
        { status: 200 },
      );
    });
    const out = await withFetch(f, () =>
      emailGet({
        apiUrl: API,
        token: "tok",
        accountId: "acct",
        ids: ["e1"],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.subject).toBe("Test");
  });
});

describe("mailboxIdByName", () => {
  test("returns the id of the mailbox matching by name (case-insensitive)", async () => {
    const f = mock(async (_u: string, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      expect(body.methodCalls[0][0]).toBe("Mailbox/query");
      return new Response(
        JSON.stringify({
          methodResponses: [
            ["Mailbox/query", { ids: ["m1", "m2"] }, "0"],
            [
              "Mailbox/get",
              {
                list: [
                  { id: "m1", name: "Inbox" },
                  { id: "m2", name: "Sent" },
                ],
              },
              "1",
            ],
          ],
        }),
        { status: 200 },
      );
    });
    const id = await withFetch(f, () =>
      mailboxIdByName({
        apiUrl: API,
        token: "tok",
        accountId: "acct",
        name: "inbox",
      }),
    );
    expect(id).toBe("m1");
  });

  test("returns null when no mailbox matches", async () => {
    const f = mock(async () =>
      new Response(
        JSON.stringify({
          methodResponses: [
            ["Mailbox/query", { ids: [] }, "0"],
            ["Mailbox/get", { list: [] }, "1"],
          ],
        }),
        { status: 200 },
      ),
    );
    const id = await withFetch(f, () =>
      mailboxIdByName({
        apiUrl: API,
        token: "tok",
        accountId: "acct",
        name: "Nope",
      }),
    );
    expect(id).toBeNull();
  });
});
