// @vitest-environment node
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Note, NoteSummary } from '../src/types.ts'
import { createApiState, createMiddleware } from './api.ts'
import type { ApiState } from './api.ts'

let dir: string
let state: ApiState
let server: http.Server
let base: string

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quire-api-'))
  state = createApiState({ dir })
  const mw = createMiddleware(state)
  server = http.createServer((req, res) => mw(req, res, () => { res.writeHead(404); res.end('not api') }))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
  await new Promise((r) => server.close(r))
  state.store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

const send = async <T,>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: T }> => {
  const res = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, body: (await res.json()) as T }
}

describe('api', () => {
  it('creates, saves, lists and searches notes', async () => {
    const made = await send<Note>('POST', '/api/notes', { body: 'Hello #greeting' })
    expect(made.status).toBe(201)
    const saved = await send<Note>('PATCH', `/api/notes/${made.body.id}`, { body: 'Hello world #greeting', baseUpdatedAt: made.body.updatedAt })
    expect(saved.body.body).toBe('Hello world #greeting')
    const list = await send<NoteSummary[]>('GET', '/api/notes?q=wor')
    expect(list.body.map((n) => n.title)).toEqual(['Hello world #greeting'])
    expect((await send<unknown>('GET', '/api/tags')).body).toEqual([{ tag: 'greeting', n: 1 }])
    expect((await send<NoteSummary[]>('GET', '/api/notes?tag=greeting')).body).toHaveLength(1)
  })

  it('answers a stale save with 409 and the note as it is now', async () => {
    const n = (await send<Note>('POST', '/api/notes', { body: 'v1' })).body
    await send('PATCH', `/api/notes/${n.id}`, { body: 'v2', baseUpdatedAt: n.updatedAt })
    const stale = await send<{ current: Note }>('PATCH', `/api/notes/${n.id}`, { body: 'v3', baseUpdatedAt: n.updatedAt, pinned: true })
    expect(stale.status).toBe(409)
    expect(stale.body.current.body).toBe('v2')
    // The refused save pinned nothing either.
    expect((await send<Note>('GET', `/api/notes/${n.id}`)).body.pinned).toBe(false)
  })

  it('needs the base copy with a body, and checks types', async () => {
    const n = (await send<Note>('POST', '/api/notes')).body
    expect((await send('PATCH', `/api/notes/${n.id}`, { body: 'x' })).status).toBe(400)
    expect((await send('PATCH', `/api/notes/${n.id}`, { pinned: 'yes' })).status).toBe(400)
    expect((await send('POST', '/api/notes', { body: 5 })).status).toBe(400)
    expect((await send<Note>('PATCH', `/api/notes/${n.id}`, { pinned: true })).body.pinned).toBe(true)
  })

  it('trashes, restores, and deletes for good only from the trash', async () => {
    const n = (await send<Note>('POST', '/api/notes', { body: 'bye' })).body
    expect((await send('DELETE', `/api/notes/${n.id}?forever=1`)).status).toBe(409)
    expect((await send<Note>('DELETE', `/api/notes/${n.id}`)).body.deletedAt).not.toBeNull()
    expect((await send<NoteSummary[]>('GET', '/api/notes')).body).toEqual([])
    expect((await send<NoteSummary[]>('GET', '/api/notes?trash=1')).body).toHaveLength(1)
    expect((await send<Note>('POST', `/api/notes/${n.id}/restore`)).body.deletedAt).toBeNull()
    await send('DELETE', `/api/notes/${n.id}`)
    expect((await send('DELETE', `/api/notes/${n.id}?forever=1`)).status).toBe(200)
    expect((await send('GET', `/api/notes/${n.id}`)).status).toBe(404)
  })

  it('empties the trash and counts', async () => {
    const n = (await send<Note>('POST', '/api/notes', { body: 'a' })).body
    await send('POST', '/api/notes', { body: 'b' })
    await send('DELETE', `/api/notes/${n.id}`)
    expect((await send('GET', '/api/counts')).body).toEqual({ notes: 1, trash: 1 })
    expect((await send('POST', '/api/trash/empty')).body).toEqual({ removed: 1 })
  })

  it('refuses a write from another site, bad JSON, and a note too long', async () => {
    expect((await send('POST', '/api/notes', { body: 'x' }, { Origin: 'https://evil.example' })).status).toBe(403)
    const bad = await fetch(`${base}/api/notes`, { method: 'POST', body: '{nope' })
    expect(bad.status).toBe(400)
    expect((await send('POST', '/api/notes', { body: 'x'.repeat(500_001) })).status).toBe(413)
  })

  it('says what it does not know, and leaves other paths to the page', async () => {
    expect((await send('GET', '/api/nope')).status).toBe(404)
    expect((await send('GET', '/api/notes/0123456789abcdef')).status).toBe(404)
    expect(await (await fetch(`${base}/index.html`)).text()).toBe('not api')
  })

  it('reports health in the shared shape', async () => {
    const h = (await send<{ ok: boolean; app: string; data: { file: string } }>('GET', '/api/health')).body
    expect(h.app).toBe('quire')
    expect(h.ok).toBe(true)
    expect(h.data.file).toMatch(/quire\.sqlite$/)
  })
})
