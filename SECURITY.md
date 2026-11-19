# Security policy

## Supported versions

langmail-mcp is published to npm and versioned by semantic-release. Security
fixes go into the latest release, so please check that you run it before you
report an issue.

| Version | Supported |
| ------- | --------- |
| Latest release | Yes |
| Older releases | No |

## Reporting a vulnerability

Please report vulnerabilities privately, not in a public issue, discussion or
pull request. Use GitHub's private vulnerability reporting:

1. Open the [Security tab](https://github.com/langmail/langmail-mcp/security)
   of the repository.
2. Click **Report a vulnerability**
   (<https://github.com/langmail/langmail-mcp/security/advisories/new>).
3. Describe the issue in as much detail as you can.

This creates an advisory that only you and the maintainers can see.

### What to include

- What the vulnerability is and what an attacker could do with it.
- Steps to reproduce it, or a proof of concept.
- The version you ran and your setup: Node or Bun version, stdio or HTTP,
  Stalwart version, MCP client.
- A fix, if you have one in mind.

## What to expect

- We aim to answer a new report within 5 business days.
- We keep you informed while we work on a fix.
- Once a fix is released, we credit you in the advisory unless you prefer
  not to be named.

We publish a GitHub Security Advisory once a fix is available. Please give us
time to release the fix before you disclose the issue.

## Running it safely

The server acts on one Stalwart mailbox with the credentials you give it.

- `STALWART_PASSWORD` should be an app password, not the account's main
  password. Both secrets (`STALWART_PASSWORD` and `MCP_AUTH_TOKEN`) are read
  from the environment only, because a command-line flag shows in the process
  list.
- Use HTTPS for `STALWART_URL`.
- Over HTTP, the server refuses to start without `MCP_AUTH_TOKEN`, on loopback
  too, because a web page in your browser can reach a local port. Use a long
  random value.
- The links that `download_attachment`, `download_email`,
  `upload_attachments` and `preview_email` create carry an unguessable token,
  which is their only credential. Treat them like the attachments themselves.

Settings and what the server reaches on the network: `docs/self-hosted.md`.
