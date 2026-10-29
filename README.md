# discotech

<img src="resources/icon.png" width="96" align="right" alt="">

A lightweight Windows desktop app for working with code that lives in WSL: a file tree, an editor
and a viewer, plus your Claude and Codex usage limits in the status bar. Styled after
[Orca](https://github.com/stablyai/orca), keeping only these three parts of it.

## Features

- **Projects** — any folders inside your WSL distros (`\\wsl.localhost\...`); the last open project
  and its tabs come back after a restart.
- **File tree** — lazy, virtualized, follows symlinks (resolved inside WSL), live updates via
  `inotifywait`. Drag and drop to move, a 1.5 s hover opens a folder; copy, cut, paste and delete
  from the context menu, the toolbar or `Ctrl+C` / `Ctrl+X` / `Ctrl+V` / `Delete`. A taken name asks
  before replacing a file or merging a folder.
- **Search** — by file name or content, with ripgrep running inside WSL. Files ignored by git are
  searched too; dependency, cache and working-copy folders are skipped.
- **Editor** — Monaco for code. Markdown opens in a visual editor (Tiptap) that saves only what you
  changed and refuses to save rather than reformat the file. HTML files render in an isolated frame,
  with a source view. Preview tabs, pinned tabs, separate zoom for the tree and the editor.
- **Disk changes** — an unchanged tab follows the file on disk; a tab with edits warns and lets you
  choose; a save never overwrites a newer file without asking.
- **Usage limits** — Claude (5-hour and weekly windows) and Codex, read with the logins of the
  `claude` and `codex` CLIs in the distro's home.

## Requirements

- Windows 10/11 with WSL 2.
- In the distro: `rg` (ripgrep) and `inotifywait` (`inotify-tools`).
- For building: Node.js in WSL and Node.js on Windows.

## Development

The code is built in WSL and run by a Windows Electron runtime kept in
`%USERPROFILE%\discotech-dev` (override with `DISCOTECH_WIN_DIR`).

```bash
npm install
npm run typecheck
scripts/run-win.sh            # build, copy to the Windows side, (re)start the app
```

`scripts/run-win.sh` prints how to install the Windows Electron runtime when it is missing.

## Building and installing

```bash
scripts/package-win.sh
```

Builds the app, packs `discotech.exe` with electron-builder on the Windows side, installs it to
`%LOCALAPPDATA%\Programs\discotech` and creates Desktop and Start menu shortcuts. Close discotech
first; the script stops without changes while it is running.

`scripts/make-icon.py` redraws the icon and the sidebar logo (needs Pillow).

## License

MIT. Parts are adapted from Orca (MIT) and the UI uses the Geist font (SIL OFL 1.1); see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
