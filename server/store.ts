import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { plainLine, previewOf, tagsOf, titleOf } from '../src/lib/note.ts'
import { TRASH_DAYS } from '../src/types.ts'
import type { Note, NoteSummary, TagCount } from '../src/types.ts'

/**
 * Everything Quire keeps, in one SQLite file: the notes, the tags read out of
 * them (kept so the list can filter and count without reading every body),
 * and a full-text index over the bodies. The title is never stored: it is
 * always the body's first line, so it can't fall out of step with it.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS notes_listed ON notes (deleted_at, pinned, updated_at);
CREATE TABLE IF NOT EXISTS note_tags (
  note_id TEXT NOT NULL REFERENCES notes (id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (note_id, tag)
);
CREATE INDEX IF NOT EXISTS note_tags_tag ON note_tags (tag);
`

/** The full-text index follows the notes table through triggers, so no write can forget it. */
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(body, content='notes', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts (rowid, body) VALUES (new.rowid, new.body);
END;
CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
END;
CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE OF body ON notes BEGIN
  INSERT INTO notes_fts (notes_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
  INSERT INTO notes_fts (rowid, body) VALUES (new.rowid, new.body);
END;
`

const VERSION = 1

interface NoteRow {
  id: string
  body: string
  pinned: number
  created_at: number
  updated_at: number
  deleted_at: number | null
}

/** A save that lost the race: the note changed after the copy being edited was read. */
export class ConflictError extends Error {
  constructor(readonly current: Note) { super('This note was changed somewhere else since it was opened') }
}

export const newId = (): string => randomBytes(8).toString('hex')

/** Search words as an FTS5 query: each one quoted (so nothing the person types is syntax) and matched as a prefix. */
export function ftsQuery(q: string): string | null {
  const words = q.split(/\s+/).map((w) => w.replace(/"/g, '')).filter((w) => /[\p{L}\p{N}]/u.test(w))
  return words.length ? words.map((w) => `"${w}"*`).join(' ') : null
}

/** A search snippet read like the list's previews: each line without its Markdown, the « » marks kept. */
const cleanSnippet = (snip: string): string => snip.split('\n').map((line) => {
  // A snippet cut mid-note starts with …; the Markdown to strip comes after it.
  const cut = line.startsWith('…')
  const plain = plainLine(cut ? line.slice(1) : line)
  return plain && cut ? `…${plain}` : plain
}).filter(Boolean).join(' ')

export interface ListOptions {
  q?: string
  tag?: string
  trash?: boolean
}

export class Store {
  readonly db: DatabaseSync
  readonly file: string
  /** False when this SQLite was built without FTS5; search then falls back to LIKE. */
  readonly fts: boolean

  constructor(dir = path.resolve('.data'), options: { fts?: boolean } = {}) {
    fs.mkdirSync(dir, { recursive: true })
    this.file = path.join(dir, 'quire.sqlite')
    this.db = new DatabaseSync(this.file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 2000')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec(SCHEMA)
    let fts = options.fts ?? true
    if (fts) {
      try { this.db.exec(FTS_SCHEMA) } catch (err) {
        console.log(`[quire] no full-text search (${(err as Error).message}); searching by substring`)
        fts = false
      }
    }
    this.fts = fts
    const { user_version: v } = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    if (v < VERSION) this.db.exec(`PRAGMA user_version = ${VERSION}`)
  }

  close(): void { this.db.close() }

  private tagsFor(id: string): string[] {
    return (this.db.prepare('SELECT tag FROM note_tags WHERE note_id = ? ORDER BY rowid').all(id) as { tag: string }[]).map((r) => r.tag)
  }

  private fromRow(r: NoteRow): Note {
    return {
      id: r.id, body: r.body, pinned: r.pinned === 1, tags: this.tagsFor(r.id),
      createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at,
    }
  }

  private setTags(id: string, body: string): void {
    this.db.prepare('DELETE FROM note_tags WHERE note_id = ?').run(id)
    const add = this.db.prepare('INSERT OR IGNORE INTO note_tags (note_id, tag) VALUES (?, ?)')
    for (const tag of tagsOf(body)) add.run(id, tag)
  }

  /** Several writes as one: all of them or none. */
  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  get(id: string): Note | null {
    const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined
    return row ? this.fromRow(row) : null
  }

  create(body = '', now = Date.now()): Note {
    const id = newId()
    this.tx(() => {
      this.db.prepare('INSERT INTO notes (id, body, pinned, created_at, updated_at) VALUES (?, ?, 0, ?, ?)').run(id, body, now, now)
      this.setTags(id, body)
    })
    return this.get(id)!
  }

  /**
   * A new body, checked against the `updatedAt` of the copy it was edited
   * from: when the note has moved on since, nothing is written and
   * ConflictError carries what it is now. Null when there is no such note.
   */
  saveBody(id: string, body: string, baseUpdatedAt: number, now = Date.now()): Note | null {
    return this.tx(() => {
      const row = this.db.prepare('SELECT * FROM notes WHERE id = ?').get(id) as NoteRow | undefined
      if (!row) return null
      if (row.updated_at !== baseUpdatedAt) throw new ConflictError(this.fromRow(row))
      if (row.body === body) return this.fromRow(row)
      // Strictly later than the last save, so two saves in one millisecond still tell apart.
      const at = Math.max(now, row.updated_at + 1)
      this.db.prepare('UPDATE notes SET body = ?, updated_at = ? WHERE id = ?').run(body, at, id)
      this.setTags(id, body)
      return this.fromRow({ ...row, body, updated_at: at })
    })
  }

  /** Pinning is not an edit: it leaves `updatedAt` (and so the order and any open editor's copy) alone. */
  setPinned(id: string, pinned: boolean): Note | null {
    const r = this.db.prepare('UPDATE notes SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id)
    return r.changes ? this.get(id) : null
  }

  trash(id: string, now = Date.now()): Note | null {
    this.db.prepare('UPDATE notes SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(now, id)
    return this.get(id)
  }

  restore(id: string): Note | null {
    this.db.prepare('UPDATE notes SET deleted_at = NULL WHERE id = ?').run(id)
    return this.get(id)
  }

  /** Gone for good; only a note already in the trash. False when it isn't there. */
  destroy(id: string): boolean {
    return this.db.prepare('DELETE FROM notes WHERE id = ? AND deleted_at IS NOT NULL').run(id).changes > 0
  }

  emptyTrash(): number {
    return Number(this.db.prepare('DELETE FROM notes WHERE deleted_at IS NOT NULL').run().changes)
  }

  /** Notes in the trash longer than TRASH_DAYS, removed. */
  purge(now = Date.now()): number {
    return Number(this.db.prepare('DELETE FROM notes WHERE deleted_at IS NOT NULL AND deleted_at < ?').run(now - TRASH_DAYS * 86_400_000).changes)
  }

  list(options: ListOptions = {}): NoteSummary[] {
    const where: string[] = [options.trash ? 'n.deleted_at IS NOT NULL' : 'n.deleted_at IS NULL']
    const params: (string | number)[] = []
    let from = 'notes n'
    let snippet = 'NULL'
    let order = options.trash ? 'n.deleted_at DESC' : 'n.pinned DESC, n.updated_at DESC'

    const q = options.q?.trim() ?? ''
    if (q) {
      const match = this.fts ? ftsQuery(q) : null
      if (this.fts && !match) return [] // only punctuation: nothing to look for
      if (match) {
        from = 'notes_fts f JOIN notes n ON n.rowid = f.rowid'
        where.push('notes_fts MATCH ?')
        params.push(match)
        snippet = `snippet(notes_fts, 0, '«', '»', '…', 14)`
        if (!options.trash) order = 'n.pinned DESC, bm25(notes_fts), n.updated_at DESC'
      } else {
        for (const word of q.split(/\s+/)) {
          where.push('instr(lower(n.body), ?) > 0')
          params.push(word.toLowerCase())
        }
      }
    }

    const tag = options.tag ? options.tag.toLowerCase().replace(/^#/, '') : ''
    if (tag) {
      // A tag takes in the ones nested under it: #work finds #work/plans too.
      where.push('EXISTS (SELECT 1 FROM note_tags t WHERE t.note_id = n.id AND (t.tag = ? OR substr(t.tag, 1, ?) = ?))')
      params.push(tag, tag.length + 1, `${tag}/`)
    }

    const rows = this.db.prepare(`SELECT n.*, ${snippet} AS snip FROM ${from} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 500`)
      .all(...params) as unknown as (NoteRow & { snip: string | null })[]
    return rows.map((r) => ({
      id: r.id,
      title: titleOf(r.body),
      snippet: r.snip != null ? cleanSnippet(r.snip) : previewOf(r.body),
      tags: this.tagsFor(r.id),
      pinned: r.pinned === 1,
      updatedAt: r.updated_at,
      deletedAt: r.deleted_at,
    }))
  }

  /** Each tag on a live note, with how many notes carry it. */
  tags(): TagCount[] {
    return this.db.prepare(`SELECT t.tag AS tag, COUNT(*) AS n FROM note_tags t JOIN notes n ON n.id = t.note_id
      WHERE n.deleted_at IS NULL GROUP BY t.tag ORDER BY n DESC, t.tag`).all() as unknown as TagCount[]
  }

  counts(): { notes: number; trash: number } {
    const r = this.db.prepare('SELECT SUM(deleted_at IS NULL) AS notes, SUM(deleted_at IS NOT NULL) AS trash FROM notes').get() as { notes: number | null; trash: number | null }
    return { notes: r.notes ?? 0, trash: r.trash ?? 0 }
  }
}
