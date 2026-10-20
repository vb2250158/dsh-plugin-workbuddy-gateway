/**
 * Minimal HTTP helpers for this plugin's routes: JSON serialization, a
 * same-origin guard for mutating endpoints, and a size-capped body reader.
 * Mirrors the conventions the other community plugins on this host use.
 *
 * @module dsh-plugin-workbuddy-gateway/http
 */

/** Write one JSON payload with no-store caching. */
export function sendJson(response, status, payload) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  response.end(JSON.stringify(payload))
}

/** Header value the bundled client sends through the Desktop bridge. */
const DESKTOP_REQUEST_HEADER = 'x-dsh-workbuddy-request'

/** Header value that identifies a request created by the bundled client. */
const DESKTOP_REQUEST_VALUE = 'desktop'

/**
 * True when the request's Origin matches its Host, or when the bundled Desktop
 * client identifies a request whose Origin the bridge removed. Required on
 * every route that changes host state, so a cross-site page cannot reach it.
 */
export function sameOrigin(request) {
  const origin = request.headers.origin
  const host = request.headers.host
  if (host === undefined) return false
  // Some Desktop forwarding paths preserve the app Origin instead of
  // removing it before reaching the local HTTP host.
  if (origin === 'dsh-app://app') return true
  // DSH Desktop strips Origin while forwarding requests to its local HTTP
  // host. The client marker survives that hop even when Referer is absent.
  if (origin === undefined) {
    if (request.headers[DESKTOP_REQUEST_HEADER] === DESKTOP_REQUEST_VALUE) return true
    // Keep accepting the exact app Referer for older clients that predate the
    // marker. It is only a fallback when Origin is missing.
    const referer = request.headers.referer
    if (typeof referer !== 'string') return false
    try {
      const url = new URL(referer)
      return url.protocol === 'dsh-app:' && url.hostname === 'app'
    } catch {
      return false
    }
  }
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/** Read and parse a JSON request body, rejecting anything over the cap. */
export async function readJsonBody(request, maxBytes = 65536) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

/** Answer a route that was called with the wrong verb. */
export function methodNotAllowed(response, allow) {
  response.writeHead(405, { allow, 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ ok: false, error: { code: 'method-not-allowed', message: `use ${allow}` } }))
}

/** Answer a mutating route reached from another origin. */
export function refuseOrigin(response) {
  sendJson(response, 403, {
    ok: false,
    error: { code: 'cross-origin', message: 'this route only accepts same-origin requests' },
  })
}

/** Turn any thrown value into a message that is safe to serialize. */
export function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}
