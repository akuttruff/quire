const pad = (n: number): string => String(n).padStart(2, '0')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** When, as short as the list has room for: "now", "5m", "14:20", "Tue", "Nov 3", "Nov 3, 2025". */
export function when(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const n = new Date(now)
  const ago = now - ms
  if (ago < 60_000) return 'now'
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m`
  if (d.toDateString() === n.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  if (ago < 6 * 86_400_000) return DAYS[d.getDay()]!
  const md = `${MONTHS[d.getMonth()]} ${d.getDate()}`
  return d.getFullYear() === n.getFullYear() ? md : `${md}, ${d.getFullYear()}`
}

/** A search snippet split into plain and matched parts (the server marks matches with « »). */
export function highlights(snippet: string): { text: string; hit: boolean }[] {
  return snippet.split(/«|»/).map((text, i) => ({ text, hit: i % 2 === 1 })).filter((p) => p.text)
}
