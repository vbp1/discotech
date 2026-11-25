// Usage: node_modules/.bin/tsx scripts/filetree-check.mts
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import type { DirEntry, Project, TransferMode } from '../src/shared/api'
import type { TreeClipboard } from '../src/renderer/src/FileTree'

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
let modes: TransferMode[] = []
let targets: string[] = []
let opened: string[] = []
let deletions: string[][] = []
let cancel: string | null = null
let clip: TreeClipboard | null = null
let activePath: string | null = null
;(dom.window as any).discotech = {
  listDir: async (_: Project, path: string) => dirs.get(path) ?? [],
  onFsEvent: () => () => {}
}
const root = createRoot(document.getElementById('root')!)
let revision = 0
function treeProps(key: number) {
  return {
    key, project, visible: true, activePath, fontSize: 13, clipboard: clip,
    onClipboardChange: (next: TreeClipboard | null) => { clip = next },
    onDeletePaths: async (paths: string[]) => {
      deletions.push(paths)
      for (const p of paths) {
        const parent = p.slice(0, p.lastIndexOf('/'))
        dirs.set(parent, dirs.get(parent)!.filter((e) => e.path !== p && !e.path.startsWith(p + '/')))
      }
      return true
    },
    onOpenFile: (path: string) => opened.push(path),
    onTransferPaths: async (paths: string[], target: string, mode: TransferMode) => {
      batches.push(paths)
      modes.push(mode)
      targets.push(target)
      const group = cancel && paths.includes(cancel) ? [] : paths
      moves.push(...group)
      return group.map((from) => {
        const parent = from.slice(0, from.lastIndexOf('/'))
        const item = dirs.get(parent)!.find((e) => e.path === from)!
        if (mode === 'move') dirs.set(parent, dirs.get(parent)!.filter((e) => e !== item))
        let name = item.name
        if (mode === 'copy') {
          // A copy into its own folder takes a free "name copy" name, as the backend does.
          const taken = new Set(dirs.get(target)!.map((e) => e.name))
          if (taken.has(name)) {
            const dot = name.lastIndexOf('.')
            name = `${dot > 0 ? name.slice(0, dot) : name} copy${dot > 0 ? name.slice(dot) : ''}`
          }
        }
        const to = target + '/' + name
        dirs.set(target, [...dirs.get(target)!, { ...item, name, path: to }])
        return { from, to }
      })
    }
  }
}
async function reset() {
  dirs = initial(); moves = []; batches = []; modes = []; targets = []; opened = []; deletions = []; cancel = null; clip = null; activePath = null
  await act(async () => {
    root.render(createElement(FileTree, treeProps(++revision)))
  })
}
/** Re-renders with the harness clipboard, as the app's state would. */
async function rerender() {
  await act(async () => {
    root.render(createElement(FileTree, treeProps(revision)))
  })
}
function row(path: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('.tree-row')].find((el) => el.title === path)
  assert.ok(found, `row exists: ${path}`)
  return found
}
function hasRow(path: string): boolean {
  return [...document.querySelectorAll('.tree-row')].some((el) => el.title === path)
}
async function click(path: string, options: MouseEventInit = {}) {
  await act(async () => row(path).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, ...options })))
}
function selected(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.tree-row-selected')].map((el) => el.title).sort()
}
async function key(code: string, options: { ctrl?: boolean } = {}) {
  await act(async () => {
    document.querySelector('.tree')!.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        code,
        key: code === 'Delete' ? 'Delete' : '',
        ctrlKey: options.ctrl ?? true,
        bubbles: true,
        cancelable: true
      })
    )
  })
}
async function openMenu(path: string | null) {
  const target = path === null ? document.querySelector('.tree')! : row(path)
  await act(async () => target.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })))
}
async function menuClick(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>('.menu-item')].find((el) => el.querySelector('.menu-label')?.textContent === label)
  assert.ok(item, `menu item exists: ${label}`)
  await act(async () => item.click())
}
function toolbar(title: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>('.tree-toolbar button')].find((b) => b.title.startsWith(title))
  assert.ok(found, `toolbar button exists: ${title}`)
  return found
}
/** Lets async handlers from a previous action finish before the next assertion. */
const flush = (): Promise<void> => act(async () => {})
async function startDrag(from: string, dataOverride?: string) {
  const data = new Map<string, string>()
  const dataTransfer = { setData: (key: string, value: string) => data.set(key, value), getData: (key: string) => dataOverride ?? data.get(key) ?? '', get types() { return [...data.keys()] } }
  const emit = async (type: string, path: string) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: dataTransfer })
    await act(async () => row(path).dispatchEvent(event))
  }
  await emit('dragstart', from)
  return emit
}
async function drag(from: string, target: string, dataOverride?: string) {
  const emit = await startDrag(from, dataOverride)
  await emit('drop', target)
}
const wait = (ms: number): Promise<void> => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)) })

await reset()
activePath = '/test/a'
await rerender()
await drag('/test/a', '/test/target')
activePath = '/test/target/a'
await rerender()
assert.equal(row('/test/target').getAttribute('aria-expanded'), 'false', 'moving the active file does not reveal its destination')
assert.equal(hasRow('/test/target/a'), false, 'the moved file stays inside the collapsed destination')
activePath = '/test/folder/child'
await rerender()
assert.equal(row('/test/folder').getAttribute('aria-expanded'), 'true', 'opening another file still reveals its ancestors')

for (const mode of ['copy', 'move'] as const) {
  for (const via of ['menu', 'toolbar'] as const) {
    await reset()
    activePath = '/test/a'
    await rerender()
    const label = mode === 'copy' ? 'Копировать' : 'Вырезать'
    if (via === 'menu') {
      await openMenu('/test/a')
      await menuClick(label)
    } else {
      await click('/test/a')
      await act(async () => toolbar(label).click())
    }
    await rerender()
    if (via === 'menu') {
      await openMenu('/test/target')
      await menuClick('Вставить')
    } else {
      await click('/test/target')
      await click('/test/target')
      await act(async () => toolbar('Вставить').click())
    }
    await flush()
    if (mode === 'move') activePath = '/test/target/a'
    await rerender()
    assert.deepEqual(modes, [mode], `${via} pastes using ${mode}`)
    assert.ok(dirs.get('/test/target')!.some((e) => e.path === '/test/target/a'), 'paste completes inside the destination')
    assert.equal(row('/test/target').getAttribute('aria-expanded'), 'false', `${mode} via ${via} keeps the destination closed`)
    assert.equal(hasRow('/test/target/a'), false, 'pasted items stay inside the collapsed destination')
  }
}

await reset()
let emit = await startDrag('/test/a')
await emit('dragover', '/test/target')
await wait(1700)
assert.equal(row('/test/target').getAttribute('aria-expanded'), 'false', 'hovering for less than two seconds keeps the folder closed')
await emit('dragover', '/test/target')
await wait(400)
assert.equal(row('/test/target').getAttribute('aria-expanded'), 'true', 'continuous hovering opens the folder after two seconds')
await emit('drop', '/test/target')
assert.ok(hasRow('/test/target/a'), 'a folder opened by hovering stays open after drop')

await reset()
emit = await startDrag('/test/a')
await emit('dragover', '/test/target')
await emit('drop', '/test/target')
await wait(2100)
assert.equal(row('/test/target').getAttribute('aria-expanded'), 'false', 'drop cancels the pending expansion timer')

await reset()
emit = await startDrag('/test/a')
await emit('dragover', '/test/target')
await emit('dragleave', '/test/target')
await wait(2100)
assert.equal(row('/test/target').getAttribute('aria-expanded'), 'false', 'leaving the tree cancels the pending expansion timer')
await emit('dragend', '/test/a')

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

await reset()
assert.ok(toolbar('Копировать').disabled, 'copy is disabled with nothing selected')
await click('/test/a')
assert.ok(!toolbar('Копировать').disabled, 'copy is enabled with one selected item')
await click('/test/b', { ctrlKey: true })
assert.ok(!toolbar('Копировать').disabled && !toolbar('Вырезать').disabled, 'copy and cut work for several selected items')
await key('KeyC')
assert.deepEqual(clip, { projectId: 'test', paths: ['/test/a', '/test/b'], mode: 'copy' })
await rerender()
assert.equal(toolbar('Вставить').title, 'Вставить 2 элемента (Ctrl+V)')
await click('/test/target')
await key('KeyV')
await flush()
assert.deepEqual(batches, [['/test/a', '/test/b']], 'paste sends the whole clipboard as a single operation')
assert.deepEqual(modes, ['copy'])
assert.deepEqual(targets, ['/test/target'], 'paste goes into the selected folder')
assert.ok(row('/test/target/a') && row('/test/target/b'), 'copies are listed')
assert.ok(row('/test/a') && row('/test/b'), 'sources stay after a copy')
assert.deepEqual(selected(), ['/test/target/a', '/test/target/b'], 'the copies become the selection')
assert.deepEqual(clip, { projectId: 'test', paths: ['/test/a', '/test/b'], mode: 'copy' }, 'a copied group keeps waiting for Paste')

await reset()
await click('/test/a')
await click('/test/b', { ctrlKey: true })
await key('KeyX')
assert.deepEqual(clip, { projectId: 'test', paths: ['/test/a', '/test/b'], mode: 'move' })
await rerender()
assert.deepEqual(
  [...document.querySelectorAll('.tree-row-cut')].map((el) => (el as HTMLElement).title).sort(),
  ['/test/a', '/test/b'],
  'every cut row is marked'
)
await click('/test/target')
await openMenu('/test/target')
await menuClick('Вставить')
await flush()
assert.deepEqual(batches, [['/test/a', '/test/b']], 'menu paste transfers the whole group')
assert.deepEqual(modes, ['move'])
assert.deepEqual(targets, ['/test/target'])
assert.ok(row('/test/target/a') && row('/test/target/b'), 'cut items land in the target folder')
assert.deepEqual(selected(), ['/test/target/a', '/test/target/b'], 'pasted items are selected')
assert.equal(clip, null, 'the clipboard empties after a successful cut-paste')

await reset()
await click('/test/folder')
await click('/test/folder/child', { ctrlKey: true })
await key('KeyC')
assert.deepEqual(clip?.paths, ['/test/folder'], 'a selected folder carries its selected descendants in the clipboard')

await reset()
await click('/test/a')
await click('/test/b', { ctrlKey: true })
await openMenu('/test/a')
assert.deepEqual(selected(), ['/test/a', '/test/b'], 'right-click on a selected row keeps the selection')
await menuClick('Копировать')
assert.deepEqual(clip, { projectId: 'test', paths: ['/test/a', '/test/b'], mode: 'copy' }, 'menu Copy takes the whole selection')
await openMenu('/test/c')
assert.deepEqual(selected(), ['/test/c'], 'right-click on an unselected row selects only it')

await reset()
await click('/test/a')
await click('/test/b', { ctrlKey: true })
await key('KeyC')
await rerender()
await click('/test/c')
await key('KeyV')
await flush()
assert.deepEqual(batches, [['/test/a', '/test/b']])
assert.deepEqual(targets, ['/test'], 'keyboard paste lands beside the single selected file')

await reset()
assert.ok(toolbar('Удалить').disabled, 'delete is disabled with nothing selected')
await click('/test/a')
await click('/test/b', { ctrlKey: true })
assert.ok(!toolbar('Удалить').disabled, 'delete works for several selected items')
await key('Delete', { ctrl: false })
await flush()
assert.deepEqual(deletions, [['/test/a', '/test/b']], 'Delete removes the whole selection in one call')
assert.ok(!hasRow('/test/a') && !hasRow('/test/b'), 'deleted rows disappear')
assert.deepEqual(selected(), [], 'the selection clears')

await reset()
await click('/test/a')
await click('/test/b', { ctrlKey: true })
await openMenu('/test/a')
await menuClick('Удалить')
await flush()
assert.deepEqual(deletions, [['/test/a', '/test/b']], 'menu delete takes the whole selection')
assert.ok(!hasRow('/test/a') && !hasRow('/test/b'), 'deleted rows disappear')

await act(async () => root.unmount())
dom.window.close()
console.log('File tree: selection, ranges, group moves, clipboard and delete, descendants, invalid targets, cancellation and malformed payloads passed.')
