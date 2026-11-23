import type { AnyExtension } from '@tiptap/core'
import { TableKit } from '@tiptap/extension-table'
import { TaskItem, TaskList } from '@tiptap/extension-list'
import { Markdown } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { Marked, type marked } from 'marked'

export function markdownExtensions(): AnyExtension[] {
  // Tiptap types this option as the global callable but uses only Marked instance methods.
  const parser = new Marked() as unknown as typeof marked
  return [
    StarterKit.configure({ link: { openOnClick: false }, trailingNode: false }),
    TableKit,
    TaskList,
    TaskItem.configure({ nested: true }),
    // Tiptap registers tokenizers on creation; a shared parser accumulates them across tabs.
    Markdown.configure({ marked: parser, markedOptions: { gfm: true } })
  ]
}
