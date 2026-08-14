// Shared between the preview_email tool (server) and the email-viewer view
// (browser bundle) — keep this module dependency-free so the view bundle
// stays lean.

// The pre-declared MCP Apps template (SEP-1865) the preview_email tool
// binds to via _meta.ui.resourceUri.
export const EMAIL_VIEWER_RESOURCE_URI = 'ui://langmail/email-viewer'

// Result-_meta key carrying the sanitized document from tool to view. _meta
// is forwarded to the iframe via ui/notifications/tool-result but is not
// model context — that separation is the point (the body can be huge).
export const PREVIEW_META_KEY = 'me.langmail/email-preview'

export interface PreviewPayload {
  html: string
  renderSource: 'html' | 'text'
}
