// Checks that opening and closing markdown previews does not accumulate parser extensions.
// Usage: npx esbuild scripts/md-parser-check.mts --bundle --platform=node --format=esm \
//          --external:jsdom --outfile=out/md-parser-check.mjs && node out/md-parser-check.mjs [FILE.md]
// Optionally pass a real Markdown file to measure its load time.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'getComputedStyle', 'DOMParser', 'Element']) {
  ;(globalThis as any)[key] ??= (dom.window as any)[key]
}
const { Editor } = await import('@tiptap/core')
const { markdownExtensions } = await import('../src/renderer/src/markdown/document')
const source = process.argv[2]
  ? readFileSync(process.argv[2], 'utf8')
  : '# Heading\n\nText with **bold** and [a link](https://example.com).\n\n- [ ] Task\n\n| A | B |\n| --- | --- |\n| x | y |\n'

const first = new Editor({ element: null, extensions: markdownExtensions() })
const parser = first.markdown!.instance
const counts = () => {
  const extensions = parser.defaults.extensions || undefined
  return [extensions?.block?.length ?? 0, extensions?.inline?.length ?? 0]
}
const initialCounts = counts()
const expected = first.markdown!.parse(source)
first.destroy()

const times: number[] = []
for (let i = 0; i < 30; i++) {
  const editor = new Editor({ element: document.createElement('div'), extensions: markdownExtensions() })
  try {
    assert.notEqual(editor.markdown!.instance, parser, 'each editor must own its parser')
    const start = performance.now()
    editor.commands.setContent(source, { contentType: 'markdown', emitUpdate: false })
    times.push(performance.now() - start)
    assert.deepEqual(editor.markdown!.parse(source), expected, 'opening another editor must preserve parsing')
  } finally {
    editor.destroy()
  }
}
assert.deepEqual(counts(), initialCounts, 'closed editors must not accumulate tokenizers in an earlier parser')
console.log(`PASS: 30 editor lifecycles; tokenizer counts ${initialCounts}; load first=${times[0].toFixed(1)}ms last=${times.at(-1)!.toFixed(1)}ms`)
