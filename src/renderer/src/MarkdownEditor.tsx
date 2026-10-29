import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import {
  Bold,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link,
  List,
  ListOrdered,
  ListTodo,
  Minus,
  Pilcrow,
  Quote,
  Redo2,
  SquareCode,
  Strikethrough,
  Undo2
} from 'lucide-react'
import { useEffect, useImperativeHandle, useRef, useState } from 'react'
import { makeBaseline, markdownExtensions, rebaseline, sourceFromEdits, type MarkdownBaseline } from './markdown/document'

export type MarkdownEditorHandle = {
  /** Loads file text; the editor shows its body and remembers it as the baseline. */
  load(source: string): void
  /** Records `source` as saved without touching the document, its cursor or undo history. */
  markSaved(source: string): void
  /** The file text with the user's edits, or null when they cannot be placed without touching other text. */
  source(): string | null
  /** The whole document as the editor serializes it, front matter kept. */
  canonicalSource(): string
  changed(): boolean
}

type Props = {
  ref: React.Ref<MarkdownEditorHandle>
  /** Loaded when the editor mounts; later loads go through the handle. */
  initialSource: string
  fontSize: number
  onChange(): void
}

export function MarkdownEditor({ ref, initialSource, fontSize, onChange }: Props): React.JSX.Element {
  const baseline = useRef<MarkdownBaseline | null>(null)
  const [frontMatter, setFrontMatter] = useState('')
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const editor = useEditor({
    extensions: markdownExtensions(),
    immediatelyRender: true,
    shouldRerenderOnTransaction: false,
    onUpdate: () => onChangeRef.current()
  })

  const load = (source: string): void => {
    baseline.current = makeBaseline(source, (body) => {
      editor.commands.setContent(body, { contentType: 'markdown', emitUpdate: false })
      return editor.getMarkdown()
    })
    setFrontMatter(baseline.current.frontMatter)
  }

  const initialSourceRef = useRef(initialSource)
  useEffect(() => {
    load(initialSourceRef.current)
    // Mount-time load only.
  }, [editor])

  useImperativeHandle(
    ref,
    () => ({
      load,
      markSaved(source) {
        baseline.current = rebaseline(source, editor)
        setFrontMatter(baseline.current.frontMatter)
      },
      source() {
        if (!baseline.current) throw new Error('Markdown editor has no loaded file')
        return sourceFromEdits(baseline.current, editor)
      },
      canonicalSource() {
        return (baseline.current?.frontMatter ?? '') + editor.getMarkdown()
      },
      changed() {
        return baseline.current !== null && editor.getMarkdown() !== baseline.current.canonical
      }
    }),
    [editor]
  )

  return (
    <div className="md-editor">
      <MarkdownToolbar editor={editor} />
      <div className="md-scroll" style={{ fontSize }}>
        {frontMatter && (
          <pre className="md-frontmatter" title="Служебный блок в начале файла. Править — в режиме исходного текста.">
            {frontMatter.trimEnd()}
          </pre>
        )}
        <EditorContent editor={editor} className="md-content" />
      </div>
    </div>
  )
}

const I = 15

function MarkdownToolbar({ editor }: { editor: Editor }): React.JSX.Element {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      paragraph: e.isActive('paragraph'),
      h1: e.isActive('heading', { level: 1 }),
      h2: e.isActive('heading', { level: 2 }),
      h3: e.isActive('heading', { level: 3 }),
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      strike: e.isActive('strike'),
      code: e.isActive('code'),
      bullet: e.isActive('bulletList'),
      ordered: e.isActive('orderedList'),
      task: e.isActive('taskList'),
      quote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
      link: e.isActive('link'),
      canUndo: e.can().undo(),
      canRedo: e.can().redo()
    })
  })
  const [linkDraft, setLinkDraft] = useState<string | null>(null)
  const chain = () => editor.chain().focus()

  const button = (label: React.ReactNode, title: string, active: boolean, run: () => void, disabled = false) => (
    <button className={`md-tool${active ? ' active' : ''}`} title={title} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={run}>
      {label}
    </button>
  )

  const applyLink = (): void => {
    const href = linkDraft?.trim() ?? ''
    if (href) chain().extendMarkRange('link').setLink({ href }).run()
    else chain().extendMarkRange('link').unsetLink().run()
    setLinkDraft(null)
  }

  return (
    <div className="md-toolbar">
      {button(<Pilcrow size={I} />, 'Обычный текст', state.paragraph, () => chain().setParagraph().run())}
      {button(<Heading1 size={I} />, 'Заголовок 1', state.h1, () => chain().toggleHeading({ level: 1 }).run())}
      {button(<Heading2 size={I} />, 'Заголовок 2', state.h2, () => chain().toggleHeading({ level: 2 }).run())}
      {button(<Heading3 size={I} />, 'Заголовок 3', state.h3, () => chain().toggleHeading({ level: 3 }).run())}
      <span className="md-sep" />
      {button(<Bold size={I} />, 'Жирный (Ctrl+B)', state.bold, () => chain().toggleBold().run())}
      {button(<Italic size={I} />, 'Курсив (Ctrl+I)', state.italic, () => chain().toggleItalic().run())}
      {button(<Strikethrough size={I} />, 'Зачёркнутый', state.strike, () => chain().toggleStrike().run())}
      {button(<Code size={I} />, 'Код в строке', state.code, () => chain().toggleCode().run())}
      <span className="md-sep" />
      {button(<List size={I} />, 'Маркированный список', state.bullet, () => chain().toggleBulletList().run())}
      {button(<ListOrdered size={I} />, 'Нумерованный список', state.ordered, () => chain().toggleOrderedList().run())}
      {button(<ListTodo size={I} />, 'Список с галочками', state.task, () => chain().toggleTaskList().run())}
      {button(<Quote size={I} />, 'Цитата', state.quote, () => chain().toggleBlockquote().run())}
      {button(<SquareCode size={I} />, 'Блок кода', state.codeBlock, () => chain().toggleCodeBlock().run())}
      {button(<Minus size={I} />, 'Горизонтальная линия', false, () => chain().setHorizontalRule().run())}
      {button(<Link size={I} />, 'Ссылка', state.link, () => setLinkDraft(editor.getAttributes('link').href ?? ''))}
      {linkDraft !== null && (
        <input
          className="md-link-input"
          autoFocus
          placeholder="Адрес ссылки; пусто — убрать ссылку"
          value={linkDraft}
          onChange={(e) => setLinkDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') applyLink()
            if (e.key === 'Escape') setLinkDraft(null)
          }}
          onBlur={() => setLinkDraft(null)}
        />
      )}
      <span className="md-sep" />
      {button(<Undo2 size={I} />, 'Отменить (Ctrl+Z)', false, () => chain().undo().run(), !state.canUndo)}
      {button(<Redo2 size={I} />, 'Повторить (Ctrl+Y)', false, () => chain().redo().run(), !state.canRedo)}
    </div>
  )
}
