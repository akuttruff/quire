import { useCallback, useEffect, useRef, useState } from 'react'
import Editor from './components/Editor.tsx'
import NoteList from './components/NoteList.tsx'
import { api } from './lib/api.ts'
import type { Note, NoteSummary, TagCount } from './types.ts'

/** How long a deleted note's Undo stays on screen. */
export const UNDO_MS = 6000
const SEARCH_DELAY_MS = 200

/** The open note, from the address: `#/n/<id>`; null on the list. */
const noteFromHash = (): string | null => /^#\/n\/([0-9a-f]{16})$/.exec(window.location.hash)?.[1] ?? null

interface Toast { text: string; undo?: () => void }

export default function App() {
  const [openId, setOpenId] = useState<string | null>(noteFromHash)
  const [notes, setNotes] = useState<NoteSummary[] | null>(null)
  const [tags, setTags] = useState<TagCount[]>([])
  const [trashCount, setTrashCount] = useState(0)
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState<string | null>(null)
  const [trash, setTrash] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState(0)
  const [toast, setToast] = useState<Toast | null>(null)
  // Whether the note was opened from the list in this tab, so Back can step back rather than add a page.
  const pushed = useRef(false)

  const refresh = useCallback(() => setVersion((v) => v + 1), [])

  useEffect(() => {
    const onHash = (): void => setOpenId(noteFromHash())
    window.addEventListener('hashchange', onHash)
    // Back from another app or device: what's there may have changed.
    const onVisible = (): void => { if (document.visibilityState === 'visible') refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('hashchange', onHash)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  // Typing in the search box waits for a pause before asking the server.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q), SEARCH_DELAY_MS)
    return () => clearTimeout(t)
  }, [q])

  useEffect(() => {
    let live = true
    Promise.all([api.list({ q: query, tag: trash ? null : tag, trash }), api.tags(), api.counts()]).then(([n, t, c]) => {
      if (!live) return
      setNotes(n)
      setTags(t)
      setTrashCount(c.trash)
      setError(null)
    }, (err: unknown) => { if (live) setError(`Can’t reach Quire: ${(err as Error).message}`) })
    return () => { live = false }
  }, [query, tag, trash, version])

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), UNDO_MS)
    return () => clearTimeout(t)
  }, [toast])

  const open = (id: string): void => {
    pushed.current = true
    window.location.hash = `#/n/${id}`
  }
  const back = (): void => {
    if (pushed.current) { pushed.current = false; window.history.back() } else window.location.replace('#/')
  }

  const newNote = async (): Promise<void> => {
    try {
      const n = await api.create('')
      setTrash(false)
      open(n.id)
    } catch (err) { setError(`Couldn’t make a note: ${(err as Error).message}`) }
  }

  const onTrashed = (note: Note): void => {
    back()
    refresh()
    setToast({
      text: 'Moved to the trash',
      undo: () => {
        void api.restore(note.id).then(() => { refresh(); setToast(null) }, (err: unknown) => setError((err as Error).message))
      },
    })
  }

  const onDestroyed = (id: string): void => {
    if (openId === id) back()
    refresh()
  }

  const showTag = (t: string | null): void => {
    setTag(t)
    setTrash(false)
    if (openId) back()
  }

  const emptyTrash = async (): Promise<void> => {
    if (!window.confirm('Delete everything in the trash for good?')) return
    try {
      await api.emptyTrash()
      refresh()
    } catch (err) { setError((err as Error).message) }
  }

  return (
    <div className={`app ${openId ? 'note-open' : ''}`}>
      <NoteList
        notes={notes} tags={tags} trashCount={trashCount} q={q} tag={tag} trash={trash} selectedId={openId} error={error}
        onQuery={setQ} onTag={showTag} onTrash={(t) => { setTrash(t); setQ('') }} onOpen={open}
        onNew={() => { void newNote() }} onEmptyTrash={() => { void emptyTrash() }}
      />
      {openId ? (
        <Editor key={openId} id={openId} onBack={back} onChanged={refresh} onTrashed={onTrashed} onDestroyed={onDestroyed} onTag={showTag} />
      ) : (
        <section className="editor placeholder" aria-hidden><p className="empty">Choose a note, or make a new one.</p></section>
      )}
      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.undo && <button type="button" className="text-btn primary" onClick={toast.undo}>Undo</button>}
        </div>
      )}
    </div>
  )
}
