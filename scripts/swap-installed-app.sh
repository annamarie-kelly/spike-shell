#!/bin/zsh
# Swap the freshly-built Spike.app into /Applications and relaunch.
# MUST be run from Terminal.app (or any shell outside Spike) with Spike quit:
# you cannot rm -rf a running .app, and Spike's own pty dies when Spike quits.
set -euo pipefail

REPO="${SPIKE_REPO:-$HOME/dev/spike-shell}"
BUILT="$REPO/src-tauri/target/release/bundle/macos/Spike Shell.app"
DEST="/Applications/Spike Shell.app"

[[ -d "$BUILT" ]] || { print -u2 "no build at $BUILT — run: npx tauri build --bundles app"; exit 1; }

if pgrep -f "$DEST/Contents/MacOS/Spike" >/dev/null 2>&1; then
  print -u2 "Spike is still running. Quit it (Cmd-Q) and re-run this script."
  exit 1
fi

ver=$(/usr/libexec/PlistBuddy -c "Print CFBundleShortVersionString" "$BUILT/Contents/Info.plist" 2>/dev/null || echo "?")
print "installing Spike $ver -> $DEST"

# Park the old bundle rather than delete it: a Spike still running from it can
# lazily load its resources, and this way the swap also works live (mv keeps the
# running process's inode). Delete the parked copy once you've restarted.
ASIDE="$HOME/.spike/replaced-spike-$(date +%Y%m%d-%H%M%S).app"
[[ -d "$DEST" ]] && mv "$DEST" "$ASIDE" && print "old bundle parked at $ASIDE"
ditto "$BUILT" "$DEST"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

print "done. launching."
open "$DEST"
