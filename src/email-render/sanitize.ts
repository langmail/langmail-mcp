// Sanitize an email's text/html part for rendering inside the MCP Apps
// email-viewer iframe. Security-relevant: the input is authored by an
// arbitrary sender. Scripts, event handlers, forms, and embedded frames are
// removed; presentational markup (2005-era table layouts, inline styles,
// <style> blocks) is kept so tickets and invoices render at full fidelity.
//
// Images never load from sender-controlled origins. Every <img> src is
// rewritten through the caller's resolvers: `cid:` parts to a same-origin
// capability URL (ADR 0007 ticket machinery), remote URLs to the image
// proxy. Unresolvable images are dropped. data: URIs (restricted to
// data:image/) pass through — an inline QR code is exactly this shape.

import sanitizeHtml from 'sanitize-html'

export interface EmailHtmlResolvers {
  // Capability URL for a Content-ID referenced part, or null when the
  // message has no such part (the image is dropped).
  resolveCid: (cid: string) => string | null
  // Proxied URL for a remote image, or null to refuse (the image is dropped).
  resolveRemote: (url: string) => string | null
}

// Transform target for refused images; not in allowedTags, so sanitize-html
// removes it in the same pass.
const DROP_TAG = 'x-dropped-img'

// Raster subtypes only: data:image/svg+xml is the one image shape that can
// carry markup/script, and nothing legitimate in email needs it inline.
export const DATA_IMAGE_RE = /^data:image\/(?:png|jpeg|jpg|gif|webp|avif)[;,]/i
const REMOTE_RE = /^https?:\/\//i

const resolveImgSrc = (src: string | undefined, resolvers: EmailHtmlResolvers): string | null => {
  if (!src) {
    return null
  }
  if (src.startsWith('cid:')) {
    return resolvers.resolveCid(src.slice('cid:'.length))
  }
  if (DATA_IMAGE_RE.test(src)) {
    return src
  }
  if (REMOTE_RE.test(src)) {
    return resolvers.resolveRemote(src)
  }
  return null
}

// Presentational attributes legacy email HTML leans on, allowed on any tag.
const PRESENTATION_ATTRIBUTES = [
  'align',
  'valign',
  'bgcolor',
  'width',
  'height',
  'border',
  'cellpadding',
  'cellspacing',
  'class',
  'dir',
  'lang',
  'style',
]

export const sanitizeEmailHtml = (html: string, resolvers: EmailHtmlResolvers): string =>
  sanitizeHtml(html, {
    allowedAttributes: {
      '*': PRESENTATION_ATTRIBUTES,
      a: [...PRESENTATION_ATTRIBUTES, 'href', 'name'],
      img: [...PRESENTATION_ATTRIBUTES, 'src', 'alt'],
      td: [...PRESENTATION_ATTRIBUTES, 'colspan', 'rowspan'],
      th: [...PRESENTATION_ATTRIBUTES, 'colspan', 'rowspan'],
    },
    // Links may point anywhere (the iframe sandbox governs navigation);
    // javascript:/data: hrefs are stripped by the scheme filter.
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    // Every img src surviving the transform below is either a vetted raster
    // data: URI or a URL our own resolvers minted under MCP_PUBLIC_URL —
    // http is in the list because the dev public URL is http, not because
    // sender-supplied http images are allowed (the transform already
    // rewrote or dropped those).
    allowedSchemesByTag: { img: ['http', 'https', 'data'] },
    allowedTags: [...sanitizeHtml.defaults.allowedTags, 'img', 'style', 'center', 'font', 'u', 'big', 'small'],
    // <style> is required for real-world email layouts and is the one allowed
    // tag sanitize-html flags. The residual risk is CSS-initiated requests
    // (url(...)), and those are contained a layer down: the viewer renders
    // this HTML in a script-less sandboxed iframe whose host-enforced CSP
    // only permits the origins the template declares.
    allowVulnerableTags: true,
    transformTags: {
      img: (tagName, attribs) => {
        const src = resolveImgSrc(attribs.src, resolvers)
        if (!src) {
          return { attribs: {}, tagName: DROP_TAG }
        }
        return { attribs: { ...attribs, src }, tagName }
      },
    },
  })
