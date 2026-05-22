// Phase 3a deterministic smoke. Drives the deployed MCP server as a
// real client and asserts:
//
//   1. `search_emails` is registered.
//   2. A self-loop message tagged `smoke-<ts>-<pid>` (delivered by
//      smoke-test-mail.sh on every `just deploy` run) round-trips
//      through Stalwart FTS into our tool.
//   3. Bad input (empty query, oversized limit, unknown mailbox)
//      produces a clean tool error, not a thrown exception.
//   4. Refreshing the access token via /auth/token produces a new
//      bearer that still authenticates against /mcp.
//
// OAuth dance is out-of-band on purpose. Run
// `infra/scripts/obtain-mcp-tokens.sh` first (or any equivalent) to
// pre-populate:
//   MCP_ACCESS_TOKEN, MCP_REFRESH_TOKEN, MCP_OAUTH_CLIENT_ID,
//   MCP_PUBLIC_URL, STALWART_PUBLIC_URL
//
// Run via `bun run smoke` from services/mcp/, or as part of
// `just smoke-test-mcp`.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const log = (msg: string) => process.stdout.write(`▶ ${msg}\n`);

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    process.stderr.write(`✗ missing required env var ${name}\n`);
    process.exit(2);
  }
  return v;
}

function unwrapText(result: {
  content?: { type?: string; text?: string }[];
  isError?: boolean;
}): { text: string; isError: boolean } {
  const first = result.content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error(
      `tool response missing content[0].text: ${JSON.stringify(result)}`,
    );
  }
  return { text: first.text, isError: Boolean(result.isError) };
}

async function connect(
  mcpUrl: string,
  token: string,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "langmail-mcp-smoke", version: "0.1.0" });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
      await transport.close().catch(() => {});
    },
  };
}

async function exchangeRefresh(opts: {
  stalwartUrl: string;
  clientId: string;
  refreshToken: string;
}): Promise<{ access_token: string; refresh_token?: string }> {
  const res = await fetch(`${opts.stalwartUrl}/auth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: opts.refreshToken,
      client_id: opts.clientId,
    }).toString(),
  });
  if (!res.ok) {
    throw new Error(
      `refresh exchange failed: HTTP ${res.status} ${await res.text()}`,
    );
  }
  return (await res.json()) as { access_token: string; refresh_token?: string };
}

async function main() {
  const mcpBase = requireEnv("MCP_PUBLIC_URL").replace(/\/+$/, "");
  const stalwart = requireEnv("STALWART_PUBLIC_URL").replace(/\/+$/, "");
  const clientId = requireEnv("MCP_OAUTH_CLIENT_ID");
  const accessToken = requireEnv("MCP_ACCESS_TOKEN");
  const refreshToken = process.env.MCP_REFRESH_TOKEN ?? "";
  const smokeTag = process.env.MCP_SMOKE_TAG ?? "";
  const mcpUrl = `${mcpBase}/mcp`;

  let passed = 0;
  const fail = (msg: string): never => {
    process.stderr.write(`✗ ${msg}\n`);
    process.exit(1);
  };
  const pass = (msg: string) => {
    process.stdout.write(`✓ ${msg}\n`);
    passed++;
  };

  log(`connect to ${mcpUrl}`);
  let session = await connect(mcpUrl, accessToken);

  // --- 1. listTools includes search_emails -----------------------------
  log("listTools");
  const tools = await session.client.listTools();
  const names = tools.tools.map((t) => t.name);
  if (!names.includes("search_emails")) {
    fail(`search_emails missing from tool list: ${names.join(", ")}`);
  }
  pass(`search_emails registered (alongside: ${names.join(", ") || "—"})`);

  // --- 2. Round-trip via the smoke tag ---------------------------------
  //
  // Stalwart's FTS indexes asynchronously: a freshly-delivered message
  // (the mail smoke runs immediately before us) won't always be visible
  // on the first query. Retry a few times with a short backoff before
  // calling it broken.
  if (smokeTag) {
    log(`call search_emails query="${smokeTag}" (with FTS-index retry)`);
    let text = "";
    let isError = false;
    let attempts = 0;
    const maxAttempts = 6;
    for (; attempts < maxAttempts; attempts++) {
      const result = await session.client.callTool({
        name: "search_emails",
        arguments: { query: smokeTag, limit: 5 },
      });
      ({ text, isError } = unwrapText(
        result as {
          content?: { type?: string; text?: string }[];
          isError?: boolean;
        },
      ));
      if (!isError && text.includes(smokeTag)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    if (isError) fail(`smoke-tag query returned isError=true: ${text}`);
    if (!text.includes(smokeTag)) {
      fail(
        `smoke-tag '${smokeTag}' not found after ${maxAttempts} attempts: ${text}`,
      );
    }
    // Tighten: exactly one hit, with the right sender. The tool formats
    // hits as "N message(s) matched:\n\n1. <subject>\n   from: ...\n   date: ...".
    if (!/^1 message\(s\) matched/m.test(text)) {
      fail(`expected exactly one hit for unique tag; got: ${text}`);
    }
    if (!text.includes("smoketest@langmail.me")) {
      fail(`hit's sender is not smoketest@langmail.me: ${text}`);
    }
    pass(
      `smoke-tag round-trip (mail-side delivery → FTS → JMAP → MCP tool, ${attempts + 1} attempt(s))`,
    );
  } else {
    process.stdout.write(
      "  (skipping round-trip check — MCP_SMOKE_TAG not set; pass the mail smoke tag in to enable)\n",
    );
  }

  // --- 3. Bad-input contract ------------------------------------------
  log("bad input: empty query");
  {
    const result = (await session.client.callTool({
      name: "search_emails",
      arguments: { query: "" },
    })) as { isError?: boolean; content?: { type?: string; text?: string }[] };
    if (!result.isError) {
      fail(`expected isError=true for empty query; got: ${JSON.stringify(result)}`);
    }
    pass("empty query rejected with isError=true");
  }

  log("bad input: limit above schema cap");
  {
    const result = (await session.client.callTool({
      name: "search_emails",
      arguments: { query: "x", limit: 9999 },
    })) as { isError?: boolean; content?: { type?: string; text?: string }[] };
    if (!result.isError) {
      fail(`expected isError=true for limit=9999; got: ${JSON.stringify(result)}`);
    }
    pass("limit > 100 rejected with isError=true");
  }

  log("bad input: nonexistent mailbox");
  {
    const result = (await session.client.callTool({
      name: "search_emails",
      arguments: { query: "x", mailbox: "DoesNotExist" },
    })) as { isError?: boolean; content?: { type?: string; text?: string }[] };
    const { text, isError } = unwrapText(result);
    if (!isError) fail(`expected isError=true for unknown mailbox; got: ${text}`);
    if (!text.toLowerCase().includes("mailbox")) {
      fail(`unknown-mailbox error text did not mention 'mailbox': ${text}`);
    }
    pass("unknown mailbox → user-readable MCP error");
  }

  // --- 4. Refresh-token round-trip ------------------------------------
  if (refreshToken) {
    log("exchange refresh token");
    const fresh = await exchangeRefresh({
      stalwartUrl: stalwart,
      clientId,
      refreshToken,
    });
    if (!fresh.access_token) fail("refresh exchange returned no access_token");
    pass("refresh exchange returned a new access_token");

    log("reconnect with the new bearer");
    await session.close();
    session = await connect(mcpUrl, fresh.access_token);
    const tools2 = await session.client.listTools();
    if (!tools2.tools.some((t) => t.name === "search_emails")) {
      fail("post-refresh listTools missing search_emails");
    }
    pass("post-refresh listTools still works");
  } else {
    process.stdout.write(
      "  (skipping refresh round-trip — MCP_REFRESH_TOKEN not set)\n",
    );
  }

  await session.close();
  process.stdout.write(`\n${passed} checks passed\n`);
}

main().catch((err) => {
  process.stderr.write(`✗ ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
