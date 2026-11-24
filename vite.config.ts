import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import api from './server/api.ts'

// Any name on the tailnet, not one machine's: `tailscale serve` is what
// actually limits who can reach this, so a rename shouldn't break it.
const TAILNET = '.ts.net'

export default defineConfig(({ command, isPreview }) => {
  // `vite preview` is the one real instance, with the notes in .data.
  // `vite dev` keeps its own scratch database in .data-dev (or QUIRE_DATA:
  // `npm run demo` uses .data-demo), so trying something out never touches
  // a real note.
  const real = command === 'build' || isPreview
  const dir = real ? undefined : path.resolve(process.cwd(), process.env.QUIRE_DATA ?? '.data-dev')

  return {
    // A build only bundles the page; the API starts with the server that serves it.
    plugins: [react(), ...(command === 'build' && !isPreview ? [] : [api({ dir })])],
    server: {
      // Loopback only: `tailscale serve` proxies to 127.0.0.1, and the API has no login.
      host: '127.0.0.1',
      port: 8700,
      strictPort: true,
      allowedHosts: [TAILNET],
      watch: { ignored: ['**/coverage/**', '**/.data/**', '**/.data-dev/**'] },
    },
    // The persistent, built instance Tailscale points at, beside `npm run dev`.
    preview: { host: '127.0.0.1', port: 8710, strictPort: true, allowedHosts: [TAILNET] },
  }
})
