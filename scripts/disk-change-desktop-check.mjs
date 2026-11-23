// Checks how open tabs follow file changes made outside the app, in a disposable copy of the app.
// Run with Windows Node after scripts/run-win.sh has built the app into the Windows working folder:
//   node \\wsl.localhost\<distro>\<repo>\scripts\disk-change-desktop-check.mjs <distro> [port]
// The script writes a throwaway project into the distro's /tmp, starts electron.exe from
// %DISCOTECH_WIN_DIR% (default %USERPROFILE%\discotech-dev) with its own --user-data-dir and the
// DevTools port (default 9334), and removes the copy, its data and the project at the end.
// The "Сохранить как…" button opens the native Windows dialog, which DevTools cannot drive: check it by hand.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const [distro, portArg = '9334'] = process.argv.slice(2)
if (!distro || !/^\d+$/.test(portArg)) {
  console.error('Usage: node disk-change-desktop-check.mjs <WSL distro> [DevTools port, default 9334]. Nothing was started.')
  process.exit(2)
}
const port = Number(portArg)
const winDir = process.env.DISCOTECH_WIN_DIR ?? path.join(process.env.USERPROFILE ?? '', 'discotech-dev')
const electronExe = path.join(winDir, 'node_modules', 'electron', 'dist', 'electron.exe')
const appDir = path.join(winDir, 'app')
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
const NOTES = path.join(fixture, '.hidden', 'notes.txt')
const DOC = path.join(fixture, '.hidden', 'doc.md')
await writeFile(NOTES, 'line one\n')
await writeFile(DOC, '# Title\n\nFirst paragraph.\n')
// Both files sit in a hidden folder, which the project watchers skip: only open tabs are watched there.
await writeFile(path.join(userData, 'settings.json'), JSON.stringify({ projects: [{ id: 'check', name: 'check', distro, rootPath: root }] }))
await writeFile(
  path.join(userData, 'session.json'),
  JSON.stringify({
    activeProjectId: 'check',
    projects: { check: { tabs: [{ path: `${root}/.hidden/notes.txt`, pinned: true }, { path: `${root}/.hidden/doc.md`, pinned: true }], active: `${root}/.hidden/notes.txt` } }
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

  const activeBody = `[...document.querySelectorAll('.tab-body')].find((el) => !el.classList.contains('hidden'))`
  const tabText = () => evaluate(new Function(`
    const body = ${activeBody}
    if (!body) return ''
    const visual = body.querySelector('.tab-pane:not(.hidden) .ProseMirror')
    return visual ? visual.innerText : body.querySelector('.view-lines')?.innerText.replaceAll('\u00a0', ' ') ?? ''`))
  const bannerButtons = () => evaluate(new Function(`
    const banner = ${activeBody}?.querySelector('.banner-warn')
    return banner ? [...banner.querySelectorAll('button')].map((b) => b.textContent) : null`))
  const clickBanner = (label) => evaluate((label, find) => {
    const body = eval(find)
    const button = [...body.querySelectorAll('.banner-warn button')].find((b) => b.textContent === label)
    if (!button) throw new Error(`Missing banner button: ${label}`)
    button.click()
  }, label, activeBody)
  const activateTab = (name) => evaluate((name) => {
    const tab = [...document.querySelectorAll('.tab')].find((t) => t.querySelector('.tab-title').textContent === name)
    if (!tab) throw new Error(`Missing tab: ${name}`)
    tab.click()
  }, name)
  const watchFailure = () => evaluate(() => {
    const toast = [...document.querySelectorAll('[data-sonner-toast]')].find((t) => t.textContent.includes('не отслеживаются'))
    return toast ? toast.textContent : null
  })
  async function typeAtEnd(text) {
    await evaluate((find) => eval(find).querySelector('.monaco-editor .native-edit-context').focus(), activeBody)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: 2 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'End', code: 'End', windowsVirtualKeyCode: 35, modifiers: 2 })
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
  await untilFollowed(NOTES, 'changed outside')
  assert.equal(await bannerButtons(), null, 'an unchanged tab follows the disk without a banner')
  console.log('PASS unchanged code tab in a hidden folder follows the disk')

  await activateTab('doc.md')
  await waitFor(async () => (await tabText()).includes('First paragraph'), 'doc.md loaded')
  await writeFile(DOC, '# Title\n\nRewritten outside.\n')
  await waitFor(async () => (await tabText()).includes('Rewritten outside'), 'doc.md follows the disk')
  console.log('PASS unchanged visual Markdown tab follows the disk')

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
  console.log('PASS "Загрузить с диска" replaces the edits with the disk version')
  assert.deepEqual(exceptions, [], 'no uncaught renderer errors')
} finally {
  ws?.close()
  spawnSync('taskkill.exe', ['/F', '/T', '/PID', String(app.pid)], { stdio: 'ignore' })
  // The app's processes let go of their data folder shortly after they exit.
  await pause(1000)
  await rm(fixture, { recursive: true, force: true })
  await rm(userData, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
}
