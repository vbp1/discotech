// Adapted from Orca (https://github.com/stablyai/orca), MIT License, Copyright (c) 2026 Lovecast Inc.
// Source: src/renderer/src/components/editor/rich-markdown-block-source.ts
// Differences: no raw-HTML transport; returns null instead of falling back to a whole-file rewrite.
import type { Editor } from '@tiptap/core'
import { extractAbsorbedBlankLines } from '@tiptap/markdown'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { diffArrays, diffLines } from 'diff'
import { reconcileMarkdown } from './reconcile'

type SourceBlock = { node: ProseMirrorNode; source: string; separator: string }
type SourceDocument = { leading: string; blocks: SourceBlock[] }

const MAX_BLOCK_EDITS = 256

function parse(editor: Editor, source: string): ProseMirrorNode {
  return editor.schema.nodeFromJSON(editor.markdown!.parse(source))
}

/** Splits source into top-level blocks matching the document's children; null when spans are ambiguous. */
function readSourceDocument(editor: Editor, source: string, expected?: ProseMirrorNode): SourceDocument | null {
  const normalized = source.replace(/\r\n/g, '\n')
  const document = expected ?? parse(editor, normalized)
  const tokens = extractAbsorbedBlankLines(editor.markdown!.instance.lexer(normalized))
  // Definitions and custom source owners may cross token boundaries; never guess their spans.
  if (tokens.map((token) => token.raw).join('') !== normalized) return null
  const blocks: SourceBlock[] = []
  let leading = ''
  const lastContentIndex = tokens.findLastIndex((token) => token.type !== 'space')
  for (const [tokenIndex, token] of tokens.entries()) {
    const raw = token.raw
    if (raw === undefined) return null
    if (token.type === 'space') {
      const pieces: string[] = []
      let offset = 0
      for (const match of raw.matchAll(/\n\n/g)) {
        pieces.push(raw.slice(offset, match.index + 2))
        offset = match.index + 2
      }
      const remainder = raw.slice(offset)
      const previous = blocks.at(-1)
      if (pieces.length === 0) {
        if (previous) previous.separator += remainder
        else leading += remainder
        continue
      }
      const atEnd = tokenIndex > lastContentIndex
      if (previous) previous.separator += pieces.shift()!
      // Match the parser's implicit paragraphs, including leading/trailing blank runs.
      for (const separator of pieces) {
        blocks.push({ node: editor.schema.nodes.paragraph.create(), source: '', separator })
      }
      if (previous && atEnd) {
        blocks.push({ node: editor.schema.nodes.paragraph.create(), source: '', separator: remainder })
      } else {
        blocks.at(-1)!.separator += remainder
      }
      continue
    }
    const text = raw.replace(/\n+$/, '')
    if (blocks.length >= document.childCount) return null
    blocks.push({ node: document.child(blocks.length), source: text, separator: raw.slice(text.length) })
  }
  if (document.childCount !== blocks.length || blocks.some((block, index) => !block.node.eq(document.child(index)))) {
    return null
  }
  return { leading, blocks }
}

/**
 * Keeps the exact source of every unchanged top-level block and serializes only changed
 * blocks. Returns null unless the assembled text parses back to the editor's document.
 */
export function reconcileByBlocks(
  editor: Editor,
  originalSource: string,
  edited: string,
  roundTrip: (source: string) => string | null
): string | null {
  try {
    const baseline = readSourceDocument(editor, originalSource)
    if (!baseline) return null
    const document = editor.state.doc
    const current = readSourceDocument(editor, edited, document)
    if (!current) return null
    const changes = diffArrays(baseline.blocks, current.blocks, {
      comparator: (before, after) => before.node.eq(after.node),
      maxEditLength: MAX_BLOCK_EDITS
    })
    if (!changes) return null
    const blocks: SourceBlock[] = []
    let originalIndex = 0
    let removed: SourceBlock[] = []
    // Original line ranges the edit may touch: replaced blocks, or the insertion point of new ones.
    const newlines = (text: string): number => text.split('\n').length - 1
    const blockStartLine: number[] = []
    let line = newlines(baseline.leading)
    for (const block of baseline.blocks) {
      blockStartLine.push(line)
      line += newlines(block.source + block.separator)
    }
    blockStartLine.push(line)
    const allowed: [number, number][] = []
    for (const change of changes) {
      if (change.added) {
        allowed.push([blockStartLine[originalIndex], blockStartLine[originalIndex]])
        for (const [index, block] of change.value.entries()) {
          // A block edited in place keeps its own style where its changes can be placed precisely.
          const previous = removed.length === change.count ? removed[index] : undefined
          const canonical = previous ? roundTrip(previous.source) : null
          const source =
            previous && canonical !== null
              ? (reconcileMarkdown({ originalSource: previous.source, baseCanonical: canonical, edited: block.source, roundTrip }) ??
                block.source)
              : block.source
          const styled = previous && block.node.type.name === 'table' ? matchTableStyle(previous.source, source) : source
          const next = { ...block, source: styled, separator: previous?.separator ?? block.separator }
          blocks.push(next)
        }
        removed = []
      } else if (change.removed) {
        removed = baseline.blocks.slice(originalIndex, originalIndex + change.count)
        allowed.push([blockStartLine[originalIndex], blockStartLine[originalIndex + change.count]])
        originalIndex += change.count
      } else {
        removed = []
        blocks.push(...baseline.blocks.slice(originalIndex, originalIndex + change.count))
        originalIndex += change.count
      }
    }
    // A moved EOF block needs a separator before the next block.
    for (let index = 0; index < blocks.length - 1; index++) {
      if (!blocks[index].separator) blocks[index] = { ...blocks[index], separator: '\n\n' }
    }
    const assemble = (): string => baseline.leading + blocks.map((block) => block.source + block.separator).join('')
    let candidate = assemble()
    // Validate the assembled document, including cross-block reference and delimiter interactions.
    if (!parse(editor, candidate).eq(document)) {
      const originalIndices = new Map(baseline.blocks.map((block, index) => [block, index]))
      for (let index = 0; index < blocks.length - 1; index++) {
        const at = originalIndices.get(blocks[index])
        const unchangedBoundary = at !== undefined && originalIndices.get(blocks[index + 1]) === at + 1
        if (!unchangedBoundary && !blocks[index].separator.includes('\n\n')) {
          blocks[index] = { ...blocks[index], separator: '\n\n' }
        }
      }
      candidate = assemble()
      if (!parse(editor, candidate).eq(document)) return null
    }
    // The parse proof shows the document is right; this shows untouched text stayed untouched.
    if (!changesStayInside(originalSource.replace(/\r\n/g, '\n'), candidate, allowed)) return null
    return originalSource.includes('\r\n') ? candidate.replace(/\n/g, '\r\n') : candidate
  } catch {
    // Any failure means the proof did not hold; the caller refuses to save.
    return null
  }
}

// Cells split on pipes that are not escaped; the serializer escapes pipes inside cell text.
const CELL_SPLIT = /(?<!\\)\|/

function splitRow(line: string): string[] | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null
  return trimmed.slice(1, -1).split(CELL_SPLIT).map((cell) => cell.trim())
}

function isCompactTable(source: string): boolean {
  const lines = source.split('\n')
  const separator = lines.length > 1 ? splitRow(lines[1]) : null
  return separator !== null && separator.every((cell) => /^:?-{1,3}:?$/.test(cell))
}

/**
 * The editor pads table cells into aligned columns. A table written without alignment in
 * the source is written back the same way, so one edited cell does not re-pad every row.
 */
function matchTableStyle(originalSource: string, serialized: string): string {
  if (!isCompactTable(originalSource) || isCompactTable(serialized)) return serialized
  const lines = serialized.split('\n')
  const rows = lines.map(splitRow)
  if (rows.some((row) => row === null)) return serialized
  return rows
    .map((row, index) => {
      const cells =
        index === 1
          ? row!.map((cell) => `${cell.startsWith(':') ? ':' : ''}---${cell.length > 1 && cell.endsWith(':') ? ':' : ''}`)
          : row!
      return `| ${cells.join(' | ')} |`
    })
    .join('\n')
}

/** True when every line-level change between the two texts lies within an allowed line range. */
function changesStayInside(original: string, candidate: string, allowed: [number, number][]): boolean {
  const inside = (from: number, to: number): boolean => allowed.some(([start, end]) => from >= start && to <= end)
  let line = 0
  for (const part of diffLines(original, candidate)) {
    if (part.removed) {
      if (!inside(line, line + part.count)) return false
      line += part.count
    } else if (part.added) {
      if (!inside(line, line)) return false
    } else {
      line += part.count
    }
  }
  return true
}
