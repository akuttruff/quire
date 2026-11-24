import { describe, expect, it } from 'vitest'
import { lineKind, lineKinds, plainLine, previewOf, tagsOf, titleOf, toggleTask } from './note.ts'

describe('tagsOf', () => {
  it('finds #tags, lowercased and once each, with nested ones', () => {
    expect(tagsOf('Groceries #Home\nmore #home and #work/plans-2026, (#idea)')).toEqual(['home', 'work/plans-2026', 'idea'])
  })
  it('leaves out headings, URL fragments, numbers and code', () => {
    const body = [
      '# Heading', '## Also a heading', 'see https://example.com/page#section and issue #42',
      '`#inline` code', '```', '#fenced', '```', 'a#b is not one', 'trailing #tag-/ dash',
    ].join('\n')
    expect(tagsOf(body)).toEqual(['tag'])
    expect(tagsOf('##Pets #dog\n[] food #treats')).toEqual(['dog', 'treats'])
  })
  it('reads tags in other scripts', () => {
    expect(tagsOf('#café #日記')).toEqual(['café', '日記'])
  })
})

describe('lineKind', () => {
  it('reads tasks with or without a bullet, and with [] typed bare', () => {
    expect(lineKind('[] food')).toMatchObject({ kind: 'list', bullet: null, box: { checked: false, bare: true, start: 0, end: 2 }, textStart: 3 })
    expect(lineKind('- [x] done')).toMatchObject({ kind: 'list', bullet: '-', box: { checked: true, bare: false }, textStart: 6 })
    expect(lineKind('  2) [ ] step')).toMatchObject({ kind: 'list', number: 2, delim: ')', markStart: 2, textStart: 9 })
    expect(lineKind('> [] quoted')).toMatchObject({ kind: 'list', quoteEnd: 2, textStart: 5 })
    expect(lineKind('[]')).toMatchObject({ kind: 'list', textStart: 2 })
  })
  it('reads headings with or without the space, but one # and a word is a tag', () => {
    expect(lineKind('##Pets')).toEqual({ kind: 'heading', level: 2, markEnd: 2 })
    expect(lineKind('# Title')).toEqual({ kind: 'heading', level: 1, markEnd: 2 })
    expect(lineKind('#home stuff')).toEqual({ kind: 'text' })
    expect(lineKind('#')).toEqual({ kind: 'text' })
  })
  it('leaves ordinary text, links and emphasis alone', () => {
    expect(lineKind('[link](https://x.y) here')).toEqual({ kind: 'text' })
    expect(lineKind('[]food')).toEqual({ kind: 'text' })
    expect(lineKind('*emphasis*')).toEqual({ kind: 'text' })
    expect(lineKind('-1 degrees')).toEqual({ kind: 'text' })
    expect(lineKind('- bullet')).toMatchObject({ kind: 'list', bullet: '-', box: null, textStart: 2 })
  })
  it('knows code blocks', () => {
    expect(lineKinds(['```', '[] not a task', '```', '[] a task']).map((k) => k.kind)).toEqual(['fence', 'code', 'fence', 'list'])
  })
})

describe('titleOf', () => {
  it('is the first line with words, without its Markdown', () => {
    expect(titleOf('\n\n## **Plans** for [the week](https://x.y)\nbody')).toBe('Plans for the week')
    expect(titleOf('- [ ] buy milk')).toBe('buy milk')
    expect(titleOf('```\ncode first\n```')).toBe('code first')
    expect(titleOf('   ')).toBe('')
    expect(titleOf('##Pets\n[] food')).toBe('Pets')
  })
  it('is cut short when long', () => {
    expect(titleOf('x'.repeat(300))).toHaveLength(120)
  })
})

describe('previewOf', () => {
  it('is the text after the title, on one line', () => {
    expect(previewOf('Title\n\nFirst *line*\n- second')).toBe('First line second')
    expect(previewOf('Only a title')).toBe('')
    expect(previewOf('Packing\n\n##Pets\n[] food\n[x] bed')).toBe('Pets food bed')
  })
})

describe('plainLine', () => {
  it('drops quote, list and emphasis markers', () => {
    expect(plainLine('> 1. ~~old~~ `new`')).toBe('old new')
  })
})

describe('toggleTask', () => {
  const body = '- [ ] one\n```\n- [ ] in code\n```\n> - [x] quoted\n  1. [ ] nested'
  it('ticks and clears the box on a line', () => {
    expect(toggleTask(body, 1, true)).toBe(body.replace('- [ ] one', '- [x] one'))
    expect(toggleTask(body, 5, false)).toBe(body.replace('> - [x] quoted', '> - [ ] quoted'))
    expect(toggleTask(body, 6, true)).toBe(body.replace('1. [ ] nested', '1. [x] nested'))
  })
  it('ticks a box typed bare', () => {
    expect(toggleTask('[] food', 1, true)).toBe('[x] food')
    expect(toggleTask('[x] food', 1, false)).toBe('[ ] food')
  })
  it('leaves the body alone on a line with no box, or in code', () => {
    expect(toggleTask(body, 3, true)).toBe(body)
    expect(toggleTask(body, 2, true)).toBe(body)
    expect(toggleTask(body, 99, true)).toBe(body)
  })
})
