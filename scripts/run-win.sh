#!/usr/bin/env bash
# Builds the app in WSL and launches it with a Windows Electron runtime.
# Usage: scripts/run-win.sh [extra electron args, e.g. --remote-debugging-port=9333]
set -euo pipefail

# Windows-side working folder: Electron runtime, electron-builder, build output.
WIN_USER_DIR=${DISCOTECH_WIN_DIR:-$(wslpath "$(cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r')")/discotech-dev}
ELECTRON_EXE="$WIN_USER_DIR/node_modules/electron/dist/electron.exe"

if [[ ! -f "$ELECTRON_EXE" ]]; then
  echo "error: Windows Electron runtime not found at $ELECTRON_EXE" >&2
  echo "Install it: cd $WIN_USER_DIR && cmd.exe /c \"npm i electron@45.1.0\" && cmd.exe /c \"node node_modules\\electron\\install.js\"" >&2
  exit 1
fi

cd "$(dirname "$0")/.."
npx electron-vite build
rm -rf "$WIN_USER_DIR/app"
mkdir -p "$WIN_USER_DIR/app"
cp -r out resources package.json "$WIN_USER_DIR/app/"

win_app=$(wslpath -w "$WIN_USER_DIR/app")
win_exe=$(wslpath -w "$ELECTRON_EXE")
# Close the running copy first: the app allows one instance (see src/main/index.ts). A normal close
# lets it save its stored layout; a copy with unsaved edits asks and may stay open.
# The process list is read whole before matching: with pipefail, grep -q would cut it short and fail the pipe.
electron_running() {
  local list
  list=$(tasklist.exe /FI "IMAGENAME eq electron.exe" 2>/dev/null)
  [[ $list == *electron.exe* ]]
}
if electron_running; then
  taskkill.exe /IM electron.exe >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do
    electron_running || break
    sleep 0.5
  done
  if electron_running; then
    echo "error: the running discotech did not close in 10 s (unsaved edits?). Close it and run again; the new build is in $WIN_USER_DIR/app." >&2
    exit 1
  fi
fi
args="'$win_app'"
for arg in "$@"; do args+=",'$arg'"; done
powershell.exe -NoProfile -Command "Start-Process -FilePath '$win_exe' -ArgumentList $args"
echo "launched: $win_exe $win_app $*"
