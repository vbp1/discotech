#!/usr/bin/env bash
# Builds discotech in WSL, packs it on the Windows side into a folder with discotech.exe,
# installs the folder to %LOCALAPPDATA%\Programs\discotech and creates Desktop and Start menu
# shortcuts.
# Usage: scripts/package-win.sh
set -euo pipefail

# Windows-side working folder: Electron runtime, electron-builder, build output.
WIN_USER_DIR=${DISCOTECH_WIN_DIR:-$(wslpath "$(cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r')")/discotech-dev}
BUILDER_VERSION=26.17.0
ELECTRON_VERSION=$(node -p "require('./node_modules/electron/package.json').version" 2>/dev/null || true)

cd "$(dirname "$0")/.."
if [[ -z $ELECTRON_VERSION ]]; then
  echo "error: electron is not installed in $(pwd)/node_modules; run npm install" >&2
  exit 1
fi
if [[ ! -d $WIN_USER_DIR/node_modules/electron-builder ]] ||
  [[ $(node -p "require('$WIN_USER_DIR/node_modules/electron-builder/package.json').version") != "$BUILDER_VERSION" ]]; then
  echo "error: electron-builder $BUILDER_VERSION is not installed in $WIN_USER_DIR" >&2
  echo "Install it: cd $WIN_USER_DIR && cmd.exe /c \"npm i -D electron-builder@$BUILDER_VERSION\"" >&2
  exit 1
fi

npx electron-vite build

# Staging: only the bundled code, the icon and a package.json without dependencies (all of them
# are bundled into out/).
stage=$WIN_USER_DIR/pkg
rm -rf "$stage"
mkdir -p "$stage"
cp -r out resources "$stage/"
node -e '
const p = require("./package.json")
const out = { name: p.name, productName: "discotech", version: p.version, description: p.description, main: p.main, author: "Vadim Ponomarev" }
require("fs").writeFileSync(process.argv[1], JSON.stringify(out, null, 2))
' "$stage/package.json"
cat > "$stage/electron-builder.json" <<JSON
{
  "appId": "dev.discotech.app",
  "productName": "discotech",
  "electronVersion": "$ELECTRON_VERSION",
  "directories": { "output": "../dist" },
  "files": ["out/**", "resources/**", "package.json"],
  "win": { "icon": "resources/icon.ico", "target": "dir" }
}
JSON

win_stage=$(wslpath -w "$stage")
win_builder=$(wslpath -w "$WIN_USER_DIR/node_modules/.bin/electron-builder.cmd")
rm -rf "$WIN_USER_DIR/dist"
(cd "$stage" && cmd.exe /c "$win_builder --win --x64 --dir --projectDir $win_stage --config electron-builder.json")

unpacked=$WIN_USER_DIR/dist/win-unpacked
if [[ ! -f $unpacked/discotech.exe ]]; then
  echo "error: electron-builder finished but $unpacked/discotech.exe is missing" >&2
  exit 1
fi

# Install: replace the program folder (the app must be closed) and (re)create shortcuts.
win_unpacked=$(wslpath -w "$unpacked")
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "
\$ErrorActionPreference = 'Stop'
\$target = Join-Path \$env:LOCALAPPDATA 'Programs\\discotech'
if (Get-Process discotech -ErrorAction SilentlyContinue) { throw 'discotech is running: close it and run again. Nothing was installed.' }
if (Test-Path \$target) { Remove-Item -Recurse -Force \$target }
Copy-Item -Recurse '$win_unpacked' \$target
\$exe = Join-Path \$target 'discotech.exe'
\$shell = New-Object -ComObject WScript.Shell
foreach (\$dir in @([Environment]::GetFolderPath('Desktop'), (Join-Path ([Environment]::GetFolderPath('Programs')) ''))) {
  \$link = \$shell.CreateShortcut((Join-Path \$dir 'discotech.lnk'))
  \$link.TargetPath = \$exe
  \$link.WorkingDirectory = \$target
  \$link.IconLocation = \"\$exe,0\"
  \$link.Description = 'discotech'
  \$link.Save()
}
Write-Output \"installed: \$exe\"
"
