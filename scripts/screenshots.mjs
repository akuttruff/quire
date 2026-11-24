// The README's screenshots, taken with headless Chrome over its DevTools
// protocol (a raw WebSocket; no npm dependency). Run the demo first:
//
//   npm run demo:data && npm run demo      (in one terminal)
//   npm run screenshots                    (in another; writes docs/screenshots/*.png)
//
// Needs Google Chrome at the usual macOS path, or CHROME=/path/to/chrome.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const URL = process.env.QUIRE_URL ?? 'http://127.0.0.1:8700'
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const OUT = 'docs/screenshots'
const PORT = Number(process.env.CHROME_PORT ?? 9341)

const PHONE = { width: 375, height: 812, deviceScaleFactor: 3, mobile: true }
const DESKTOP = { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false }

/** Each shot: a screen size, and the note to open (by title), if any. The app is always dark. */
const SHOTS = [
  { name: 'desktop-notes', screen: DESKTOP, note: 'Trip packing' },
  { name: 'phone-notes', screen: PHONE },
  { name: 'phone-packing', screen: PHONE, note: 'Trip packing' },
  { name: 'phone-recipe', screen: PHONE, note: 'Lemon pasta' },
]

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const notes = await (await fetch(`${URL}/api/notes`).catch(() => {
  console.error(`quire: nothing answering at ${URL}; start it with: npm run demo:data && npm run demo`)
  process.exit(1)
})).json()
const idOf = (title) => notes.find((n) => n.title.startsWith(title))?.id

const profile = mkdtempSync(join(tmpdir(), 'quire-shots-'))
const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' })
let target
for (let i = 0; i < 50 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page') } catch { /* not up yet */ }
  if (!target) await sleep(200)
}
if (!target) { console.error('quire: Chrome did not start'); process.exit(1) }

const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => ws.addEventListener('open', r))
let seq = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.result?.value

await send('Page.enable')
mkdirSync(OUT, { recursive: true })
for (const shot of SHOTS) {
  await send('Emulation.setDeviceMetricsOverride', shot.screen)
  const id = shot.note ? idOf(shot.note) : null
  if (shot.note && !id) { console.error(`quire: no demo note "${shot.note}"; run npm run demo:data`); process.exit(1) }
  await send('Page.navigate', { url: 'about:blank' })
  await send('Page.navigate', { url: `${URL}/${id ? `#/n/${id}` : ''}` })
  // Wait for the list (and the note, when one is open) to be drawn.
  for (let i = 0; i < 50; i++) {
    if (await evaluate(`!!document.querySelector('.row') && (${!id} || !!document.querySelector('.cm-line'))`)) break
    await sleep(100)
  }
  await sleep(400)
  const { result } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(OUT, `${shot.name}.png`), Buffer.from(result.data, 'base64'))
  console.log(`quire: ${OUT}/${shot.name}.png`)
}
ws.close()
// Chrome writes to its profile until it has gone, so wait for that before clearing it.
await new Promise((r) => { chrome.once('exit', r); chrome.kill() })
try { rmSync(profile, { recursive: true, force: true }) } catch { /* the OS clears its temp folder anyway */ }
