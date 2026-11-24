import { ArrowLeft, Pin, PinOff, RotateCcw, SquareCheck, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, api } from '../lib/api.ts'
import { when } from '../lib/format.ts'
import type { Note } from '../types.ts'
import NoteEditor from './NoteEditor.tsx'
import type { NoteEditorHandle } from './NoteEditor.tsx'

/** How long typing must pause before the note is saved. */
export const SAVE_DELAY_MS = 600
/** How soon a save that failed for want of a connection is tried again. */
const RETRY_MS = 5000

type Status = 'loading' | 'saved' | 'unsaved' | 'saving' | 'offline' | 'conflict' | 'missing'

/** Unsaved typing, kept in this browser until the server has it: the text and the copy it was edited from. */
interface Draft { body: string; base: number }
const draftKey = (id: string): string => `quire:draft:${id}`
function readDraft(id: string): Draft | null {
  try {
    const v = JSON.parse(localStorage.getItem(draftKey(id)) ?? 'null') as Draft | null
    return v && typeof v.body === 'string' && typeof v.base === 'number' ? v : null
  } catch { return null }
}
function writeDraft(id: string, draft: Draft | null): void {
  try {
    if (draft) localStorage.setItem(draftKey(id), JSON.stringify(draft))
    else localStorage.removeItem(draftKey(id))
  } catch { /* private mode or full: the server copy is all there is */ }
}

interface Props {
  id: string
  onBack: () => void
  /** The note was saved, pinned or restored: the list should show it. */
  onChanged: (note: Note) => void
  /** Moved to the trash; the app offers Undo. */
  onTrashed: (note: Note) => void
  /** Gone for good (from the trash, or a new note left empty). */
  onDestroyed: (id: string) => void
  onTag: (tag: string) => void
}

export default function Editor({ id, onBack, onChanged, onTrashed, onDestroyed, onTag }: Props) {
  const [note, setNote] = useState<Note | null>(null)
  const [body, setBodyState] = useState('')
  const [status, setStatus] = useState<Status>('loading')
  const [theirs, setTheirs] = useState<Note | null>(null)

  // The save loop reads these, not state, so a timer or an unmount sees the latest.
  const bodyRef = useRef('')
  const baseRef = useRef(0)
  const savedRef = useRef('')
  const inFlight = useRef(false)
  const conflictRef = useRef(false)
  /** Opened and live: only such a note, left empty, is thrown away on leaving (never one that failed to load). */
  const loaded = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const editor = useRef<NoteEditorHandle | null>(null)
  const callbacks = useRef({ onChanged, onDestroyed })
  callbacks.current = { onChanged, onDestroyed }

  const clearTimer = (): void => { if (timer.current) { clearTimeout(timer.current); timer.current = null } }

  const save = useCallback(async (keepalive = false): Promise<void> => {
    clearTimer()
    if (inFlight.current || conflictRef.current) return
    const sending = bodyRef.current
    if (sending === savedRef.current) return
    inFlight.current = true
    setStatus('saving')
    try {
      const saved = await api.save(id, sending, baseRef.current, keepalive)
      baseRef.current = saved.updatedAt
      savedRef.current = saved.body
      setNote(saved)
      callbacks.current.onChanged(saved)
      if (bodyRef.current === sending) {
        writeDraft(id, null)
        setStatus('saved')
      } else {
        // More was typed while that one was on its way: send it too.
        writeDraft(id, { body: bodyRef.current, base: saved.updatedAt })
        setStatus('unsaved')
        timer.current = setTimeout(() => { void save() }, SAVE_DELAY_MS)
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && err.body.current) {
        conflictRef.current = true
        setTheirs(err.body.current as Note)
        setStatus('conflict')
      } else if (err instanceof ApiError && err.status === 404) {
        setStatus('missing')
      } else {
        setStatus('offline')
        timer.current = setTimeout(() => { void save() }, RETRY_MS)
      }
    } finally {
      inFlight.current = false
    }
  }, [id])

  // Open the note, picking up any typing this browser hadn't got to the server.
  useEffect(() => {
    let live = true
    conflictRef.current = false
    loaded.current = false
    setTheirs(null)
    setStatus('loading')
    api.get(id).then((n) => {
      if (!live) return
      const draft = readDraft(id)
      setNote(n)
      loaded.current = n.deletedAt === null
      baseRef.current = n.updatedAt
      savedRef.current = n.body
      let text = n.body
      if (draft && draft.body !== n.body && n.deletedAt === null) {
        text = draft.body
        if (draft.base === n.updatedAt) {
          setStatus('unsaved')
          timer.current = setTimeout(() => { void save() }, SAVE_DELAY_MS)
        } else {
          // Typed here offline while it was changed somewhere else.
          conflictRef.current = true
          setTheirs(n)
          setStatus('conflict')
        }
      } else {
        if (draft) writeDraft(id, null)
        setStatus('saved')
      }
      bodyRef.current = text
      setBodyState(text)
    }, (err: unknown) => {
      if (live) setStatus(err instanceof ApiError && err.status === 404 ? 'missing' : 'offline')
    })
    return () => { live = false }
  }, [id, save])

  // Leaving the note: send what's unsaved, and a new note left empty is not kept.
  useEffect(() => () => {
    clearTimer()
    if (conflictRef.current) return
    if (loaded.current && !bodyRef.current.trim() && !savedRef.current.trim()) {
      void api.trash(id).then(() => api.destroy(id)).then(() => callbacks.current.onDestroyed(id), () => {})
      writeDraft(id, null)
      return
    }
    void save(true)
  }, [id, save])

  // Save as soon as the page is hidden or closed: a phone may never come back to finish the timer.
  useEffect(() => {
    const flush = (): void => { if (document.visibilityState === 'hidden') void save(true) }
    const leave = (): void => { void save(true) }
    const online = (): void => { void save() }
    document.addEventListener('visibilitychange', flush)
    window.addEventListener('pagehide', leave)
    window.addEventListener('online', online)
    return () => {
      document.removeEventListener('visibilitychange', flush)
      window.removeEventListener('pagehide', leave)
      window.removeEventListener('online', online)
    }
  }, [save])

  // Back to this note from another app or device: show any change made elsewhere, unless there's typing here to save.
  useEffect(() => {
    const look = (): void => {
      if (document.visibilityState !== 'visible' || bodyRef.current !== savedRef.current || inFlight.current || conflictRef.current) return
      api.get(id).then((n) => {
        if (n.updatedAt === baseRef.current || bodyRef.current !== savedRef.current) return
        baseRef.current = n.updatedAt
        savedRef.current = n.body
        bodyRef.current = n.body
        setNote(n)
        setBodyState(n.body)
      }, () => {})
    }
    document.addEventListener('visibilitychange', look)
    return () => document.removeEventListener('visibilitychange', look)
  }, [id])

  const setBody = (text: string): void => {
    bodyRef.current = text
    setBodyState(text)
    if (conflictRef.current) { writeDraft(id, { body: text, base: baseRef.current }); return }
    writeDraft(id, { body: text, base: baseRef.current })
    setStatus('unsaved')
    clearTimer()
    timer.current = setTimeout(() => { void save() }, SAVE_DELAY_MS)
  }


  const keepMine = (): void => {
    if (!theirs) return
    baseRef.current = theirs.updatedAt
    savedRef.current = theirs.body
    conflictRef.current = false
    setTheirs(null)
    writeDraft(id, { body: bodyRef.current, base: theirs.updatedAt })
    void save()
  }
  const takeTheirs = (): void => {
    if (!theirs) return
    baseRef.current = theirs.updatedAt
    savedRef.current = theirs.body
    bodyRef.current = theirs.body
    conflictRef.current = false
    setBodyState(theirs.body)
    setNote(theirs)
    setTheirs(null)
    writeDraft(id, null)
    setStatus('saved')
  }

  const togglePin = async (): Promise<void> => {
    if (!note) return
    try {
      const n = await api.pin(id, !note.pinned)
      setNote((cur) => (cur ? { ...cur, pinned: n.pinned } : n))
      onChanged(n)
    } catch { setStatus('offline') }
  }

  const trash = async (): Promise<void> => {
    await save()
    try {
      const n = await api.trash(id)
      loaded.current = false
      writeDraft(id, null)
      onTrashed(n)
    } catch { setStatus('offline') }
  }

  const restore = async (): Promise<void> => {
    try {
      const n = await api.restore(id)
      loaded.current = true
      setNote(n)
      onChanged(n)
    } catch { setStatus('offline') }
  }

  const destroy = async (): Promise<void> => {
    if (!window.confirm('Delete this note for good? It can’t be undone.')) return
    try {
      await api.destroy(id)
      onDestroyed(id)
    } catch { setStatus('offline') }
  }

  if (status === 'missing') {
    return (
      <section className="editor">
        <header className="bar"><button type="button" className="icon" onClick={onBack} aria-label="Back to notes"><ArrowLeft size={20} /></button></header>
        <p className="empty">This note isn’t here any more.</p>
      </section>
    )
  }

  const trashed = note?.deletedAt != null
  const statusText: Record<Status, string> = {
    loading: '', saved: 'Saved', unsaved: 'Editing…', saving: 'Saving…',
    offline: 'Offline — kept on this device', conflict: 'Changed elsewhere', missing: '',
  }

  return (
    <section className="editor" aria-busy={status === 'loading'}>
      <header className="bar">
        <button type="button" className="icon back" onClick={onBack} aria-label="Back to notes"><ArrowLeft size={20} /></button>
        <span className={`status ${status}`} role="status">{trashed ? `In the trash since ${when(note.deletedAt!)}` : statusText[status]}</span>
        <div className="bar-actions">
          {trashed ? (
            <>
              <button type="button" className="text-btn" onClick={() => { void restore() }}><RotateCcw size={16} /> Restore</button>
              <button type="button" className="text-btn danger" onClick={() => { void destroy() }}><Trash2 size={16} /> Delete</button>
            </>
          ) : (
            <>
              <button
                type="button" className="icon" aria-label="Checkbox"
                // Keep the editor's focus (and the phone's keyboard) through the tap.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => editor.current?.toggleTask()}
              >
                <SquareCheck size={20} />
              </button>
              <button type="button" className={`icon ${note?.pinned ? 'on' : ''}`} onClick={() => { void togglePin() }} aria-label={note?.pinned ? 'Unpin' : 'Pin'} disabled={!note}>
                {note?.pinned ? <PinOff size={20} /> : <Pin size={20} />}
              </button>
              <button type="button" className="icon" onClick={() => { void trash() }} aria-label="Move to trash" disabled={!note}><Trash2 size={20} /></button>
            </>
          )}
        </div>
      </header>

      {theirs && (
        <div className="conflict" role="alert">
          <p>This note was changed on another device{` (${when(theirs.updatedAt)})`} while you were editing it here.</p>
          <div className="conflict-actions">
            <button type="button" className="text-btn primary" onClick={keepMine}>Keep mine</button>
            <button type="button" className="text-btn" onClick={takeTheirs}>Take theirs</button>
          </div>
        </div>
      )}

      {status !== 'loading' && (
        <NoteEditor
          ref={editor}
          value={body}
          onChange={setBody}
          onBlur={() => { void save() }}
          onTag={onTag}
          readOnly={trashed}
          autoFocus={!trashed && !body.trim()}
        />
      )}
    </section>
  )
}
