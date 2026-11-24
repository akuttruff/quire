// @vitest-environment node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConflictError, Store, ftsQuery } from './store.ts'

let dir: string
let store: Store

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quire-store-'))
  store = new Store(dir)
})
afterEach(() => {
  store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('Store', () => {
  it('creates, saves and reads a note, with its tags kept up to date', () => {
    const n = store.create('Plans #work', 1000)
    expect(n.tags).toEqual(['work'])
    const saved = store.saveBody(n.id, 'Plans #home #idea', n.updatedAt, 2000)!
    expect(saved.body).toBe('Plans #home #idea')
    expect(saved.updatedAt).toBe(2000)
    expect(store.get(n.id)!.tags).toEqual(['home', 'idea'])
    expect(store.tags()).toEqual([{ tag: 'home', n: 1 }, { tag: 'idea', n: 1 }])
  })

  it('refuses a save from a stale copy, carrying the note as it is now', () => {
    const n = store.create('one', 1000)
    store.saveBody(n.id, 'two', n.updatedAt, 2000)
    expect(() => store.saveBody(n.id, 'three', n.updatedAt, 3000)).toThrow(ConflictError)
    try { store.saveBody(n.id, 'three', n.updatedAt) } catch (err) { expect((err as ConflictError).current.body).toBe('two') }
    expect(store.get(n.id)!.body).toBe('two')
  })

  it('moves the time on even for two saves in one millisecond', () => {
    const n = store.create('a', 5000)
    const one = store.saveBody(n.id, 'b', n.updatedAt, 5000)!
    const two = store.saveBody(n.id, 'c', one.updatedAt, 5000)!
    expect(two.updatedAt).toBeGreaterThan(one.updatedAt)
  })

  it('pins without counting it as an edit', () => {
    const n = store.create('a', 1000)
    store.create('b', 2000)
    const pinned = store.setPinned(n.id, true)!
    expect(pinned.updatedAt).toBe(1000)
    expect(store.list().map((s) => s.title)).toEqual(['a', 'b'])
    expect(store.saveBody(n.id, 'a2', n.updatedAt)).not.toBeNull()
  })

  it('lists newest first with titles and previews', () => {
    store.create('Older\nbody one', 1000)
    store.create('Newer\nbody two', 2000)
    expect(store.list().map((s) => [s.title, s.snippet])).toEqual([['Newer', 'body two'], ['Older', 'body one']])
  })

  it('searches by word prefix, marking the matches', () => {
    store.create('Garden plans\nTomatoes and basil', 1000)
    store.create('Work\nquarterly planning', 2000)
    const hits = store.list({ q: 'tomat' })
    expect(hits.map((h) => h.title)).toEqual(['Garden plans'])
    expect(hits[0]!.snippet).toContain('«Tomatoes»')
    expect(store.list({ q: 'plan' })).toHaveLength(2)
    expect(store.list({ q: 'plan basil' }).map((h) => h.title)).toEqual(['Garden plans'])
    store.create('Shop\n- [x] **ripe** figs', 3000)
    expect(store.list({ q: 'figs' })[0]!.snippet).toBe('Shop ripe «figs»')
  })

  it('treats search input as words, never as query syntax', () => {
    store.create('a "quoted" NEAR(thing) OR not', 1000)
    expect(store.list({ q: '"quoted' })).toHaveLength(1)
    expect(store.list({ q: 'NEAR(' })).toHaveLength(1)
    expect(store.list({ q: '***' })).toEqual([])
    expect(ftsQuery('a "b"')).toBe('"a"* "b"*')
  })

  it('keeps the index in step with edits', () => {
    const n = store.create('apples', 1000)
    store.saveBody(n.id, 'pears', n.updatedAt, 2000)
    expect(store.list({ q: 'apples' })).toEqual([])
    expect(store.list({ q: 'pears' })).toHaveLength(1)
  })

  it('searches by substring when there is no full-text index', () => {
    const plain = new Store(path.join(dir, 'plain'), { fts: false })
    plain.create('Tomatoes and basil', 1000)
    expect(plain.fts).toBe(false)
    expect(plain.list({ q: 'MATO' })).toHaveLength(1)
    expect(plain.list({ q: 'basil tomat' })).toHaveLength(1)
    expect(plain.list({ q: 'pears' })).toHaveLength(0)
    plain.close()
  })

  it('filters by tag, taking in nested tags but not lookalikes', () => {
    store.create('a #work', 1000)
    store.create('b #work/plans', 2000)
    store.create('c #workshop', 3000)
    expect(store.list({ tag: 'work' }).map((s) => s.title)).toEqual(['b #work/plans', 'a #work'])
    expect(store.list({ tag: '#Work/Plans' })).toHaveLength(1)
    expect(store.list({ q: 'b', tag: 'work' })).toHaveLength(1)
  })

  it('trashes, restores, and deletes for good only from the trash', () => {
    const n = store.create('gone #x', 1000)
    expect(store.destroy(n.id)).toBe(false)
    store.trash(n.id, 2000)
    expect(store.list()).toEqual([])
    expect(store.tags()).toEqual([])
    expect(store.list({ trash: true }).map((s) => s.deletedAt)).toEqual([2000])
    expect(store.counts()).toEqual({ notes: 0, trash: 1 })
    store.restore(n.id)
    expect(store.list()).toHaveLength(1)
    store.trash(n.id)
    expect(store.destroy(n.id)).toBe(true)
    expect(store.get(n.id)).toBeNull()
  })

  it('purges notes in the trash over 30 days, and empties the trash on request', () => {
    const day = 86_400_000
    const old = store.create('old', 0)
    const recent = store.create('recent', 0)
    store.create('live', 0)
    store.trash(old.id, 1 * day)
    store.trash(recent.id, 25 * day)
    expect(store.purge(40 * day)).toBe(1)
    expect(store.get(old.id)).toBeNull()
    expect(store.emptyTrash()).toBe(1)
    expect(store.counts()).toEqual({ notes: 1, trash: 0 })
  })

  it('keeps the notes across a reopen', () => {
    const n = store.create('kept #t', 1000)
    store.close()
    store = new Store(dir)
    expect(store.get(n.id)!.tags).toEqual(['t'])
    expect(store.list({ q: 'kept' })).toHaveLength(1)
  })
})
