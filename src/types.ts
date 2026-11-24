/** A note as the server keeps it. The title and tags are read from the body. */
export interface Note {
  id: string
  body: string
  pinned: boolean
  tags: string[]
  createdAt: number
  updatedAt: number
  /** When it went to the trash; null while it is a live note. */
  deletedAt: number | null
}

/** A row in the list: enough to show and filter it without the whole body. */
export interface NoteSummary {
  id: string
  title: string
  /** The start of the body after the title, or around a search match (matches wrapped in « »). */
  snippet: string
  tags: string[]
  pinned: boolean
  updatedAt: number
  deletedAt: number | null
}

export interface TagCount {
  tag: string
  n: number
}

/** What `PATCH /api/notes/:id` answers when the note changed since the copy being edited. */
export interface Conflict {
  error: string
  current: Note
}

/** How long a note stays in the trash before it is gone for good. */
export const TRASH_DAYS = 30
/** The largest note the server takes, in characters. */
export const MAX_BODY = 500_000
