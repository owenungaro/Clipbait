#!/usr/bin/env bash
# Copy the packaged build over the installed app.
#
# Two things make this fiddly from WSL:
#  - a running Clipbait holds its own exe and DLLs open, so it must be stopped
#  - this shell exports ELECTRON_RUN_AS_NODE, and WSLENV forwards it to Windows,
#    which would make any Electron binary launched from here run as bare Node
set -euo pipefail

# Override with CLIPBAIT_DEST to install somewhere else.
WIN_USER="${WIN_USER:-$(cmd.exe /c 'echo %USERNAME%' 2>/dev/null | tr -d '\r\n')}"
DEST="${CLIPBAIT_DEST:-/mnt/c/Users/${WIN_USER}/AppData/Local/Programs/Clipbait}"

run_ps() {
  env -u ELECTRON_RUN_AS_NODE WSLENV="" powershell.exe -NoProfile -Command "$1"
}

echo "Stopping Clipbait if it is running…"
# Windows releases the file handles a moment after the process dies, so wait
# for them to actually go rather than guessing at a sleep.
run_ps "
  Get-Process -Name Clipbait -ErrorAction SilentlyContinue | Stop-Process -Force
  for (\$i = 0; \$i -lt 40; \$i++) {
    if (-not (Get-Process -Name Clipbait -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 250
  }
  Start-Sleep -Milliseconds 750
" >/dev/null 2>&1 || true

# Overwriting a large exe in place fails on DrvFs even when nothing holds it,
# so replace the contents instead. Guarded so a bad DEST cannot delete anything
# that is not an existing Clipbait install.
if [ -e "$DEST" ]; then
  case "$DEST" in
    /|/mnt/c|/mnt/c/|/home|"$HOME")
      echo "Refusing to clear $DEST" >&2
      exit 1
      ;;
  esac
  if [ ! -e "$DEST/Clipbait.exe" ]; then
    echo "Refusing to clear $DEST — it does not look like a Clipbait install" >&2
    exit 1
  fi
  rm -rf "${DEST:?}"
fi

mkdir -p "$DEST"
cp -r release/win-unpacked/. "$DEST/"
echo "Deployed to $DEST"

if [ "${1:-}" = "--launch" ]; then
  run_ps "Start-Process -FilePath '$(wslpath -w "$DEST")\\Clipbait.exe'" >/dev/null 2>&1
  echo "Launched."
fi
