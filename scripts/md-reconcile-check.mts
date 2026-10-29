// Simulates a one-word edit in the visual editor for each file and checks that saving
// changes only that word. Usage: npx tsx scripts/md-reconcile-check.mts FILE.md [...]
import { JSDOM } from 'jsdom'
import { readFileSync } from 'node:fs'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'getComputedStyle', 'DOMParser', 'Element']) {
  ;(globalThis as Record<string, unknown>)[key] ??= (dom.window as unknown as Record<string, unknown>)[key]
}
const { Editor } = await import('@tiptap/core')
const { markdownExtensions, makeBaseline, sourceFromEdits, rebaseline, roundTrip } = await import('../src/renderer/src/markdown/document')
const { markdownOf } = await import('../src/renderer/src/markdown/trailingParagraph')

const MARK = 'ПРАВКА'
let ok = 0
for (const file of process.argv.slice(2)) {
  const source = readFileSync(file, 'utf8')
  const editor = new Editor({ element: null, extensions: markdownExtensions() })
  const baseline = makeBaseline(source, (body) => {
    editor.commands.setContent(body, { contentType: 'markdown', emitUpdate: false })
    return markdownOf(editor)
  })
  const unchanged = sourceFromEdits(baseline, editor)
  // Insert a word at the end of the paragraph closest to the middle of the document.
  let target = -1
  const middle = editor.state.doc.content.size / 2
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph' && node.textContent.length > 0 && (target < 0 || Math.abs(pos - middle) < Math.abs(target - middle))) {
      target = pos + node.nodeSize - 1
    }
  })
  editor.chain().insertContentAt(target, ' ' + MARK).run()
  const t = Date.now()
  const saved = sourceFromEdits(baseline, editor)
  const ms = Date.now() - t
  // A second edit after saving must again touch only itself.
  let second = 'SKIP'
  if (saved !== null) {
    const rebased = rebaseline(saved, editor)
    editor.chain().insertContentAt(1, 'ВТОРАЯ ').run()
    const again = sourceFromEdits(rebased, editor)
    second = again === null ? 'REFUSED' : again.replace('ВТОРАЯ ', '') === saved ? 'ONLY-EDIT' : 'OTHER-CHANGES'
  }
  editor.destroy()
  const expectedLen = source.length + MARK.length + 1
  const preserved = saved !== null && saved.replace(' ' + MARK, '') === source
  if (unchanged === source && preserved) ok++
  const changedLines = saved === null ? 0 : (() => { const a = source.split('\n'), b = saved.replace(' ' + MARK, '').split('\n'); let n = 0; for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) n++; return n })()
  console.log(
    `${unchanged === source ? 'unchanged:SAME' : 'unchanged:DIFF'} edit:${saved === null ? 'REFUSED' : preserved ? 'ONLY-EDIT' : `OTHER-CHANGES(${changedLines} lines differ besides the edit)`} second:${second} ${ms}ms ${file}`
  )
}
console.log(`ok: ${ok}/${process.argv.length - 2}`)
void roundTrip
