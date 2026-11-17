# End-to-end suites

These suites run the server's code against a real [Stalwart](https://stalw.art) mail server. They skip when `STALWART_ADMIN_URL` is unset, so `npm run test:e2e` without a server passes without testing anything.

## Run with docker

```sh
scripts/stalwart/up.sh
STALWART_ADMIN_URL=http://127.0.0.1:9090 npm run test:e2e
scripts/stalwart/down.sh
```

## Run without docker

Download the Stalwart release binary for your platform, in the version `.stalwart-version` names, from the [Stalwart releases](https://github.com/stalwartlabs/stalwart/releases), and point `STALWART_BIN` at it:

```sh
STALWART_BIN=/path/to/stalwart scripts/stalwart/up.sh
STALWART_ADMIN_URL=http://127.0.0.1:9090 npm run test:e2e
scripts/stalwart/down.sh
```

Needs `curl` and Node 22.6 or later; no root.

## What the scripts do

- `up.sh` starts Stalwart on `http://127.0.0.1:9090`, waits for it and runs `bootstrap.ts`. This takes about 10 seconds. Running it again leaves a prepared server as it is.
- `bootstrap.ts` completes Stalwart's first-boot setup over its admin API: hostname `mail.example.com`, mail domain `example.com`, no TLS certificates or DKIM keys, logging to stdout, vCard 3.0 as the CardDAV default, and automatic IP bans off (all suites come from one address, and some send wrong passwords on purpose). Its header lists every step.
- `down.sh` stops the server and deletes its data. The next `up.sh` starts from an empty server.
- `local.sh start|stop|restart|status|logs|clean` drives the binary directly. Data, config and log live in `${TMPDIR:-/tmp}/langmail-mcp-stalwart`; `local.sh logs` prints the server log. With docker, use `docker logs langmail-mcp-stalwart`.

## Environment

| Variable | Read by | Meaning |
| --- | --- | --- |
| `STALWART_ADMIN_URL` | suites, `bootstrap.ts` | Base URL of the server. Suites skip when unset. |
| `STALWART_ADMIN_AUTHORIZATION` | suites, `bootstrap.ts` | Admin `Authorization` header. Default: Basic `admin:devpassword`, the login `up.sh` sets. |
| `STALWART_BIN` | `up.sh`, `local.sh` | Path of a Stalwart binary. Set: run the binary. Unset: run docker. |
| `STALWART_LOCAL_DIR` | `up.sh`, `local.sh`, `down.sh` | Binary mode: where config, data and log go. |
| `STALWART_PORT` | `up.sh`, `local.sh` | Binary mode: HTTP port, default 9090. |

## What a run creates

Each suite creates its own accounts under `example.com`, named `<suite>-<timestamp>`, each with an app password, and destroys them in `afterAll`; an account's mail, calendars and contacts go with it. A killed run can leave accounts behind. They do not disturb later runs, and `down.sh` removes them with everything else.

Mail between these accounts is delivered inside the server. Nothing is sent to another host: the server has no SMTP listener in binary mode and publishes none with docker.

## Writing a suite

Name the file `e2e/<name>.e2e.test.ts` and build on `e2e/support/`:

- `env.ts`: `live` (a `describe` that skips without a server), `ADMIN_URL`, `DOMAIN`.
- `admin.ts`: `createAccount`, `createBearerCredential` (an API key for an account, as a `Bearer` credential), `destroyCreatedAccounts` for `afterAll`, `adminCall`.
- `mail.ts`: `openMailSession`, `importEmail`, `mailboxId`, `jmapCall`, `waitForMessage`, `waitForCalendarMessage`.
- `server.ts`: `startStdioServer` and `startHttpServer` start the built server (`dist/index.js`) for an account and return a connected MCP client (HTTP: also `baseUrl`, `mcpUrl`, `token`, `connect`, `stop`). They fail with what to run when `dist/` is missing or older than `src/`; `npm run test:e2e` builds first.
- `caldav.ts`: `provisionPrincipal` (an account with its calendars discovered), `waitForMoreThan`, `calendarMessageWith`, and `staysAt` for "no scheduling mail arrives" checks, whose quiet window grows with the slowest delivery the file has seen.
- `mail.ts`: `openMailSession`, `importEmail`, `messageSource` (a message with its own Message-ID and reply headers, to build a conversation), `mailboxId`, `jmapCall`, `waitForMessage`, `waitForCalendarMessage`.
- `server.ts`: `startStdioServer` and `startHttpServer` start the built server (`dist/index.js`) for an account and return a connected MCP client (HTTP: also `baseUrl`, `mcpUrl`, `token`, `connect`, `stop`). They fail with what to run when `dist/` is missing or older than `src/`; `npm run test:e2e` builds first. `startRawStdioServer` speaks MCP over the pipes by hand and keeps every line of stdout; `listeningTcpPorts` lists the TCP ports a process listens on, `listeningTcpSockets` also the address each is bound to (Linux).
- `compose.ts`: for suites that send mail: `awaitDelivery` and `awaitSubject` (what arrived in another account's mailbox), `composeRecord`, `bodyOf`, `attachmentsOf` (a message's files with their bytes), and `toolCaller` (call a started server's tool and read the answer as text). Send only to accounts the suite created.
- `tool-output.ts`: `toolText` and `listedMessages` read a tool result the way an agent does, ids included.
- `wait.ts`: `untilIndexed` for reads through the search index, which Stalwart updates after a write has returned; `pollUntil`, `sleep`.

`all-tools.e2e.test.ts` calls every tool once through the built server, over stdio and over HTTP, as one story; a tool added to the server needs a call there. `agent.e2e.test.ts` is the suite to read first: an agent finds an old email by a phrase and reads its conversation, over stdio and over HTTP, and callers who are not allowed in get nothing. `harness.e2e.test.ts` uses all of them and is the suite to copy from. `http-auth.e2e.test.ts` shows how to drive the built server through an MCP client. `jmap.e2e.test.ts` shows how to drive the server's own code (`loadConfig`, `createRuntime`, `src/jmap`) with a Basic and with a Bearer credential.

## Stalwart version

`.stalwart-version` pins the version the suites run against, locally and in CI. It tracks the Stalwart version Langmail runs in production.
