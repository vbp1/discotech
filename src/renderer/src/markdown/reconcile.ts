// Adapted from Orca (https://github.com/stablyai/orca), MIT License, Copyright (c) 2026 Lovecast Inc.
// Source: src/renderer/src/components/editor/rich-markdown-source-reconcile.ts
// Difference: where Orca falls back to the editor's canonical serialization (rewriting the
// whole file), this module returns null and the caller refuses to save.
import { applyPatches, cleanupEfficiency, cleanupSemantic, makeDiff, makePatches } from '@sanity/diff-match-patch'
import { diffLines } from 'diff'

// Reconciliation runs only on save, so the diff may take longer than Orca's per-keystroke budget.
const DIFF_TIMEOUT_SECONDS = 3

export type ReconcileParams = {
  /** The file body as it is on disk (possibly noncanonical or CRLF). */
  originalSource: string
  /** Canonical serialization of originalSource (what getMarkdown returns before any edit). */
  baseCanonical: string
  /** Canonical serialization after the user's edits (getMarkdown, always LF). */
  edited: string
  /** Re-parses markdown through the editor pipeline and serializes it back; null on failure. */
  roundTrip: (markdown: string) => string | null
}

/**
 * Applies the user's edits to the original source, keeping untouched text byte-for-byte.
 * Returns null when the edits cannot be placed precisely.
 */
export function reconcileMarkdown({ originalSource, baseCanonical, edited, roundTrip }: ReconcileParams): string | null {
  if (edited === baseCanonical) return originalSource

  const eol = detectDominantEol(originalSource)
  const originalLf = toLf(originalSource)
  const baseLf = toLf(baseCanonical)
  const editedLf = toLf(edited)

  // The source already is canonical: the edited serialization is the new source.
  const originalTrailingNewlines = originalLf.match(/\n+$/)?.[0] ?? ''
  if (
    originalTrailingNewlines.length <= 1 &&
    !editedLf.endsWith('\n') &&
    stripTrailingNewlines(originalLf) === stripTrailingNewlines(baseLf)
  ) {
    return restoreEol(editedLf + originalTrailingNewlines, eol)
  }

  // Repeated-seed half-match scans ignore the diff deadline.
  if (hasRepeatedHalfMatchSeed(baseLf, editedLf)) return null

  let diffs = makeDiff(baseLf, editedLf, { checkLines: true, timeout: DIFF_TIMEOUT_SECONDS })
  if (diffs.length > 2) {
    diffs = cleanupSemantic(diffs)
    diffs = cleanupEfficiency(diffs)
  }
  const patches = makePatches(baseLf, diffs)
  // Patch positions point into the canonical text; the patches apply to the original source,
  // which differs in whitespace and markup style. Map each position into the original first;
  // a line-level mapping is enough because patch placement searches near the hint.
  const toOriginal = lineMapper(baseLf, originalLf)
  const originalIndices = new Map<number, number>()
  for (const patch of patches) {
    for (const index of [patch.start1, patch.start2]) {
      if (!originalIndices.has(index)) originalIndices.set(index, toOriginal(index))
    }
  }
  // applyPatches reads UTF-8 offsets but makePatches emits UTF-16 indices.
  const utf8Offsets = getUtf8OffsetsAtCodeUnitIndices(originalLf, [...originalIndices.values()])
  for (const patch of patches) {
    patch.start1 = utf8Offsets.get(originalIndices.get(patch.start1)!) ?? 0
    patch.start2 = utf8Offsets.get(originalIndices.get(patch.start2)!) ?? 0
  }
  const [reconciledLf, results] = applyPatches(patches, originalLf)
  if (results.some((applied) => !applied)) return null

  // Reject fuzzy placements whose re-parsed document differs from what the user sees.
  const reparsed = roundTrip(reconciledLf)
  if (reparsed === null || toLf(reparsed) !== editedLf) return null

  return restoreEol(reconciledLf, eol)
}

/** Maps a UTF-16 index in `from` to the matching index in `to` using a line diff. */
function lineMapper(from: string, to: string): (index: number) => number {
  // Each segment: where it starts in both texts and its length in each.
  const segments: { from: number; to: number; fromLength: number; toLength: number; equal: boolean }[] = []
  let fromOffset = 0
  let toOffset = 0
  for (const part of diffLines(from, to)) {
    const length = part.value.length
    const last = segments.at(-1)
    if (part.added) {
      if (last && !last.equal && last.toLength === 0) last.toLength = length
      else segments.push({ from: fromOffset, to: toOffset, fromLength: 0, toLength: length, equal: false })
      toOffset += length
    } else if (part.removed) {
      segments.push({ from: fromOffset, to: toOffset, fromLength: length, toLength: 0, equal: false })
      fromOffset += length
    } else {
      segments.push({ from: fromOffset, to: toOffset, fromLength: length, toLength: length, equal: true })
      fromOffset += length
      toOffset += length
    }
  }
  return (index) => {
    const segment = segments.find((s) => index < s.from + s.fromLength) ?? segments.at(-1)
    if (!segment) return index
    const within = index - segment.from
    return segment.to + (segment.equal ? within : Math.min(within, segment.toLength))
  }
}

function stripTrailingNewlines(lfText: string): string {
  return lfText.replace(/\n+$/, '')
}

function detectDominantEol(text: string): '\n' | '\r\n' {
  if (!text.includes('\r')) return '\n'
  const totalLf = (text.match(/\n/g) ?? []).length
  const crlf = (text.match(/\r\n/g) ?? []).length
  return crlf > 0 && crlf >= totalLf - crlf ? '\r\n' : '\n'
}

function toLf(text: string): string {
  return text.replace(/\r\n/g, '\n')
}

function restoreEol(lfText: string, eol: '\n' | '\r\n'): string {
  return eol === '\r\n' ? lfText.replace(/\n/g, '\r\n') : lfText
}

function readCodePointAt(text: string, index: number): number {
  const lead = text.charCodeAt(index)
  if (lead < 0xd800 || lead > 0xdbff || index + 1 >= text.length) return lead
  const trail = text.charCodeAt(index + 1)
  if (trail < 0xdc00 || trail > 0xdfff) return lead
  return (lead - 0xd800) * 0x400 + (trail - 0xdc00) + 0x10000
}

function utf8Length(codePoint: number): number {
  if (codePoint <= 0x7f) return 1
  if (codePoint <= 0x7ff) return 2
  if (codePoint <= 0xffff) return 3
  return 4
}

function getUtf8OffsetsAtCodeUnitIndices(text: string, codeUnitIndices: number[]): Map<number, number> {
  const targets = [...new Set(codeUnitIndices)].sort((a, b) => a - b)
  const offsets = new Map<number, number>()
  let codeUnitIndex = 0
  let byteOffset = 0
  for (const target of targets) {
    const boundedTarget = Math.max(0, Math.min(target, text.length))
    while (codeUnitIndex < boundedTarget) {
      const codePoint = readCodePointAt(text, codeUnitIndex)
      byteOffset += utf8Length(codePoint)
      codeUnitIndex += codePoint > 0xffff ? 2 : 1
    }
    offsets.set(target, byteOffset)
  }
  return offsets
}

function hasRepeatedHalfMatchSeed(textA: string, textB: string): boolean {
  // Match diff-match-patch's prefix/suffix trimming so a small edit isn't mistaken for a repetitive replacement.
  const minimumLength = Math.min(textA.length, textB.length)
  let prefixLength = 0
  while (prefixLength < minimumLength && textA.charCodeAt(prefixLength) === textB.charCodeAt(prefixLength)) {
    prefixLength += 1
  }
  let suffixLength = 0
  while (
    suffixLength < minimumLength - prefixLength &&
    textA.charCodeAt(textA.length - suffixLength - 1) === textB.charCodeAt(textB.length - suffixLength - 1)
  ) {
    suffixLength += 1
  }
  const middleA = textA.slice(prefixLength, textA.length - suffixLength)
  const middleB = textB.slice(prefixLength, textB.length - suffixLength)
  const longText = middleA.length > middleB.length ? middleA : middleB
  const shortText = middleA.length > middleB.length ? middleB : middleA
  if (longText.length < 4 || shortText.length * 2 < longText.length) return false

  const seedLength = Math.floor(longText.length / 4)
  for (const start of [Math.ceil(longText.length / 4), Math.ceil(longText.length / 2)]) {
    const seed = longText.slice(start, start + seedLength)
    const firstMatch = shortText.indexOf(seed)
    if (firstMatch !== -1 && shortText.includes(seed, firstMatch + 1)) return true
  }
  return false
}
