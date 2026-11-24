import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach, vi } from 'vitest'

// Server tests run in node (`@vitest-environment node`), where there is no window to patch.
if (typeof window !== 'undefined') {
  // jsdom does no layout: no ResizeObserver, and every width is 0 (the chart falls back to its default).
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver
  }
  beforeEach(() => {
    localStorage.clear()
    // Every suite opts in to the fetch it wants; an un-stubbed call should fail loudly.
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('unstubbed fetch'))))
  })
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })
}

// CodeMirror measures text; jsdom does no layout, so give it empty rectangles to measure.
if (typeof window !== 'undefined') {
  const rect = (): DOMRect => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) }) as DOMRect
  const rects = (): DOMRectList => Object.assign([], { item: () => null }) as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = rect
  Range.prototype.getClientRects = rects
  if (!document.elementFromPoint) document.elementFromPoint = () => null
}
