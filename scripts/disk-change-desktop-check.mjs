// Checks disk changes and edit history in a disposable instance of the app.
// Run with Windows Node. Pass a Windows path to a separate build, or use the build from scripts/run-win.sh:
//   node \\wsl.localhost\<distro>\<repo>\scripts\disk-change-desktop-check.mjs <distro> [port] [app-dir]
// The script writes a throwaway project into the distro's /tmp, starts electron.exe from
// %DISCOTECH_WIN_DIR% (default %USERPROFILE%\discotech-dev) with its own --user-data-dir and the
// DevTools port (default 9334), and removes the copy, its data and the project at the end.
// Set DISCOTECH_TAB_SCREENSHOT to a Windows path to capture the tab context menu.
// Set DISCOTECH_GIT_SCREENSHOT to a Windows path to capture the inline diff and worktree list.
// The "Сохранить как…" button opens the native Windows dialog, which DevTools cannot drive: check it by hand.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
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
const nativeRoot = path.join(userData, 'native repo')
await mkdir(nativeRoot)
await mkdir(path.join(fixture, '.hidden'))
await mkdir(path.join(fixture, '.hidden', 'unwatched'))
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
await writeFile(path.join(userData, 'settings.json'), JSON.stringify({ projects: [
  { id: 'check', name: 'check', distro, rootPath: root },
  { id: 'native', name: 'Native Git', distro: null, rootPath: nativeRoot.replaceAll('\\', '/') }
] }))
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

  // Open files make .hidden itself watched, but its child directory is still unwatched.
  const unwatched = root + '/.hidden/unwatched'
  const hasTreeRow = (file) => evaluate((file) => [...document.querySelectorAll('.tree-row')].some((el) => el.title === file), file)
  await rowClick(unwatched)
  await writeFile(path.join(fixture, '.hidden', 'unwatched', 'button.txt'), 'Found by the toolbar\n')
  assert.equal(await hasTreeRow(unwatched + '/button.txt'), false)
  await evaluate(() => document.querySelector('button[title="Обновить дерево (F5)"]').click())
  await waitFor(() => hasTreeRow(unwatched + '/button.txt'), 'the refresh button reloads the expanded directory')

  await writeFile(path.join(fixture, '.hidden', 'unwatched', 'f5.txt'), 'Found by F5\n')
  assert.equal(await hasTreeRow(unwatched + '/f5.txt'), false)
  await focusEditor()
  const timeOrigin = await evaluate(() => performance.timeOrigin)
  await ctrlKey('F5', 'F5', 116, 0)
  await waitFor(() => hasTreeRow(unwatched + '/f5.txt'), 'F5 reloads the expanded directory')
  assert.equal(await evaluate(() => performance.timeOrigin), timeOrigin, 'F5 does not reload the app')
  console.log('PASS tree refresh button and F5 pick up files outside the watcher and keep folders expanded')

  const gitStatusText = () => evaluate(() => document.querySelector('.status-git')?.textContent.trim() ?? null)
  const buttonText = (selector, label) => evaluate((selector, label) => {
    const control = [...document.querySelectorAll(selector)].find((el) => el.textContent.trim() === label)
    if (!control || control.disabled) throw new Error(`Unavailable button: ${label}`)
    control.click()
  }, selector, label)
  const git = (directory, ...args) => {
    const command = directory.startsWith('/') ? 'wsl.exe' : 'git.exe'
    const argv = directory.startsWith('/') ? ['-d', distro, '--exec', 'git'] : []
    const result = spawnSync(command, [...argv, '-C', directory, ...args], { encoding: 'utf8', windowsHide: true })
    assert.ifError(result.error)
    assert.equal(result.status, 0, result.stderr)
    return result.stdout
  }
  const stageInitialFile = async (directory, ioPath) => {
    git(directory, 'init', '-b', 'main')
    await writeFile(path.join(ioPath, 'counter.txt'), 'same\nold\n')
    git(directory, 'add', 'counter.txt')
  }
  const commitBase = (directory) => git(directory, '-c', 'user.name=Discotech Check', '-c', 'user.email=check@example.invalid', 'commit', '-m', 'Base')
  const waitGit = (label) => waitFor(async () => (await gitStatusText()) === label, `Git status shows ${label}`)
  const removeSelected = () => evaluate(() => document.querySelector('[aria-label="Удалить выбранную рабочую копию"]').click())
  const selectWorktree = (branch) => evaluate((branch) => {
    const row = [...document.querySelectorAll('.worktree-row')].find((el) => el.querySelector('strong').textContent === branch)
    if (!row || row.disabled) throw new Error(`Unavailable worktree: ${branch}`)
    row.click()
  }, branch)
  const toggleWorktree = (branch) => evaluate((branch) => {
    const row = [...document.querySelectorAll('.worktree-heading')].find((el) => el.querySelector('strong').textContent === branch)
    const disclosure = row?.querySelector('.worktree-disclosure')
    if (!disclosure || disclosure.disabled) throw new Error(`Cannot expand or collapse worktree: ${branch}`)
    disclosure.click()
  }, branch)
  const changedFileNames = () => evaluate(() => [...document.querySelectorAll('.worktree-change-name')].map((el) => el.textContent))
  const openChangedFile = (name) => evaluate((name) => {
    const item = [...document.querySelectorAll('.worktree-change')].find((el) => el.title === name)
    if (!item) throw new Error(`Missing changed file: ${name}`)
    item.click()
  }, name)
  const tabNames = (selector = '.tab-title') => evaluate((selector) => [...document.querySelectorAll(selector)].map((el) => el.textContent), selector)
  const previewTabNames = () => tabNames('.tab-preview .tab-title')
  const diffView = () => evaluate(() => {
    const view = document.querySelector('.git-diff-view:not(.hidden)')
    const editor = view?.querySelector('.monaco-diff-editor, .monaco-editor')
    return {
      title: view?.querySelector('.breadcrumb-path').textContent,
      message: view?.querySelector('.empty')?.textContent,
      text: editor?.innerText.replaceAll('\u00a0', ' '),
      removed: editor?.querySelectorAll('.line-delete').length,
      added: editor?.querySelectorAll('.line-insert').length
    }
  })
  const waitDiff = async (deleted, added) => {
    let view
    try {
      await waitFor(async () => {
        view = await diffView()
        return view.text !== undefined &&
          (deleted === null ? view.removed === 0 : view.removed > 0 && view.text.includes(deleted)) &&
          (added === null ? view.added === 0 : view.added > 0 && view.text.includes(added))
      }, `inline diff shows removed "${deleted}" and added "${added}"`)
    } catch (error) {
      throw new Error(`${error.message}. Diff view: ${JSON.stringify(view)}`, { cause: error })
    }
  }

  assert.equal(await gitStatusText(), null, 'plain folder has no Git status')
  await stageInitialFile(root, fixture)
  commitBase(root)
  await writeFile(path.join(fixture, 'counter.txt'), 'same\nnew\n')
  git(root, 'add', 'counter.txt')
  await writeFile(path.join(fixture, 'counter.txt'), 'same\nnew\nextra\n')
  await waitGit('main (-1:+2)')
  git(root, 'worktree', 'add', '-b', 'feat/clean', root + '/Копия чистая')
  git(root, 'worktree', 'add', '-b', 'feat/dirty', root + '/dirty')
  git(root, 'worktree', 'lock', root + '/dirty')
  await waitFor(() => evaluate(() => !!document.querySelector('.sidebar-views')), 'working copies section appears')
  await buttonText('.sidebar-views button', 'Рабочие копии')
  await selectWorktree('feat/dirty')
  await waitGit('feat/dirty (-0:+0)')
  assert.equal(await evaluate(() => document.querySelector('[aria-label="Удалить выбранную рабочую копию"]').disabled), true)
  git(root, 'worktree', 'unlock', root + '/dirty')
  const changedCounter = path.join(fixture, 'dirty', 'counter.txt')
  await writeFile(changedCounter, 'same\ncopy edit\n')
  await waitGit('feat/dirty (-1:+1)')
  await writeFile(path.join(fixture, 'dirty', 'new file.txt'), 'Not yet added\n')
  await toggleWorktree('feat/dirty')
  await waitFor(async () => (await changedFileNames()).join(',') === 'counter.txt,new file.txt', 'expanded worktree lists tracked and untracked files')
  await openChangedFile('counter.txt')
  await waitDiff('old', 'copy edit')
  assert.deepEqual(await previewTabNames(), ['counter.txt'])
  await openChangedFile('new file.txt')
  await waitDiff(null, 'Not yet added')
  assert.deepEqual(await tabNames(), ['another.txt', 'new file.txt'], 'a new comparison replaces the unpinned comparison')
  await openChangedFile('new file.txt')
  await waitDiff(null, 'Not yet added')
  assert.deepEqual(await previewTabNames(), ['new file.txt'], 'reopening from the worktree keeps a comparison temporary')
  await openChangedFile('counter.txt')
  await waitDiff('old', 'copy edit')
  await click('.tab-title', 'counter.txt', 'left')
  await openChangedFile('new file.txt')
  await waitDiff(null, 'Not yet added')
  assert.deepEqual(await tabNames(), ['another.txt', 'counter.txt', 'new file.txt'])
  await evaluate(() => document.querySelector('.tab-diff:not(.tab-preview) .tab-pin').click())
  assert.deepEqual(await tabNames(), ['another.txt', 'counter.txt'], 'unpinning a comparison replaces the existing preview')
  assert.deepEqual(await previewTabNames(), ['counter.txt'])
  await click('.tab-title', 'counter.txt', 'left')
  await openChangedFile('new file.txt')
  await waitDiff(null, 'Not yet added')
  await click('.tab-title', 'another.txt', 'left')
  await waitFor(async () => (await tabText()).includes('Another file'), 'ordinary editor tab is available with two comparisons open')
  await click('.tab-title', 'counter.txt', 'left')
  await waitDiff('old', 'copy edit')
  if (process.env.DISCOTECH_GIT_SCREENSHOT) {
    const screenshot = await send('Page.captureScreenshot', { format: 'png' })
    await writeFile(process.env.DISCOTECH_GIT_SCREENSHOT, Buffer.from(screenshot.data, 'base64'))
  }
  await rm(changedCounter)
  await waitFor(() => evaluate(() => [...document.querySelectorAll('.worktree-change')].some((el) => el.title === 'counter.txt' && el.querySelector('.worktree-change-code').textContent === 'D')), 'deleted file appears in the list')
  await openChangedFile('counter.txt')
  await waitDiff('old', null)
  assert.deepEqual(await tabNames(), ['another.txt', 'counter.txt', 'new file.txt'], 'reopening a comparison keeps the same tab')
  assert.deepEqual(await previewTabNames(), ['new file.txt'], 'reopening a pinned comparison keeps it pinned')
  await evaluate(() => document.querySelector('.tab-active.tab-diff .tab-close').click())
  await waitDiff(null, 'Not yet added')
  assert.deepEqual(await tabNames(), ['another.txt', 'new file.txt'], 'closing one diff keeps neighboring tabs')
  await click('.tab-title', 'another.txt', 'left')
  await typeAtEnd(' DRAFT')
  await openTabMenu('new file.txt')
  await clickCloseOthers()
  await dialogButton('Отмена')
  assert.deepEqual(await tabNames(), ['another.txt', 'new file.txt'], 'cancelling Close Others preserves the edited file and comparison')
  await openTabMenu('new file.txt')
  await clickCloseOthers()
  await dialogButton('Закрыть без сохранения')
  assert.deepEqual(await tabNames(), ['new file.txt'], 'Close Others keeps the selected comparison')
  await waitDiff(null, 'Not yet added')
  await writeFile(changedCounter, 'same\ncopy edit\n')
  console.log('PASS comparison tabs share the preview slot and support pinning, unpinning, closing and protecting unsaved edits')
  await toggleWorktree('feat/dirty')
  assert.deepEqual(await changedFileNames(), [])
  assert.equal(await evaluate(() => document.querySelector('[aria-label="Удалить выбранную рабочую копию"]').disabled), false)
  await removeSelected()
  await dialogButton('Удалить копию')
  await waitFor(() => evaluate(() => [...document.querySelectorAll('[data-sonner-toast]')].some((el) => el.textContent.includes('Не удалось удалить рабочую копию'))), 'Git refusal is shown')
  assert.equal(await readFile(changedCounter, 'utf8'), 'same\ncopy edit\n')

  await selectWorktree('feat/clean')
  await waitGit('feat/clean (-0:+0)')
  await toggleWorktree('feat/clean')
  await waitFor(() => evaluate(() => document.querySelector('.worktree-changes')?.textContent === 'Изменённых файлов нет'), 'clean worktree has no changed files')
  await removeSelected()
  await waitFor(() => evaluate(() => document.querySelector('.dialog')?.textContent.includes('Копия чистая (feat/clean)')), 'confirmation identifies the copy')
  await dialogButton('Отмена')
  assert.ok((await stat(path.join(fixture, 'Копия чистая'))).isDirectory())
  await removeSelected()
  await dialogButton('Удалить копию')
  await waitFor(() => evaluate(() => ![...document.querySelectorAll('.worktree-row strong')].some((el) => el.textContent === 'feat/clean')), 'removed copy disappears from the list')
  await assert.rejects(stat(path.join(fixture, 'Копия чистая')), { code: 'ENOENT' })
  git(root, 'show-ref', '--verify', 'refs/heads/feat/clean')
  await selectWorktree('feat/dirty')
  await waitGit('feat/dirty (-1:+1)')
  await buttonText('.sidebar-views button', 'Файлы')
  await waitGit('main (-1:+2)')
  await rowClick(root + '/another.txt')
  await waitFor(async () => (await tabText()).includes('Another file'), 'opening a file replaces a temporary comparison')
  assert.deepEqual(await tabNames(), ['another.txt'])
  await buttonText('.sidebar-views button', 'Рабочие копии')
  await toggleWorktree('feat/dirty')
  await waitFor(async () => (await changedFileNames()).includes('new file.txt'), 'working copy files reload')
  await openChangedFile('new file.txt')
  await waitDiff(null, 'Not yet added')
  assert.deepEqual(await tabNames(), ['new file.txt'], 'opening a comparison replaces a temporary file')
  console.log('PASS WSL Git branch and line counts, worktree selection, locked and dirty guards, cancellation and clean removal')

  await stageInitialFile(nativeRoot, nativeRoot)
  await evaluate(() => {
    const select = document.querySelector('.project-select')
    select.value = 'native'
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await waitGit('main (-0:+2)')
  commitBase(nativeRoot)
  const nativeLinked = path.join(userData, 'Windows linked copy')
  git(nativeRoot, 'worktree', 'add', '-b', 'feat/native', nativeLinked)
  await waitGit('main (-0:+0)')
  await buttonText('.sidebar-views button', 'Рабочие копии')
  await selectWorktree('feat/native')
  await waitGit('feat/native (-0:+0)')
  const nativeOriginal = await readFile(path.join(nativeLinked, 'counter.txt'))
  git(nativeLinked, 'mv', 'counter.txt', 'renamed file.txt')
  await writeFile(path.join(nativeLinked, 'renamed file.txt'), 'same\nrenamed edit\n')
  await toggleWorktree('feat/native')
  await waitFor(async () => (await changedFileNames())[0] === 'counter.txt → renamed file.txt', 'expanded Windows worktree shows both names of a rename')
  await openChangedFile('counter.txt → renamed file.txt')
  await waitDiff('old', 'renamed edit')
  assert.equal((await diffView()).title, 'counter.txt → renamed file.txt')
  await writeFile(path.join(nativeLinked, 'renamed file.txt'), nativeOriginal)
  git(nativeLinked, 'mv', 'renamed file.txt', 'counter.txt')
  await waitFor(() => evaluate(() => document.querySelector('.worktree-changes')?.textContent === 'Изменённых файлов нет'), 'change list refreshes after the rename is undone')
  await removeSelected()
  await dialogButton('Удалить копию')
  await waitFor(() => evaluate(() => document.querySelector('.worktree-list').textContent.includes('Рабочих копий нет')), 'last Windows copy disappears')
  await assert.rejects(stat(nativeLinked), { code: 'ENOENT' })
  console.log('PASS native Windows repository and linked worktree removal')
  assert.deepEqual(exceptions, [], 'no uncaught renderer errors')
} finally {
  ws?.close()
  spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(app.pid)], { stdio: 'ignore' })
  // The app's processes let go of their data folder shortly after they exit.
  await pause(1000)
  await rm(fixture, { recursive: true, force: true })
  await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}
