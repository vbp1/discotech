import { Extension } from '@tiptap/core'
import { DOMParser } from '@tiptap/pm/model'
import { Plugin } from '@tiptap/pm/state'

/**
 * Typing makes ProseMirror re-read the edited text from the page, and that read turns line
 * breaks inside paragraph text into hard breaks (the schema's linebreak replacement). The page
 * holds exactly the document's text, so it is read with whitespace kept as is, which keeps
 * soft breaks soft. Pasted content is parsed through parseSlice and is not affected.
 */
export const SoftBreakInput = Extension.create({
  name: 'softBreakInput',
  addProseMirrorPlugins() {
    const base = DOMParser.fromSchema(this.editor.schema)
    const parser: DOMParser = Object.create(base)
    parser.parse = (dom, options = {}) =>
      base.parse(dom, options.preserveWhitespace === true ? { ...options, preserveWhitespace: 'full' } : options)
    return [new Plugin({ props: { domParser: parser } })]
  }
})
