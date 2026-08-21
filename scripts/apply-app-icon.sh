#!/usr/bin/env zsh
# Compile src-tauri/icons/Spike.icon and inject it into a built Spike.app so the
# Dock icon follows light/dark appearance.
#
#   zsh scripts/apply-app-icon.sh [path/to/Spike.app]
#
# Tauri only knows how to ship a static .icns, which never adapts. macOS 26
# picks an appearance-aware icon from an Assets.car referenced by
# CFBundleIconName, so that has to be compiled and dropped in after the bundle
# is built.
#
# MUST run before codesign. It edits Info.plist and adds files to Resources/,
# which invalidates any signature already applied.
#
# actool only accepts the .icon bundle as a DIRECT argument. Nesting it inside
# an .xcassets makes actool exit 0 having produced nothing at all.

set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

APP="${1:-src-tauri/target/release/bundle/macos/Spike.app}"
ICON="src-tauri/icons/Spike.icon"

if [[ ! -d "$APP" ]]; then
  echo "ERROR: no app bundle at $APP" >&2
  exit 1
fi
if [[ ! -d "$ICON" ]]; then
  echo "ERROR: $ICON missing — run: python3 scripts/gen-app-icon.py" >&2
  exit 1
fi

BUILD=$(mktemp -d)
trap 'rm -rf "$BUILD"' EXIT

echo ">> Compiling $ICON"
xcrun actool "$ICON" \
  --compile "$BUILD" \
  --app-icon Spike \
  --platform macosx \
  --minimum-deployment-target 26.0 \
  --output-partial-info-plist "$BUILD/icon.plist" \
  --errors --warnings >/dev/null

# actool reports nothing on failure, so check for the artefact itself.
if [[ ! -f "$BUILD/Assets.car" ]]; then
  echo "ERROR: actool produced no Assets.car — check $ICON/icon.json" >&2
  exit 1
fi

echo ">> Installing icon into $APP"
cp "$BUILD/Assets.car" "$APP/Contents/Resources/Assets.car"
# Spike.icns is the fallback for macOS versions that ignore Assets.car.
cp "$BUILD/Spike.icns" "$APP/Contents/Resources/Spike.icns"

PLIST="$APP/Contents/Info.plist"
plutil -replace CFBundleIconName -string Spike "$PLIST"
plutil -replace CFBundleIconFile -string Spike "$PLIST" 2>/dev/null \
  || plutil -insert CFBundleIconFile -string Spike "$PLIST"

echo ">> Done: CFBundleIconName=Spike, appearance-aware icon installed"
