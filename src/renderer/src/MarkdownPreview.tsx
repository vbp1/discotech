import { EditorContent, useEditor } from '@tiptap/react'
import { useEffect, useRef, useState } from 'react'
import { markdownExtensions } from './markdown/document'
import { splitFrontMatter } from './markdown/frontMatter'

type Props = {
  source: string
  /** The text is rendered only while the preview is shown. */
  visible: boolean
  fontSize: number
}

/** Read-only rendering of markdown text; the text is edited in the source view. */
export function MarkdownPreview({ source, visible, fontSize }: Props): React.JSX.Element {
  const [frontMatter, setFrontMatter] = useState('')
  const rendered = useRef<string | null>(null)

  const editor = useEditor({
    extensions: markdownExtensions(),
    editable: false,
    immediatelyRender: true,
    shouldRerenderOnTransaction: false
  })

  useEffect(() => {
    if (!visible || rendered.current === source) return
    rendered.current = source
    const parts = splitFrontMatter(source)
    editor.commands.setContent(parts.body, { contentType: 'markdown', emitUpdate: false })
    setFrontMatter(parts.frontMatter)
  }, [editor, source, visible])

  return (
    <div className="md-editor">
      <div className="md-scroll" style={{ fontSize }}>
        {frontMatter && (
          <pre className="md-frontmatter" title="Служебный блок в начале файла.">
            {frontMatter.trimEnd()}
          </pre>
        )}
        <EditorContent editor={editor} className="md-content" />
      </div>
    </div>
  )
}
