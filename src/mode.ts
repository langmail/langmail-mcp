// Which server this process is. `hosted` is Langmail's own (src/index.ts):
// Better Auth sign-in, calendar sharing and agent activity through Auth, and
// mail the email-agent has classified. `self-hosted` is someone's own Stalwart
// with a username and app password (src/self-hosted.ts): none of those exist,
// so the tools that depend on them are left out or worded without them. The
// entrypoint decides the mode; nothing guesses it from the environment.
export type ServerMode = 'hosted' | 'self-hosted'
