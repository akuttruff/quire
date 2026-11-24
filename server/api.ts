import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin } from 'vite'
import { MAX_BODY, TRASH_DAYS } from '../src/types.ts'
import { HealthCheck } from './health.ts'
import { ConflictError, Store } from './store.ts'

export interface ApiOptions {
  dir?: string
  store?: Store
  /** Clear out old trash once a day (the real and dev servers do; tests don't). */
  start?: boolean
}

export interface ApiState {
  store: Store
  health: HealthCheck
  timer: ReturnType<typeof setInterval> | null
}

type Handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => void

/** Bytes a request body may have: the largest note, every character up to four bytes, and room for the JSON around it. */
const BODY_LIMIT = MAX_BODY * 4 + 4096

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** A state-changing request must come from this app's own page, not from any tab on a tailnet device. */
function sameOrigin(req: IncomingMessage): boolean {
  const method = (req.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return true
  const origin = req.headers.origin
  if (!origin) return true // curl and scripts send none
  try { return new URL(origin).host === req.headers.host } catch { return false }
}

/** The request's JSON body, an object; {} when there is none. */
function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let refused = false
    req.on('data', (chunk: Buffer) => {
      if (refused) return // drain the rest so the answer still reaches the page
      size += chunk.length
      if (size > BODY_LIMIT) { refused = true; reject(new RequestError(413, 'That note is too long to save')); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (refused) return
      const text = Buffer.concat(chunks).toString('utf8')
      if (!text.trim()) return resolve({})
      try {
        const v = JSON.parse(text) as unknown
        if (!v || typeof v !== 'object' || Array.isArray(v)) return reject(new RequestError(400, 'Expected a JSON object'))
        resolve(v as Record<string, unknown>)
      } catch { reject(new RequestError(400, 'That is not JSON')) }
    })
    req.on('error', reject)
  })
}

function bodyText(v: unknown): string {
  if (typeof v !== 'string') throw new RequestError(400, 'body must be text')
  if (v.length > MAX_BODY) throw new RequestError(413, 'That note is too long to save')
  return v
}

export function createApiState(options: ApiOptions = {}): ApiState {
  const store = options.store ?? new Store(options.dir)
  const purged = store.purge()
  if (purged) console.log(`[quire] ${purged} note(s) left the trash after ${TRASH_DAYS} days`)
  const health = new HealthCheck({ app: 'quire', dataFile: store.file, busy: () => ({}) })
  let timer: ReturnType<typeof setInterval> | null = null
  if (options.start) {
    timer = setInterval(() => { store.purge() }, 86_400_000)
    timer.unref()
  }
  return { store, health, timer }
}

export function createMiddleware(state: ApiState): Handler {
  const { store } = state

  const route = async (req: IncomingMessage, res: ServerResponse, url: string, query: URLSearchParams, method: string): Promise<boolean> => {
    if (url === '/api/health' && method === 'GET') { json(res, 200, await state.health.report()); return true }

    if (url === '/api/notes' && method === 'GET') {
      json(res, 200, store.list({ q: query.get('q') ?? undefined, tag: query.get('tag') ?? undefined, trash: query.get('trash') === '1' }))
      return true
    }
    if (url === '/api/notes' && method === 'POST') {
      const body = await readBody(req)
      json(res, 201, store.create(body.body === undefined ? '' : bodyText(body.body)))
      return true
    }
    if (url === '/api/tags' && method === 'GET') { json(res, 200, store.tags()); return true }
    if (url === '/api/counts' && method === 'GET') { json(res, 200, store.counts()); return true }
    if (url === '/api/trash/empty' && method === 'POST') { json(res, 200, { removed: store.emptyTrash() }); return true }

    const m = /^\/api\/notes\/([0-9a-f]{16})(\/restore)?$/.exec(url)
    if (!m) return false
    const id = m[1]!
    if (m[2]) {
      if (method !== 'POST') return false
      const note = store.restore(id)
      if (note) json(res, 200, note); else json(res, 404, { error: 'No such note' })
      return true
    }

    if (method === 'GET') {
      const note = store.get(id)
      if (note) json(res, 200, note); else json(res, 404, { error: 'No such note' })
      return true
    }
    if (method === 'PATCH') {
      const body = await readBody(req)
      if (!store.get(id)) { json(res, 404, { error: 'No such note' }); return true }
      if ('pinned' in body && typeof body.pinned !== 'boolean') throw new RequestError(400, 'pinned must be true or false')
      if ('body' in body) {
        const text = bodyText(body.body)
        if (typeof body.baseUpdatedAt !== 'number') throw new RequestError(400, 'baseUpdatedAt is needed with a body: the updatedAt of the copy that was edited')
        store.saveBody(id, text, body.baseUpdatedAt)
      }
      if (typeof body.pinned === 'boolean') store.setPinned(id, body.pinned)
      json(res, 200, store.get(id))
      return true
    }
    if (method === 'DELETE') {
      if (query.get('forever') === '1') {
        const note = store.get(id)
        if (!note) { json(res, 404, { error: 'No such note' }); return true }
        if (note.deletedAt === null) throw new RequestError(409, 'Only a note in the trash can be deleted for good')
        store.destroy(id)
        json(res, 200, { ok: true })
        return true
      }
      const note = store.trash(id)
      if (note) json(res, 200, note); else json(res, 404, { error: 'No such note' })
      return true
    }
    return false
  }

  return (req, res, next) => {
    const [rawUrl = ''] = (req.url ?? '').split('?')
    if (!rawUrl.startsWith('/api/')) return next()
    if (!sameOrigin(req)) return json(res, 403, { error: 'cross-origin write refused' })
    const url = rawUrl.replace(/\/+$/, '')
    const query = new URL(req.url ?? '/', 'http://x').searchParams
    const method = (req.method ?? 'GET').toUpperCase()
    route(req, res, url, query, method).then(
      (handled) => { if (!handled) json(res, 404, { error: `No such route: ${method} ${url}` }) },
      (err: unknown) => {
        if (err instanceof ConflictError) return json(res, 409, { error: err.message, current: err.current })
        if (err instanceof RequestError) return json(res, err.status, { error: err.message })
        console.log(`[quire] ${(err as Error).message}`)
        json(res, 500, { error: (err as Error).message || String(err) })
      },
    )
    return undefined
  }
}

const shared = globalThis as { __quireApi?: Map<string, ApiState> }

/** The API as a Vite plugin, for `vite dev` and `vite preview` alike; one state per data dir survives a config reload. */
export default function api(options: ApiOptions = {}): Plugin {
  const states = (shared.__quireApi ??= new Map())
  const key = options.dir ?? '.data'
  let state = states.get(key)
  if (!state) {
    state = createApiState({ start: true, ...options })
    states.set(key, state)
  }
  const middleware = createMiddleware(state)
  return {
    name: 'quire-api',
    configureServer(server) { server.middlewares.use(middleware) },
    configurePreviewServer(server) { server.middlewares.use(middleware) },
  }
}
