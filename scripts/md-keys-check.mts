// Checks that Backspace/Delete joins keep soft line breaks and that the empty paragraph kept
// below a final list is not saved. Bundled first: under tsx the editor core loads twice.
// Usage: npx esbuild scripts/md-keys-check.mts --bundle --platform=node --format=esm \
//          --external:jsdom --outfile=out/md-keys-check.mjs && node out/md-keys-check.mjs
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body></body></html>')
for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'getComputedStyle', 'DOMParser', 'Element']) {
  ;(globalThis as any)[key] ??= (dom.window as any)[key]
}
const { Editor } = await import('@tiptap/core')
const { TextSelection } = await import('@tiptap/pm/state')
const { markdownExtensions, makeBaseline, sourceFromEdits } = await import('../src/renderer/src/markdown/document')
const { markdownOf } = await import('../src/renderer/src/markdown/trailingParagraph')
const { deleteAdjacentEmptyParagraph } = await import('../src/renderer/src/markdown/softBreakJoin')

let failed = 0
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(ok ? 'ok  ' : 'FAIL', name, ok ? '' : `\n   got  ${JSON.stringify(got)}\n   want ${JSON.stringify(want)}`)
}
const open = (source: string) => {
  const editor = new Editor({ element: dom.window.document.createElement('div'), extensions: markdownExtensions() })
  const baseline = makeBaseline(source, (body) => {
    editor.commands.setContent(body, { contentType: 'markdown', emitUpdate: false })
    return markdownOf(editor)
  })
  return { editor, baseline }
}
// Cursor at the start (or end) of the n-th top-level block.
const cursor = (editor: any, index: number, atEnd = false) => {
  let pos = 0
  for (let i = 0; i < index; i++) pos += editor.state.doc.child(i).nodeSize
  pos += 1 + (atEnd ? editor.state.doc.child(index).content.size : 0)
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)))
}

{
  const { editor, baseline } = open('a\nb\n\nc\nd\n')
  cursor(editor, 1)
  editor.view.someProp('handleKeyDown', (handle: any) => handle(editor.view, new dom.window.KeyboardEvent('keydown', { key: 'Backspace' })))
  check('Backspace keys run before the default join', sourceFromEdits(baseline, editor), 'a\nbc\nd\n')
  editor.destroy()
}
{
  const { editor, baseline } = open('a\nb\n\nc\nd\n')
  cursor(editor, 1)
  check('backspace join keeps soft breaks: handled', deleteAdjacentEmptyParagraph(editor, 'backward'), true)
  check('backspace join keeps soft breaks: file', sourceFromEdits(baseline, editor), 'a\nbc\nd\n')
  editor.destroy()
}
{
  const { editor, baseline } = open('a\nb\n\nc\nd\n')
  cursor(editor, 0, true)
  check('delete join keeps soft breaks', deleteAdjacentEmptyParagraph(editor, 'forward') && sourceFromEdits(baseline, editor), 'a\nbc\nd\n')
  editor.destroy()
}
{
  const { editor, baseline } = open('# H\n\nx\ny\n')
  cursor(editor, 1)
  check('backspace into heading takes first line', deleteAdjacentEmptyParagraph(editor, 'backward') && sourceFromEdits(baseline, editor), '# Hx\n\ny\n')
  editor.destroy()
}
{
  const { editor } = open('plain\n\nother\n')
  cursor(editor, 1)
  check('no soft breaks: default handling', deleteAdjacentEmptyParagraph(editor, 'backward'), false)
  editor.destroy()
}
{
  const { editor, baseline } = open('- a\n- b\n')
  check('trailing paragraph present in view', editor.state.doc.lastChild.type.name, 'paragraph')
  check('trailing paragraph not in canonical', baseline.canonical, '- a\n- b')
  editor.chain().insertContentAt(3, 'Z').run()
  check('edit in list: no blank line added', sourceFromEdits(baseline, editor), '- Za\n- b\n')
  const end = editor.state.doc.content.size - 1
  editor.chain().insertContentAt(end, 'tail').run()
  check('typing in trailing paragraph saves it', sourceFromEdits(baseline, editor), '- Za\n- b\n\ntail\n')
  editor.destroy()
}
console.log(failed ? `${failed} failed` : 'all passed')
process.exit(failed ? 1 : 0)
