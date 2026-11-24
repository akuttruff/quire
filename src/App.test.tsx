import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { EditorView } from '@codemirror/view'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiState, createMiddleware } from '../server/api.ts'
import type { ApiState } from '../server/api.ts'
import App from './App.tsx'

// The page talks to the real API over a real socket, backed by a scratch database.
const realFetch = globalThis.fetch
let dir: string
let state: ApiState
let server: http.Server

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quire-app-'))
  state = createApiState({ dir })
  const mw = createMiddleware(state)
  server = http.createServer((req, res) => mw(req, res, () => { res.writeHead(404); res.end() }))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => realFetch(`${base}${url}`, init))
  window.location.hash = ''
})
afterEach(async () => {
  await new Promise((r) => server.close(r))
  state.store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Type at the end of the note, as the editor would take keystrokes. */
async function typeInNote(text: string): Promise<void> {
  const view = EditorView.findFromDOM(await screen.findByRole('textbox', { name: 'Note' }))!
  const end = view.state.doc.length
  view.dispatch({ changes: { from: end, insert: text }, selection: { anchor: end + text.length }, userEvent: 'input.type' })
}

describe('App', () => {
  it('makes a note, saves it as you type, and lists it', async () => {
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('No notes yet.')
    await user.click(screen.getByRole('button', { name: 'New note' }))
    await typeInNote('Shopping #home\n[] milk')
    await waitFor(() => expect(state.store.list()[0]?.title).toBe('Shopping #home'), { timeout: 3000 })
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Saved'))
    const [saved] = state.store.list()
    expect(saved!.title).toBe('Shopping #home')
    expect(state.store.get(saved!.id)!.tags).toEqual(['home'])
    expect(saved!.snippet).toBe('milk')
    expect(window.location.hash).toBe(`#/n/${saved!.id}`)
  })

  it('draws tasks as boxes, typed with or without the bullet, and saves a tick', async () => {
    const n = state.store.create('List\n- [ ] milk\n[] bread')
    window.location.hash = `#/n/${n.id}`
    render(<App />)
    const boxes = await screen.findAllByRole('checkbox')
    expect(boxes).toHaveLength(2)
    fireEvent.mouseDown(boxes[1]!)
    await waitFor(() => expect(state.store.get(n.id)!.body).toBe('List\n- [ ] milk\n[x] bread'), { timeout: 3000 })
    expect(await screen.findByRole('checkbox', { name: 'Done' })).toBeInTheDocument()
  })

  it('makes the cursor line a task with the checkbox button', async () => {
    const n = state.store.create('Groceries')
    window.location.hash = `#/n/${n.id}`
    const user = userEvent.setup()
    render(<App />)
    const view = EditorView.findFromDOM(await screen.findByRole('textbox', { name: 'Note' }))!
    view.dispatch({ selection: { anchor: view.state.doc.length } })
    await typeInNote('\n')
    await user.click(screen.getByRole('button', { name: 'Checkbox' }))
    await typeInNote('eggs')
    await waitFor(() => expect(state.store.get(n.id)!.body).toBe('Groceries\n- [ ] eggs'), { timeout: 3000 })
  })

  it('moves a note to the trash with an Undo', async () => {
    const n = state.store.create('Keep me')
    const user = userEvent.setup()
    render(<App />)
    await user.click(await screen.findByRole('button', { name: /Keep me/ }))
    await user.click(await screen.findByRole('button', { name: 'Move to trash' }))
    await screen.findByText('Moved to the trash')
    expect(state.store.get(n.id)!.deletedAt).not.toBeNull()
    await user.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(state.store.get(n.id)!.deletedAt).toBeNull())
    expect(await screen.findByRole('button', { name: /Keep me/ })).toBeInTheDocument()
  })

  it('searches, and filters by tag', async () => {
    state.store.create('Garden\ntomatoes #outside', 1000)
    state.store.create('Work\nplanning #office', 2000)
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('button', { name: /Garden/ })
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'tomat')
    await waitFor(() => expect(screen.queryByRole('button', { name: /Work/ })).not.toBeInTheDocument())
    expect(within(screen.getByRole('button', { name: /Garden/ })).getByText('tomatoes', { selector: 'mark' })).toBeInTheDocument()
    await user.clear(screen.getByRole('searchbox', { name: 'Search' }))
    await user.click(await screen.findByRole('button', { name: /#office/, pressed: false }))
    await waitFor(() => expect(screen.queryByRole('button', { name: /Garden/ })).not.toBeInTheDocument())
  })

  it('offers both versions when the note changed elsewhere', async () => {
    const n = state.store.create('one')
    window.location.hash = `#/n/${n.id}`
    const user = userEvent.setup()
    render(<App />)
    await screen.findByRole('textbox', { name: 'Note' })
    state.store.saveBody(n.id, 'changed on the phone', n.updatedAt)
    await typeInNote(' and two')
    await screen.findByRole('alert', {}, { timeout: 3000 })
    expect(state.store.get(n.id)!.body).toBe('changed on the phone')
    await user.click(screen.getByRole('button', { name: 'Keep mine' }))
    await waitFor(() => expect(state.store.get(n.id)!.body).toBe('one and two'))
  })

  it('throws away a new note left empty', async () => {
    const user = userEvent.setup()
    render(<App />)
    await screen.findByText('No notes yet.')
    await user.click(screen.getByRole('button', { name: 'New note' }))
    await screen.findByRole('textbox', { name: 'Note' })
    expect(state.store.counts().notes).toBe(1)
    await user.click(screen.getByRole('button', { name: 'Back to notes' }))
    await waitFor(() => expect(state.store.counts()).toEqual({ notes: 0, trash: 0 }))
  })
})
