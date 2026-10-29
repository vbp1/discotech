import { Editor, type AnyExtension } from '@tiptap/core'
import { TableKit } from '@tiptap/extension-table'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Markdown } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { splitFrontMatter } from './frontMatter'
import { reconcileByBlocks } from './blockSource'
import { reconcileMarkdown } from './reconcile'
import { SoftBreakJoin } from './softBreakJoin'
import { markdownOf, TrailingParagraph } from './trailingParagraph'

export function markdownExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({ link: { openOnClick: false }, trailingNode: false }),
    TrailingParagraph,
    SoftBreakJoin,
    TableKit,
    TaskList,
    TaskItem.configure({ nested: true }),
    Markdown.configure({ markedOptions: { gfm: true } })
  ]
}

let roundTripEditor: Editor | null = null

/** Parses markdown and serializes it back through the same pipeline as the visual editor. */
export function roundTrip(markdown: string): string | null {
  roundTripEditor ??= new Editor({ element: null, extensions: markdownExtensions() })
  try {
    roundTripEditor.commands.setContent(markdown, { contentType: 'markdown', emitUpdate: false })
    return markdownOf(roundTripEditor)
  } catch {
    // A parse failure means the proof failed; the caller refuses to save.
    return null
  }
}

/** The source-side baseline of a markdown file opened in the visual editor. */
export type MarkdownBaseline = {
  frontMatter: string
  body: string
  /** Canonical serialization of body before any edit. */
  canonical: string
}

export function makeBaseline(source: string, canonicalOf: (body: string) => string): MarkdownBaseline {
  const { frontMatter, body } = splitFrontMatter(source)
  return { frontMatter, body, canonical: canonicalOf(body) }
}

/** The baseline after saving `source`, which parses to the editor's current document. */
export function rebaseline(source: string, editor: Editor): MarkdownBaseline {
  const { frontMatter, body } = splitFrontMatter(source)
  return { frontMatter, body, canonical: markdownOf(editor) }
}

/**
 * The file text for the editor's current content, or null when the edits cannot be placed
 * without touching unchanged text. Character-level placement is tried first; when it fails,
 * only the changed top-level blocks (a paragraph, a list, a table) are written anew.
 */
export function sourceFromEdits(baseline: MarkdownBaseline, editor: Editor): string | null {
  const edited = markdownOf(editor)
  const body =
    reconcileMarkdown({ originalSource: baseline.body, baseCanonical: baseline.canonical, edited, roundTrip }) ??
    reconcileByBlocks(editor, baseline.body, edited, roundTrip)
  return body === null ? null : baseline.frontMatter + body
}
