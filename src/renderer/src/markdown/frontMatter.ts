// Adapted from Orca (https://github.com/stablyai/orca), MIT License, Copyright (c) 2026 Lovecast Inc.
// Source: src/renderer/src/components/editor/markdown-frontmatter.ts
const FRONTMATTER_RE = /^(---|\+\+\+)\r?\n(?:[\s\S]*?\r?\n)?\1(?:\r?\n|$)/

/** Splits a leading YAML/TOML front matter block (with delimiters) from the markdown body. */
export function splitFrontMatter(content: string): { frontMatter: string; body: string } {
  const match = content.match(FRONTMATTER_RE)
  if (!match) return { frontMatter: '', body: content }
  return { frontMatter: match[0], body: content.slice(match[0].length) }
}
