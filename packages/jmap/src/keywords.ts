// Bulwark's keyword convention. Agent/label keywords are namespaced under
// `$label:` so Bulwark (and the webmail) render them as label chips; a bare
// keyword like `receipt` is invisible in that UI. Defined here exactly once
// so the MCP search filters and the email-agent's keyword writes (Phase 2)
// share one prefix. Mirrors `BULWARK_LABEL_PREFIX` in
// `services/email-sync/src/stalwart/mapping.rs` (which projects Gmail's
// free-form labels); agent keywords use the lowercased `internalLabel`
// verbatim as the suffix — no slug/sanitize pass.
export const LABEL_KEYWORD_PREFIX = '$label:'

// Build the JMAP keyword string for a label suffix, e.g. `receipt` ->
// `$label:receipt`. The suffix is used verbatim (no lowercasing or slug pass);
// callers are responsible for passing an already-lowercased, slug-stable value.
export const toLabelKeyword = (suffix: string): string => `${LABEL_KEYWORD_PREFIX}${suffix}`
