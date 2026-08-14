// The email-viewer view — runs inside the host's sandboxed iframe, not on
// the server. Bundled to a single inline <script> by viewer-resource.ts.
//
// Data flow: the host forwards preview_email's full tool result via
// ui/notifications/tool-result; this view reads the sanitized document from
// result _meta and the header fields from structuredContent, then renders
// the document into a nested script-less iframe. The nested iframe keeps
// `allow-same-origin` (and nothing else) so this shell can measure the
// document's height; with scripts disabled that grant is inert.

import { App } from '@modelcontextprotocol/ext-apps'

import { PREVIEW_META_KEY, type PreviewPayload } from '../meta.ts'

interface HeaderFields {
  date?: string
  from?: string
  subject?: string
}

const el = (id: string): HTMLElement => {
  const node = document.getElementById(id)
  if (!node) {
    throw new Error(`viewer shell is missing #${id}`)
  }
  return node
}

const renderHeader = (fields: HeaderFields): void => {
  el('subject').textContent = fields.subject ?? '(no subject)'
  el('from').textContent = fields.from ?? ''
  el('date').textContent = fields.date ? new Date(fields.date).toLocaleString() : ''
}

const renderBody = (payload: PreviewPayload): void => {
  const frame = el('frame') as HTMLIFrameElement
  // once: a later toolresult re-renders and attaches its own listener.
  frame.addEventListener(
    'load',
    () => {
      const doc = frame.contentDocument
      if (!doc) {
        return
      }
      // Let the email breathe at its natural height; the App SDK's autoResize
      // reports the resulting shell size to the host.
      doc.body.style.margin = '12px'
      frame.style.height = `${Math.min(doc.documentElement.scrollHeight + 24, 4000)}px`
    },
    { once: true }
  )
  frame.srcdoc = payload.html
}

const app = new App({ name: 'langmail-email-viewer', version: '0.1.0' }, {}, { autoResize: true })

app.addEventListener('toolresult', (result) => {
  const meta = (result._meta ?? {}) as Record<string, unknown>
  const payload = meta[PREVIEW_META_KEY] as PreviewPayload | undefined
  renderHeader((result.structuredContent ?? {}) as HeaderFields)
  if (payload?.html) {
    renderBody(payload)
  } else {
    el('subject').textContent = 'No preview data received.'
  }
})

// No top-level await — the bundle is an IIFE inlined into the template.
app.connect().catch(() => {
  el('subject').textContent = 'Could not connect to the host.'
})
