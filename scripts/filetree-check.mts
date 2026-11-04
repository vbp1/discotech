// Usage: node_modules/.bin/tsx scripts/filetree-check.mts
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { DirEntry, Project } from '../src/shared/api'

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true })
for (const key of ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'Element', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { value: (dom.window as any)[key], configurable: true })
}
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
Object.defineProperties(dom.window.HTMLElement.prototype, {
  clientHeight: { get: () => 600 },
  clientWidth: { get: () => 300 }
})
dom.window.HTMLElement.prototype.scrollTo = () => {}
const { FileTree } = await import('../src/renderer/src/FileTree')
const project: Project = { id: 'test', rootPath: '/test', name: 'test', distro: 'test' }
const entry = (path: string, isDir = false): DirEntry => ({ path, name: path.split('/').at(-1)!, isDir, isSymlink: false, linkError: null })
const initial = () => new Map([
  ['/test', [entry('/test/folder', true), entry('/test/target', true), entry('/test/a'), entry('/test/b'), entry('/test/c')]],
  ['/test/folder', [entry('/test/folder/child')]],
  ['/test/target', [] as DirEntry[]]
])
let dirs = initial()
let moves: string[] = []
let batches: string[][] = []
let opened: string[] = []
let cancel: string | null = null
;(dom.window as any).discotech = {
  listDir: async (_: Project, path: string) => dirs.get(path) ?? [],
  onFsEvent: () => () => {}
}
const root = createRoot(document.getElementById('root')!)
let revision = 0
async function reset() {
  dirs = initial(); moves = []; batches = []; opened = []; cancel = null
  await act(async () => {
    root.render(createElement(FileTree, {
      key: ++revision, project, activePath: null, fontSize: 13, clipboard: null,
      onClipboardChange: () => {}, onDeletePath: async () => false,
      onOpenFile: (path) => opened.push(path),
      onMovePaths: async (paths, target) => {
        batches.push(paths)
        if (paths.includes(cancel!)) return []
        moves.push(...paths)
        return paths.map((from) => {
          const parent = from.slice(0, from.lastIndexOf('/'))
          const item = dirs.get(parent)!.find((e) => e.path === from)!
          dirs.set(parent, dirs.get(parent)!.filter((e) => e !== item))
          const to = target + '/' + item.name
          dirs.set(target, [...dirs.get(target)!, { ...item, path: to }])
          return { from, to }
        })
      },
      onTransferPath: async (from, target) => {
        moves.push(from)
        if (from === cancel) return null
        const parent = from.slice(0, from.lastIndexOf('/'))
        const item = dirs.get(parent)!.find((e) => e.path === from)!
        dirs.set(parent, dirs.get(parent)!.filter((e) => e !== item))
        const to = target + '/' + item.name
        dirs.set(target, [...dirs.get(target)!, { ...item, path: to }])
        return to
      }
    }))
  })
}
function row(path: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('.tree-row')].find((el) => el.title === path)
  assert.ok(found, `row exists: ${path}`)
  return found
}
async function click(path: string, options: MouseEventInit = {}) {
  await act(async () => row(path).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ...options })))
}
function selected(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.tree-row-selected')].map((el) => el.title).sort()
}
async function drag(from: string, target: string, dataOverride?: string) {
  const data = new Map<string, string>()
  const dataTransfer = { setData: (key: string, value: string) => data.set(key, value), getData: (key: string) => dataOverride ?? data.get(key) ?? '', get types() { return [...data.keys()] } }
  for (const [type, path] of [['dragstart', from], ['drop', target]]) {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
    await act(async () => row(path).dispatchEvent(event))
  }
}

await reset()
await click('/test/target')
await click('/test/a')
await click('/test/b', { ctrlKey: true })
assert.deepEqual(selected(), ['/test/a', '/test/b'])
assert.deepEqual(opened, ['/test/a'], 'modified clicks do not open files')
await click('/test/b', { ctrlKey: true })
assert.deepEqual(selected(), ['/test/a'])
await click('/test/a')
await click('/test/c', { shiftKey: true })
assert.deepEqual(selected(), ['/test/a', '/test/b', '/test/c'])
await drag('/test/b', '/test/target')
assert.deepEqual(moves, ['/test/a', '/test/b', '/test/c'], 'dragging a selected row moves the entire selection')
assert.deepEqual(batches, [['/test/a', '/test/b', '/test/c']], 'the complete selection is sent as a single operation')
assert.deepEqual(selected(), ['/test/target/a', '/test/target/b', '/test/target/c'], 'moved files stay selected at their destination')
assert.ok(row('/test/target/a'))
assert.ok(row('/test/target/b'))
assert.ok(row('/test/target/c'))

await reset()
await click('/test/a')
await click('/test/b', { ctrlKey: true })
await drag('/test/c', '/test/target')
assert.deepEqual(moves, ['/test/c'], 'dragging an unselected file moves only that file')

await reset()
await click('/test/folder')
await click('/test/folder/child', { ctrlKey: true })
await drag('/test/folder', '/test/target')
assert.deepEqual(moves, ['/test/folder'], 'selected descendants move with their folder only once')

await reset()
await click('/test/a')
await click('/test/folder', { ctrlKey: true })
await drag('/test/a', '/test/folder')
assert.deepEqual(moves, [], 'invalid destination rejects the whole selection before any move')

await reset()
await click('/test/a')
await click('/test/c', { shiftKey: true })
cancel = '/test/b'
await drag('/test/a', '/test/target')
assert.deepEqual(moves, [], 'cancellation leaves the complete group untouched')
assert.deepEqual(selected(), ['/test/a', '/test/b', '/test/c'], 'unmoved files stay selected')

await reset()
await click('/test/a')
await click('/test/b', { ctrlKey: true })
await drag('/test/b', '/test/c')
assert.deepEqual(moves, [], 'dropping into the source folder is a no-op')
await click('/test/c')
assert.deepEqual(selected(), ['/test/c'], 'ordinary click replaces the selection')

await reset()
await drag('/test/a', '/test/target', '["/outside/file"]')
assert.deepEqual(moves, [], 'invalid payload does not move any file')
await drag('/test/a', '/test/target', '{')
assert.deepEqual(moves, [], 'malformed payload does not move any file')
await act(async () => root.unmount())
dom.window.close()
console.log('File tree: selection, ranges, group/single moves, descendants, invalid targets, cancellation and malformed payloads passed.')
