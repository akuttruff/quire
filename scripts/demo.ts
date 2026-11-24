// Fills .data-demo with a handful of made-up notes, for trying the app (and
// taking the README's screenshots) without touching real ones:
//
//   npm run demo:data && npm run demo
//
// Each run starts the demo over. The times are set back from now, so the
// list reads "12m", "Tue" and so on.
import fs from 'node:fs'
import path from 'node:path'
import { Store } from '../server/store.ts'

const DIR = path.resolve(process.env.QUIRE_DATA ?? '.data-demo')
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

for (const f of ['quire.sqlite', 'quire.sqlite-wal', 'quire.sqlite-shm']) fs.rmSync(path.join(DIR, f), { force: true })
const store = new Store(DIR)
const now = Date.now()

const notes: { body: string; ago: number; pinned?: boolean; trashed?: boolean }[] = [
  {
    ago: 12 * MIN, pinned: true,
    body: `Trip packing #travel

##Clothes
[x] rain jacket
[x] wool socks (3)
[] hiking boots
[] something nice for dinner

## Gear
- [ ] headlamp
- [ ] **charger** and the spare cable
- [x] water bottle

Ferry leaves at 7:40 — check the [timetable](https://example.com/ferry) the night before.`,
  },
  {
    ago: 3 * HOUR,
    body: `Lemon pasta #cooking

## Ingredients
- spaghetti, 200 g
- 1 lemon, zest and juice
- parmesan, butter, black pepper

## Steps
1. Boil the pasta in well-salted water.
2. Melt the butter with the zest, add a ladle of pasta water.
3. Toss everything together, off the heat, with the cheese.

> Save more pasta water than you think you'll need.`,
  },
  {
    ago: 26 * HOUR,
    body: `Garden plan #garden

##Raised beds
[x] order soil
[] build the trellis
[] plant garlic before the frost

Tomatoes did best by the south fence this year. Try *San Marzano* next.`,
  },
  {
    ago: 3 * DAY,
    body: `Reading list #books

1. The Overstory
2. Piranesi
3. A Psalm for the Wild-Built
4. Braiding Sweetgrass`,
  },
  {
    ago: 5 * DAY,
    body: `App ideas #work/ideas

- share a note as a read-only link
- export everything as a zip of \`.md\` files
- a daily note that opens on its own

\`\`\`sh
npm run demo:data && npm run demo
\`\`\``,
  },
  {
    ago: 9 * DAY,
    body: `Book club #books

Next meeting on the 14th at the library. Bring snacks. #home`,
  },
  { ago: 2 * DAY, trashed: true, body: 'Old grocery list\n\n[] milk\n[] bread' },
]

for (const n of notes) {
  const note = store.create(n.body, now - n.ago)
  if (n.pinned) store.setPinned(note.id, true)
  if (n.trashed) store.trash(note.id, now - n.ago + HOUR)
}
store.close()
console.log(`quire: ${notes.length} demo notes in ${path.relative(process.cwd(), DIR) || '.'}`)
