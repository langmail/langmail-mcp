# Security Policy

Thank you for helping keep langmail-mcp and its users safe.

## Supported Versions

langmail-mcp is published to npm and versioned automatically via semantic-release.
Security fixes are applied to the latest released version. Please make sure you
are running the most recent release before reporting an issue.

| Version | Supported          |
| ------- | ------------------ |
| Latest release | :white_check_mark: |
| Older releases | :x:                |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues,
discussions, or pull requests.**

Instead, report them privately using GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/langmail/langmail-mcp/security)
   of the repository.
2. Click **Report a vulnerability** (or use this direct link:
   <https://github.com/langmail/langmail-mcp/security/advisories/new>).
3. Fill in as much detail as you can.

This creates a private advisory visible only to you and the maintainers.

### What to include

To help us triage and fix the issue quickly, please include:

- A description of the vulnerability and its potential impact.
- Steps to reproduce, or a proof of concept.
- The affected version(s) and your environment (Node.js version, Stalwart version,
  MCP client).
- Any suggested remediation, if you have one.

## Response Expectations

- We aim to acknowledge new reports within **5 business days**.
- We will keep you informed about our progress toward a fix and disclosure.
- Once a fix is released, we are happy to credit you in the advisory unless you
  prefer to remain anonymous.

## Disclosure Policy

We follow a coordinated disclosure process. Please give us a reasonable
opportunity to release a fix before any public disclosure. We will publish a
GitHub Security Advisory once a fix is available.

## Scope and Handling Credentials

langmail-mcp is a [Model Context Protocol](https://modelcontextprotocol.io)
server that talks to your own Stalwart server over JMAP, CalDAV and CardDAV. It
runs over stdio by default, or over Streamable HTTP when you turn that on. A
few things to keep in mind when deploying it securely:

- **Credentials** (`STALWART_URL`, `STALWART_USERNAME`, `STALWART_PASSWORD`,
  `STALWART_TOKEN`, `MCP_AUTH_TOKEN`) are read from environment variables.
  Never commit your `.env` file or hard-code credentials — `.env` is
  git-ignored, and a gitleaks pre-commit hook guards against accidental secret
  leaks.
- **Always use HTTPS** for `STALWART_URL` so credentials, mail, calendar and
  contact data are encrypted in transit.
- Prefer an app password over your primary account password.
- **HTTP mode** requires `MCP_AUTH_TOKEN` and listens on `127.0.0.1` unless you
  set `MCP_HOST`. Put it behind TLS before exposing it to a network.
- **No other outbound traffic by default.** The server only talks to your
  Stalwart unless you opt in with `LANGMAIL_MCP_ALLOW_UNSUBSCRIBE_POST` or
  `LANGMAIL_MCP_ALLOW_REMOTE_IMAGES`.

If you believe you have found a way for the server to leak credentials, mail,
calendar or contact data, or to send traffic anywhere but the configured
Stalwart without an opt-in, please report it using the process above.
