const PREFIX = '/plugins/dsh-apifox-sync'

function json(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(payload)),
  })
  response.end(payload)
}

function sameOrigin(request) {
  const origin = request.headers.origin
  if (origin === undefined) return true
  const host = request.headers.host
  if (!host) return false
  try { return new URL(origin).host === host } catch { return false }
}

async function bodyOf(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 256 * 1024) throw new Error('请求内容过大。')
    chunks.push(buffer)
  }
  if (!size) return {}
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请求内容必须是 JSON 对象。')
  return body
}

function directoryOf(body) {
  if (typeof body.dir !== 'string' || !body.dir.trim()) throw new Error('缺少项目目录。')
  return body.dir.trim()
}

export function registerRoutes(ctx, service) {
  const disposers = []
  const register = (name, handler) => {
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: `${PREFIX}/${name}`,
      handler: (request, response) => {
        if (request.method !== 'POST') return json(response, 405, { message: '请使用 POST。' })
        if (!sameOrigin(request)) return json(response, 403, { message: '拒绝跨域请求。' })
        const controller = new AbortController()
        request.once('aborted', () => controller.abort())
        Promise.resolve()
          .then(() => bodyOf(request))
          .then(body => handler(body, controller.signal))
          .then(result => json(response, 200, result))
          .catch(error => json(response, 400, {
            error: 'apifox-sync-failed',
            message: error instanceof Error ? error.message : String(error),
          }))
      },
    }))
  }
  register('status', body => service.status(directoryOf(body)))
  register('scan', (body, signal) => service.scan(directoryOf(body), { signal }))
  register('upload', (body, signal) => service.uploadSelected(
    directoryOf(body),
    body.endpointIds,
    body.expectedFingerprints && typeof body.expectedFingerprints === 'object' ? body.expectedFingerprints : {},
    { signal },
  ))
  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

export { PREFIX }
