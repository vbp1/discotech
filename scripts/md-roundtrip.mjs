// Checks how faithfully the Tiptap markdown pipeline round-trips real files.
// Usage: node scripts/md-roundtrip.mjs FILE.md [...]
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'getComputedStyle', 'DOMParser', 'Element']) {
  globalThis[key] ??= dom.window[key]
}
const { Editor } = await import('@tiptap/core')
const { default: StarterKit } = await import('@tiptap/starter-kit')
const { Markdown } = await import('@tiptap/markdown')
const { TableKit } = await import('@tiptap/extension-table')
const { TaskList, TaskItem } = await import('@tiptap/extension-list')

let same = 0
for (const file of process.argv.slice(2)) {
  const source = readFileSync(file, 'utf8')
  const editor = new Editor({
    extensions: [StarterKit, TableKit, TaskList, TaskItem.configure({ nested: true }), Markdown.configure({ markedOptions: { gfm: true } })],
    content: source,
    contentType: 'markdown'
  })
  const out = editor.getMarkdown()
  editor.destroy()
  const a = source.trimEnd().split('\n')
  const b = out.trimEnd().split('\n')
  const diffs = []
  for (let i = 0; i < Math.max(a.length, b.length) && diffs.length < 3; i++) {
    if (a[i] !== b[i]) diffs.push(`  L${i + 1}\n    -${JSON.stringify(a[i])}\n    +${JSON.stringify(b[i])}`)
  }
  if (diffs.length === 0) same++
  console.log(`${diffs.length ? 'DIFF' : 'SAME'} ${file} (${a.length} -> ${b.length} lines)`)
  diffs.forEach((d) => console.log(d))
}
console.log(`identical: ${same}/${process.argv.length - 2}`)
