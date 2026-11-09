// Run with Windows Node against scripts/run-win.sh --remote-debugging-port=9333.
// Uses the running app's real IPC and disposable fixtures; restores the selected project.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pages = await (await fetch('http://127.0.0.1:9333/json/list')).json()
const page = pages.find((p) => p.type === 'page' && p.title === 'discotech')
assert.ok(page, 'running discotech renderer')
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let id = 0
const pending = new Map()
const exceptions = []
ws.onmessage = ({ data }) => {
  const message = JSON.parse(data)
  if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails)
  const request = pending.get(message.id)
  if (!request) return
  pending.delete(message.id)
  clearTimeout(request.timer)
  if (message.error) request.reject(new Error(JSON.stringify(message.error)))
  else request.resolve(message.result)
}
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const requestId = ++id
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`${method} timed out`)) }, 30000)
    pending.set(requestId, { resolve, reject, timer })
    ws.send(JSON.stringify({ id: requestId, method, params }))
  })
}
async function evaluate(fn, ...args) {
  const result = await send('Runtime.evaluate', {
    expression: `(${fn})(${args.map((arg) => JSON.stringify(arg)).join(',')})`, awaitPromise: true, returnByValue: true
  })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
const pause = () => new Promise((resolve) => setTimeout(resolve, 100))
async function waitFor(fn, label) {
  for (let i = 0; i < 150; i++) { if (await fn()) return; await pause() }
  throw new Error(`Timed out: ${label}`)
}
async function clickRow(file, modifiers = 0) {
  const rect = await evaluate((file) => {
    const el = [...document.querySelectorAll('.tree-row')].find((el) => el.title === file)
    if (!el) throw new Error(`Missing row: ${file}`)
    const r = el.getBoundingClientRect()
    return { x: r.x + Math.min(r.width / 2, 100), y: r.y + r.height / 2 }
  }, file)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...rect, button: 'left', clickCount: 1, modifiers })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...rect, button: 'left', clickCount: 1, modifiers })
}
async function screenshot(name) {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  const target = fileURLToPath(new URL(`../out/${name}.png`, import.meta.url))
  await writeFile(target, Buffer.from(shot.data, 'base64'))
  console.log(`SCREENSHOT ${target}`)
}
async function treeKey(code, ctrl = true) {
  await evaluate((code, ctrl) => {
    document.querySelector('.tree').dispatchEvent(
      new KeyboardEvent('keydown', { code, key: code === 'Delete' ? 'Delete' : '', ctrlKey: ctrl, bubbles: true, cancelable: true })
    )
  }, code, ctrl)
}
async function contextMenu(target) {
  await evaluate((target) => {
    const el = target === null ? document.querySelector('.tree') : [...document.querySelectorAll('.tree-row')].find((el) => el.title === target)
    if (!el) throw new Error(`Missing row: ${target}`)
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  }, target)
}
async function menuClick(label) {
  await evaluate((label) => {
    const item = [...document.querySelectorAll('.menu-item')].find((el) => el.querySelector('.menu-label')?.textContent === label)
    if (!item) throw new Error(`Missing menu item: ${label}`)
    item.click()
  }, label)
}
async function dialogClick(label) {
  await evaluate((label) => {
    const button = [...document.querySelectorAll('.dialog button')].find((b) => b.textContent.trim() === label)
    if (!button) throw new Error(`Missing dialog button: ${label}`)
    button.click()
  }, label)
}
let fixture
let wslFixture
let originalProject
await send('Runtime.enable')
try {
  assert.equal(await evaluate(() => typeof window.discotech.createDir), 'function', 'new app build is running')
  assert.equal(await evaluate(() => typeof window.discotech.transferPaths), 'function', 'new app build is running')
  const projects = await evaluate(() => window.discotech.listProjects())
  const project = projects.find((p) => p.distro === null && p.rootPath === 'C:/temp')
  assert.ok(project, 'C:/temp project is configured for the UI check')
  fixture = await mkdtemp('C:/temp/000-discotech-check-')
  for (const name of ['a.txt', 'b.txt', 'c.txt']) await writeFile(path.join(fixture, name), name)
  const rootPath = fixture.replaceAll('\\', '/')
  originalProject = await evaluate((projectId) => {
    const select = document.querySelector('.project-select')
    const previous = select.value
    select.value = projectId
    select.dispatchEvent(new Event('change', { bubbles: true }))
    return previous
  }, project.id)
  await waitFor(() => evaluate((file) => !![...document.querySelectorAll('.tree-row')].find((el) => el.title === file), rootPath), 'fixture folder listed')
  await clickRow(rootPath)
  await waitFor(() => evaluate((file) => !![...document.querySelectorAll('.tree-row')].find((el) => el.title === file), rootPath + '/a.txt'), 'fixture expanded')
  await evaluate(() => document.querySelector('button[title="Создать папку"]').click())
  await waitFor(() => evaluate(() => !!document.querySelector('input[aria-label="Имя папки"]')), 'create folder dialog')
  await send('Input.insertText', { text: 'destination' })
  await evaluate(() => document.querySelector('form.dialog').requestSubmit())
  await waitFor(async () => (await readdir(fixture)).includes('destination'), 'folder created on disk')
  await waitFor(() => evaluate(() => !document.querySelector('form.dialog')), 'folder dialog closed')
  const destination = rootPath + '/destination'
  // The new folder was selected after creation; remove it before selecting the range.
  await clickRow(destination, 2)
  await clickRow(rootPath + '/a.txt', 2)
  await clickRow(rootPath + '/c.txt', 8)
  assert.deepEqual(await evaluate(() => [...document.querySelectorAll('.tree-row-selected')].map((el) => el.title).sort()),
    [rootPath + '/a.txt', rootPath + '/b.txt', rootPath + '/c.txt'])
  await screenshot('filetree-selection')
  await evaluate((from, to) => {
    const rows = [...document.querySelectorAll('.tree-row')]
    const dataTransfer = new DataTransfer()
    rows.find((el) => el.title === from).dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }))
    rows.find((el) => el.title === to).dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
  }, rootPath + '/b.txt', destination)
  await waitFor(async () => (await readdir(path.join(fixture, 'destination'))).length === 3, 'entire group moved on disk')
  assert.deepEqual((await readdir(fixture)).sort(), ['destination'])
  await waitFor(() => evaluate((file) => ![...document.querySelectorAll('.tree-row')].find((el) => el.title === file), rootPath + '/a.txt'), 'source tree refreshed')
  await clickRow(destination)
  await waitFor(() => evaluate((file) => !![...document.querySelectorAll('.tree-row')].find((el) => el.title === file), destination + '/c.txt'), 'destination tree refreshed')

  // Group copy: Ctrl+C on the three files, Paste into the project root via the tree background.
  await clickRow(destination + '/a.txt')
  await clickRow(destination + '/b.txt', 2)
  await clickRow(destination + '/c.txt', 2)
  await treeKey('KeyC')
  assert.equal(await evaluate(() => document.querySelector('button[title^="Вставить"]').title), 'Вставить 3 элемента (Ctrl+V)')
  await contextMenu(null)
  await menuClick('Вставить')
  await waitFor(async () => (await readdir(fixture)).sort().toString() === 'a.txt,b.txt,c.txt,destination', 'group copied to the root on disk')
  await waitFor(() => evaluate((file) => !![...document.querySelectorAll('.tree-row')].find((el) => el.title === file), rootPath + '/a.txt'), 'copies listed in the tree')
  await waitFor(() => evaluate(() => [...document.querySelectorAll('.tree-row-selected')].length === 3), 'the copies are selected')
  await screenshot('filetree-copied')

  // Group cut with a conflict: Ctrl+X on the copies, Paste over the originals, confirm the replacement.
  await treeKey('KeyX')
  await waitFor(() => evaluate(() => [...document.querySelectorAll('.tree-row-cut')].length === 3), 'every cut row is marked')
  await contextMenu(destination)
  await menuClick('Вставить')
  await waitFor(() => evaluate(() => [...document.querySelectorAll('.dialog')].length === 1), 'conflict dialog')
  await dialogClick('Заменить и продолжить')
  await waitFor(async () => (await readdir(fixture)).sort().toString() === 'destination', 'cut group left the root')
  assert.deepEqual((await readdir(path.join(fixture, 'destination'))).sort(), ['a.txt', 'b.txt', 'c.txt'], 'destination keeps the replaced files')

  // Group delete: one confirmation for the whole selection.
  await clickRow(destination + '/a.txt')
  await clickRow(destination + '/c.txt', 2)
  await treeKey('Delete', false)
  await waitFor(() => evaluate(() => document.querySelectorAll('.dialog').length === 1), 'delete confirmation dialog')
  await dialogClick('Удалить')
  await waitFor(async () => (await readdir(path.join(fixture, 'destination'))).length === 0, 'group deleted on disk')
  await waitFor(() => evaluate((file) => ![...document.querySelectorAll('.tree-row')].find((el) => el.title === file), destination + '/a.txt'), 'deleted rows disappear')
  await screenshot('filetree-moved')
  console.log('PASS native UI: create folder, Ctrl/Shift selection, group drop, group copy/cut/paste/delete, conflicts and tree refresh')

  const distro = projects.find((p) => p.distro)?.distro
  assert.ok(distro, 'WSL project configured')
  wslFixture = await mkdtemp(`\\\\wsl.localhost\\${distro}\\tmp\\discotech-batch-`)
  const wslRoot = '/tmp/' + path.basename(wslFixture)
  const wslProject = { id: 'filetree-check', rootPath: wslRoot, name: 'filetree-check', distro }
  const api = (method, ...args) => evaluate((method, args) => window.discotech[method](...args), method, args)
  await api('createDir', wslProject, wslRoot, 'target')
  for (const name of ['a', 'b', 'c']) await writeFile(path.join(wslFixture, name), name)
  for (const name of ['', '..', 'a/b', ' trailing ']) {
    await assert.rejects(() => api('createDir', wslProject, wslRoot, name), /Invalid folder name/)
  }
  await assert.rejects(() => api('createDir', wslProject, wslRoot, 'target'), /File exists/)
  await assert.rejects(() => api('transferPaths', wslProject, [wslRoot + '/a', wslRoot + '/missing'], wslRoot + '/target', 'move', false), /does not exist/)
  assert.equal(await readFile(path.join(wslFixture, 'a'), 'utf8'), 'a', 'preflight failure leaves other sources untouched')
  const result = await api('transferPaths', wslProject, ['a', 'b', 'c'].map((name) => wslRoot + '/' + name), wslRoot + '/target', 'move', false)
  assert.equal(result.status, 'done')
  assert.equal(result.moves.length, 3)
  assert.deepEqual((await readdir(path.join(wslFixture, 'target'))).sort(), ['a', 'b', 'c'])
  await writeFile(path.join(wslFixture, 'a'), 'replacement')
  const conflict = await api('transferPaths', wslProject, [wslRoot + '/a'], wslRoot + '/target', 'move', false)
  assert.equal(conflict.status, 'exists')
  assert.equal(await readFile(path.join(wslFixture, 'target', 'a'), 'utf8'), 'a')
  assert.equal((await api('transferPaths', wslProject, [wslRoot + '/a'], wslRoot + '/target', 'move', true)).status, 'done')
  assert.equal(await readFile(path.join(wslFixture, 'target', 'a'), 'utf8'), 'replacement')

  // Group copy back to the root: sources stay, copies appear; a taken name is confirmed, then replaced.
  const copied = await api('transferPaths', wslProject, ['a', 'b'].map((name) => wslRoot + '/target/' + name), wslRoot, 'copy', false)
  assert.equal(copied.status, 'done')
  assert.equal(copied.moves.length, 2)
  assert.deepEqual((await readdir(wslFixture)).sort(), ['a', 'b', 'target'], 'copies appear beside the sources')
  assert.deepEqual((await readdir(path.join(wslFixture, 'target'))).sort(), ['a', 'b', 'c'], 'copy leaves the sources in place')
  await writeFile(path.join(wslFixture, 'a'), 'newer')
  const copyConflict = await api('transferPaths', wslProject, [wslRoot + '/target/a'], wslRoot, 'copy', false)
  assert.equal(copyConflict.status, 'exists', 'copy reports a taken name without touching it')
  assert.equal(await readFile(path.join(wslFixture, 'a'), 'utf8'), 'newer')
  assert.equal((await api('transferPaths', wslProject, [wslRoot + '/target/a'], wslRoot, 'copy', true)).status, 'done')
  assert.equal(await readFile(path.join(wslFixture, 'a'), 'utf8'), 'a', 'confirmed copy replaces the file')
  assert.equal((await api('transferPaths', wslProject, [wslRoot + '/target/c'], wslRoot, 'copy', false)).status, 'done')
  const freeName = await api('transferPaths', wslProject, [wslRoot + '/target/c'], wslRoot + '/target', 'copy', false)
  assert.equal(freeName.status, 'done')
  assert.equal(freeName.moves[0].to, wslRoot + '/target/c copy', 'a copy into its own folder takes a free name')
  assert.deepEqual((await readdir(wslFixture)).sort(), ['a', 'b', 'c', 'target'])
  assert.deepEqual((await readdir(path.join(wslFixture, 'target'))).sort(), ['a', 'b', 'c', 'c copy'])
  console.log('PASS WSL IPC: mkdir, invalid names, duplicate folder, full preflight, batch mv/cp, conflicts, confirmed replacement and free copy names')
  assert.deepEqual(exceptions, [], 'no uncaught renderer errors')
} finally {
  try {
    if (originalProject !== undefined) await evaluate((id) => {
      const select = document.querySelector('.project-select')
      select.value = id
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }, originalProject)
    if (fixture) await rm(fixture, { recursive: true, force: true })
    if (wslFixture) await rm(wslFixture, { recursive: true, force: true })
  } finally { ws.close() }
}
