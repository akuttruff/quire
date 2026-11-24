import type { Note, NoteSummary, TagCount } from '../types.ts'

/** A request the server answered with an error; `body` is what it said (a 409 carries the note as it is now). */
export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly body: Record<string, unknown>) { super(message) }
}

async function call<T>(method: string, url: string, body?: unknown, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...init,
  })
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new ApiError(res.status, typeof data.error === 'string' ? data.error : `HTTP ${res.status}`, data)
  return data as T
}

export interface ListQuery { q?: string; tag?: string | null; trash?: boolean }

export const api = {
  list: ({ q, tag, trash }: ListQuery = {}): Promise<NoteSummary[]> => {
    const p = new URLSearchParams()
    if (q?.trim()) p.set('q', q.trim())
    if (tag) p.set('tag', tag)
    if (trash) p.set('trash', '1')
    const s = p.toString()
    return call('GET', `/api/notes${s ? `?${s}` : ''}`)
  },
  tags: (): Promise<TagCount[]> => call('GET', '/api/tags'),
  counts: (): Promise<{ notes: number; trash: number }> => call('GET', '/api/counts'),
  get: (id: string): Promise<Note> => call('GET', `/api/notes/${id}`),
  create: (body = ''): Promise<Note> => call('POST', '/api/notes', { body }),
  /** `keepalive` lets a save sent as the page goes away still arrive (small notes only: browsers cap it at 64 KB). */
  save: (id: string, body: string, baseUpdatedAt: number, keepalive = false): Promise<Note> =>
    call('PATCH', `/api/notes/${id}`, { body, baseUpdatedAt }, { keepalive: keepalive && body.length < 60_000 }),
  pin: (id: string, pinned: boolean): Promise<Note> => call('PATCH', `/api/notes/${id}`, { pinned }),
  trash: (id: string): Promise<Note> => call('DELETE', `/api/notes/${id}`),
  restore: (id: string): Promise<Note> => call('POST', `/api/notes/${id}/restore`),
  destroy: (id: string): Promise<{ ok: true }> => call('DELETE', `/api/notes/${id}?forever=1`),
  emptyTrash: (): Promise<{ removed: number }> => call('POST', '/api/trash/empty'),
}
