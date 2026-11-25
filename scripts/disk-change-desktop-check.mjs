// Checks disk changes and edit history in a disposable instance of the app.
// Run with Windows Node. Pass a Windows path to a separate build, or use the build from scripts/run-win.sh:
//   node \\wsl.localhost\<distro>\<repo>\scripts\disk-change-desktop-check.mjs <distro> [port] [app-dir]
// The script writes a throwaway project into the distro's /tmp, starts electron.exe from
// %DISCOTECH_WIN_DIR% (default %USERPROFILE%\discotech-dev) with its own --user-data-dir and the
// DevTools port (default 9334), and removes the copy, its data and the project at the end.
// Set DISCOTECH_TAB_SCREENSHOT to a Windows path to capture the tab context menu.
// The "Сохранить как…" button opens the native Windows dialog, which DevTools cannot drive: check it by hand.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const [distro, portArg = '9334', buildDir] = process.argv.slice(2)
if (!distro || !/^\d+$/.test(portArg)) {
  console.error('Usage: node disk-change-desktop-check.mjs <WSL distro> [DevTools port, default 9334] [built app directory]. Nothing was started.')
  process.exit(2)
}
const port = Number(portArg)
const winDir = process.env.DISCOTECH_WIN_DIR ?? path.join(process.env.USERPROFILE ?? '', 'discotech-dev')
const electronExe = path.join(winDir, 'node_modules', 'electron', 'dist', 'electron.exe')
const appDir = buildDir ?? path.join(winDir, 'app')
for (const required of [electronExe, path.join(appDir, 'package.json')]) {
  try {
    await readFile(required)
  } catch {
    console.error(`Missing ${required}. Run scripts/run-win.sh first. Nothing was started.`)
    process.exit(2)
  }
}
const portTaken = await fetch(`http://127.0.0.1:${port}/json/version`).then(() => true, () => false)
if (portTaken) {
  console.error(`Port ${port} is already in use (another app with remote debugging?). Pass a free port. Nothing was started.`)
  process.exit(2)
}

const fixture = await mkdtemp(`\\\\wsl.localhost\\${distro}\\tmp\\discotech-disk-check-`)
const root = '/tmp/' + path.basename(fixture)
const userData = await mkdtemp(path.join(tmpdir(), 'discotech-disk-check-data-'))
await mkdir(path.join(fixture, '.hidden'))
await mkdir(path.join(fixture, 'destination'))
const NOTES = path.join(fixture, '.hidden', 'notes.txt')
const DOC = path.join(fixture, '.hidden', 'doc.md')
const HTML = path.join(fixture, '.hidden', 'page.html')
await writeFile(NOTES, 'line one\n')
await writeFile(DOC, '# Title\n\nFirst paragraph.\n')
await writeFile(HTML, '<p>Example</p>\n')
await writeFile(path.join(fixture, 'preview.txt'), 'Preview tab\n')
await writeFile(path.join(fixture, 'another.txt'), 'Another file\n')
// Both files sit in a hidden folder, which the project watchers skip: only open tabs are watched there.
await writeFile(path.join(userData, 'settings.json'), JSON.stringify({ projects: [{ id: 'check', name: 'check', distro, rootPath: root }] }))
await writeFile(
  path.join(userData, 'session.json'),
  JSON.stringify({
    activeProjectId: 'check',
    projects: { check: { tabs: ['notes.txt', 'doc.md', 'page.html'].map((name) => ({ path: `${root}/.hidden/${name}`, pinned: true })), active: `${root}/.hidden/notes.txt` } }
  })
)

const app = spawn(electronExe, [appDir, `--remote-debugging-port=${port}`, `--user-data-dir=${userData}`], { stdio: 'ignore' })
let ws
const pause = (ms = 100) => new Promise((resolve) => setTimeout(resolve, ms))
async function waitFor(fn, label, tries = 150) {
  for (let i = 0; i < tries; i++) {
    if (await fn()) return
    await pause()
  }
  throw new Error(`Timed out: ${label}`)
}
try {
  let page
  await waitFor(async () => {
    const pages = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json(), () => [])
    page = pages.find((p) => p.type === 'page' && p.title === 'discotech')
    return !!page
  }, 'test copy of the app started')
  ws = new WebSocket(page.webSocketDebuggerUrl)
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
    if (message.error) request.reject(new Error(JSON.stringify(message.error)))
    else request.resolve(message.result)
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const requestId = ++id
      pending.set(requestId, { resolve, reject })
      ws.send(JSON.stringify({ id: requestId, method, params }))
    })
  async function evaluate(fn, ...args) {
    const result = await send('Runtime.evaluate', {
      expression: `(${fn})(${args.map((a) => JSON.stringify(a)).join(',')})`, awaitPromise: true, returnByValue: true
    })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  await send('Runtime.enable')
  // Typing goes to the focused element only while the page counts as focused.
  await send('Emulation.setFocusEmulationEnabled', { enabled: true })

  const activeBodySelector = '.tab-body:not(.hidden)'
  const activeBody = `document.querySelector('${activeBodySelector}')`
  const tabText = () => evaluate(new Function(`
    const body = ${activeBody}
    if (!body) return ''
    const visual = body.querySelector('.tab-pane:not(.hidden) .ProseMirror')
    return visual ? visual.innerText : body.querySelector('.view-lines')?.innerText.replaceAll('\u00a0', ' ') ?? ''`))
  const bannerButtons = () => evaluate(new Function(`
    const banner = ${activeBody}?.querySelector('.banner-warn')
    return banner ? [...banner.querySelectorAll('button')].map((b) => b.textContent) : null`))
  const clickBanner = (label) => evaluate((label, selector) => {
    const button = [...document.querySelectorAll(`${selector} .banner-warn button`)].find((b) => b.textContent === label)
    if (!button) throw new Error(`Missing banner button: ${label}`)
    button.click()
  }, label, activeBodySelector)
  const activateTab = (name) => evaluate((name) => {
    const tab = [...document.querySelectorAll('.tab')].find((t) => t.querySelector('.tab-title').textContent === name)
    if (!tab) throw new Error(`Missing tab: ${name}`)
    tab.click()
  }, name)
  const watchFailure = () => evaluate(() => {
    const toast = [...document.querySelectorAll('[data-sonner-toast]')].find((t) => t.textContent.includes('не отслеживаются'))
    return toast ? toast.textContent : null
  })
  const focusEditor = () => evaluate((selector) => document.querySelector(`${selector} .monaco-editor .native-edit-context`).focus(), activeBodySelector)
  async function ctrlKey(key, code, windowsVirtualKeyCode, modifiers = 2) {
    const params = { key, code, windowsVirtualKeyCode, modifiers }
    await send('Input.dispatchKeyEvent', { type: 'keyDown', ...params })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
  }
  const historyButtons = () => evaluate((selector) => {
    const body = document.querySelector(selector)
    return [...body.querySelectorAll('button[aria-label="Отменить"], button[aria-label="Повторить"]')].map((b) => !b.disabled)
  }, activeBodySelector)
  const clickHistory = (label) => evaluate((selector, label) => {
    const button = document.querySelector(`${selector} button[aria-label="${label}"]`)
    if (!button || button.disabled) throw new Error(`History button unavailable: ${label}`)
    button.click()
  }, activeBodySelector, label)
  const dirtyMark = () => evaluate((selector) => document.querySelector(`${selector} .breadcrumb`).textContent.includes('не сохранено'), activeBodySelector)
  async function typeAtEnd(text) {
    await focusEditor()
    await ctrlKey('End', 'End', 35)
    await send('Input.insertText', { text })
    await waitFor(async () => (await tabText()).includes(text.trim()), `typed "${text}"`)
    // The edit must be in the tab's state before the disk changes.
    await pause(300)
  }
  async function untilFollowed(file, label) {
    // The watchers start in the background: rewrite until the tab shows the file, up to 30 s.
    for (let i = 0; i < 30; i++) {
      const failure = await watchFailure()
      if (failure) throw new Error(`The app stopped watching: ${failure}`)
      await writeFile(file, `${label} ${i}\n`)
      for (let j = 0; j < 10; j++) {
        if ((await tabText()).includes(`${label} ${i}`)) return
        await pause()
      }
    }
    throw new Error(`Timed out: tab follows ${path.basename(file)}`)
  }

  await waitFor(async () => (await tabText()).includes('line one'), 'notes.txt loaded')
  assert.deepEqual(await historyButtons(), [false, false])
  await typeAtEnd(' HISTORY')
  assert.deepEqual(await historyButtons(), [true, false])
  await ctrlKey('z', 'KeyZ', 90)
  await waitFor(async () => !(await tabText()).includes('HISTORY') && !(await dirtyMark()), 'Ctrl+Z restores the saved text')
  assert.deepEqual(await historyButtons(), [false, true])
  await ctrlKey('y', 'KeyY', 89)
  await waitFor(async () => (await tabText()).includes('HISTORY') && (await dirtyMark()), 'Ctrl+Y restores the edit')
  await clickHistory('Отменить')
  await waitFor(async () => !(await dirtyMark()), 'Undo button restores the saved text')
  await ctrlKey('Z', 'KeyZ', 90, 10)
  await waitFor(async () => (await tabText()).includes('HISTORY') && (await dirtyMark()), 'Ctrl+Shift+Z restores the edit')
  await clickHistory('Отменить')
  await waitFor(async () => !(await dirtyMark()), 'notes.txt has no unsaved edits')
  console.log('PASS undo, redo, keyboard shortcuts and the unsaved indicator')
  await untilFollowed(NOTES, 'changed outside')
  assert.equal(await bannerButtons(), null, 'an unchanged tab follows the disk without a banner')
  assert.deepEqual(await historyButtons(), [false, false], 'a replaced disk version clears the previous history')
  console.log('PASS unchanged code tab in a hidden folder follows the disk')

  await activateTab('doc.md')
  await waitFor(async () => (await tabText()).includes('First paragraph'), 'doc.md loaded')
  await writeFile(DOC, '# Title\n\nRewritten outside.\n')
  await waitFor(async () => (await tabText()).includes('Rewritten outside'), 'doc.md follows the disk')
  console.log('PASS unchanged Markdown preview follows the disk')

  const previewState = () => evaluate(new Function(`
    const body = ${activeBody}
    const view = body.querySelector('.tab-pane:not(.hidden) .ProseMirror')
    return { editable: view?.getAttribute('contenteditable') ?? null, toolbar: body.querySelector('.md-toolbar') !== null }`))
  const clickMode = (title) => evaluate((title, selector) => {
    const button = document.querySelector(`${selector} .mode-toggle button[title="${title}"]`)
    if (!button) throw new Error(`Missing mode button: ${title}`)
    button.click()
  }, title, activeBodySelector)
  assert.deepEqual(await previewState(), { editable: 'false', toolbar: false }, 'the Markdown preview is read-only')
  await clickMode('Исходник')
  await waitFor(async () => (await tabText()).includes('Rewritten outside'), 'doc.md source shown')
  assert.deepEqual(await historyButtons(), [false, false], 'this tab has its own history')
  await typeAtEnd(' EDITED')
  await clickMode('Просмотр')
  await waitFor(async () => (await previewState()).editable === 'false' && (await tabText()).includes('EDITED'), 'preview shows the source edit')
  await waitFor(dirtyMark, 'unsaved mark in preview')
  console.log('PASS Markdown preview is read-only and shows unsaved source edits')

  await activateTab('page.html')
  await clickMode('Исходник')
  await waitFor(async () => (await tabText()).includes('Example'), 'HTML source shown')
  await typeAtEnd(' HTMLEDIT')
  await clickMode('Просмотр')
  await waitFor(() => evaluate((selector) => !!document.querySelector(`${selector} iframe.html-preview`), activeBodySelector), 'HTML preview shown')
  assert.deepEqual(await historyButtons(), [])
  await clickMode('Исходник')
  await clickHistory('Отменить')
  await waitFor(async () => !(await tabText()).includes('HTMLEDIT') && !(await dirtyMark()), 'HTML undo after preview')
  await clickHistory('Повторить')
  await waitFor(async () => (await tabText()).includes('HTMLEDIT') && (await dirtyMark()), 'HTML redo after preview')
  console.log('PASS HTML keeps its history through preview')

  await activateTab('doc.md')
  assert.deepEqual(await historyButtons(), [])
  await clickMode('Исходник')
  await clickHistory('Отменить')
  await waitFor(async () => !(await tabText()).includes('EDITED') && !(await dirtyMark()), 'Markdown undo after preview and tab switch')
  await clickHistory('Повторить')
  await waitFor(async () => (await tabText()).includes('EDITED') && (await dirtyMark()), 'Markdown redo after preview and tab switch')
  console.log('PASS Markdown keeps its history through preview and tab switches')

  await activateTab('notes.txt')
  await typeAtEnd(' MINE')
  await writeFile(NOTES, 'second outside change\n')
  await waitFor(async () => (await bannerButtons()) !== null, 'banner shown')
  assert.deepEqual(await bannerButtons(), ['Сохранить мою версию', 'Загрузить с диска (мои правки пропадут)', 'Сохранить как…'])
  assert.ok((await tabText()).includes('MINE'), 'the tab keeps its edits')
  assert.ok(!(await tabText()).includes('second outside'), 'the disk text is not applied')
  console.log('PASS edited tab keeps its text and offers three choices')

  await clickBanner('Сохранить мою версию')
  await waitFor(async () => (await readFile(NOTES, 'utf8')).includes('MINE'), 'my version written to disk')
  await waitFor(async () => (await bannerButtons()) === null, 'banner gone after saving')
  console.log('PASS "Сохранить мою версию" writes the tab text over the newer file')

  await typeAtEnd(' AGAIN')
  await writeFile(NOTES, 'third outside change\n')
  await waitFor(async () => (await bannerButtons()) !== null, 'banner shown again')
  await clickBanner('Загрузить с диска (мои правки пропадут)')
  await waitFor(async () => (await tabText()).includes('third outside change'), 'disk version loaded')
  assert.ok(!(await tabText()).includes('AGAIN'), 'edits dropped')
  assert.equal(await bannerButtons(), null)
  assert.deepEqual(await historyButtons(), [false, false], 'discarded edits stay out of history')
  console.log('PASS "Загрузить с диска" replaces the edits with the disk version')

  const rowClick = (file) => evaluate((file) => {
    const row = [...document.querySelectorAll('.tree-row')].find((el) => el.title === file)
    if (!row) throw new Error(`Missing row: ${file}`)
    row.click()
  }, file)
  const preview = () => evaluate(() => document.querySelector('.tab-preview')?.title.split('\n')[0] ?? null)
  await rowClick(root + '/preview.txt')
  await waitFor(async () => (await tabText()).includes('Preview tab'), 'preview.txt loaded as a preview')
  assert.equal(await preview(), root + '/preview.txt')
  await evaluate((root) => {
    const rows = [...document.querySelectorAll('.tree-row')]
    const dataTransfer = new DataTransfer()
    rows.find((el) => el.title === root + '/preview.txt').dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer }))
    rows.find((el) => el.title === root + '/destination').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }))
  }, root)
  await waitFor(() => evaluate((root) => [...document.querySelectorAll('.tab')].some((el) => el.title.split('\n')[0] === root + '/destination/preview.txt'), root), 'preview follows its move')
  assert.equal(await preview(), root + '/destination/preview.txt', 'moving a preview does not pin it')
  await rowClick(root + '/another.txt')
  await waitFor(async () => (await preview()) === root + '/another.txt', 'opening another file replaces the moved preview')
  console.log('PASS moved preview stays replaceable')

  const tabPaths = () => evaluate(() => [...document.querySelectorAll('.tab')].map((el) => el.title.split('\n')[0]))
  const dialogButton = (label) => evaluate((label) => {
    const button = [...document.querySelectorAll('.dialog button')].find((el) => el.textContent === label)
    if (!button) throw new Error(`Missing dialog button: ${label}`)
    button.click()
  }, label)
  const click = async (selector, label, button) => {
    const point = await evaluate((selector, label) => {
      const element = [...document.querySelectorAll(selector)].find((el) => el.textContent === label)
      if (!element) throw new Error(`Missing ${selector}: ${label}`)
      const { x, y, width, height } = element.getBoundingClientRect()
      return { x: x + width / 2, y: y + height / 2 }
    }, selector, label)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button, clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button, clickCount: 1 })
  }
  const openTabMenu = (name) => click('.tab-title', name, 'right')
  const clickCloseOthers = () => click('.menu-item', 'Закрыть остальные', 'left')
  const beforeClosing = await tabPaths()
  assert.equal(beforeClosing.length, 4)
  await openTabMenu('another.txt')
  if (process.env.DISCOTECH_TAB_SCREENSHOT) {
    const screenshot = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(process.env.DISCOTECH_TAB_SCREENSHOT, Buffer.from(screenshot.data, 'base64'))
  }
  await clickCloseOthers()
  await dialogButton('Отмена')
  assert.deepEqual(await tabPaths(), beforeClosing, 'cancelling leaves all tabs open')
  await openTabMenu('another.txt')
  await clickCloseOthers()
  await dialogButton('Закрыть без сохранения')
  assert.deepEqual(await tabPaths(), [root + '/another.txt'])
  assert.equal(await preview(), root + '/another.txt', 'closing others does not pin the selected preview')
  console.log('PASS Close Others asks once about unsaved changes and keeps the selected tab')

  await activateTab('another.txt')
  await rowClick(root + '/.hidden/notes.txt')
  await waitFor(async () => (await preview()) === root + '/.hidden/notes.txt', 'a second clean tab is active')
  await openTabMenu('another.txt')
  await clickCloseOthers()
  assert.deepEqual(await tabPaths(), [root + '/another.txt'])
  assert.equal(await evaluate(() => document.querySelector('.tab-active .tab-title')?.textContent), 'another.txt')
  assert.equal(await evaluate(() => document.querySelector('.dialog') !== null), false)
  console.log('PASS Close Others activates the clicked tab and closes clean tabs without a dialog')
  assert.deepEqual(exceptions, [], 'no uncaught renderer errors')
} finally {
  ws?.close()
  spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(app.pid)], { stdio: 'ignore' })
  // The app's processes let go of their data folder shortly after they exit.
  await pause(1000)
  await rm(fixture, { recursive: true, force: true })
  await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}
