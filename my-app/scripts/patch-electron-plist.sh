#!/bin/bash
# Patches the dev-mode Electron binary so the dock and menu bar show
# "Browser Use" instead of "Electron".
#
# macOS derives the Dock label from the .app folder name, so we rename
# Electron.app -> "Browser Use.app" and update path.txt so electron-forge
# can still find the binary. The plist CFBundleName must match the folder
# name or macOS hides the dock icon.

ELECTRON_DIR="node_modules/electron/dist"
OLD_APP="$ELECTRON_DIR/Electron.app"
NEW_APP="$ELECTRON_DIR/Browser Use.app"
PATH_FILE="node_modules/electron/path.txt"

# 1. Rename Electron.app -> "Browser Use.app" (fixes Dock tooltip)
if [ -d "$OLD_APP" ] && [ ! -d "$NEW_APP" ]; then
  mv "$OLD_APP" "$NEW_APP"
fi

# 2. Patch Info.plist (fixes menu bar name)
PLIST="$NEW_APP/Contents/Info.plist"
if [ -f "$PLIST" ]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleName 'Browser Use'" "$PLIST" 2>/dev/null
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName 'Browser Use'" "$PLIST" 2>/dev/null
fi

# 3. Update path.txt (NO trailing newline — Node's spawn fails otherwise)
if [ -f "$PATH_FILE" ]; then
  printf "Browser Use.app/Contents/MacOS/Electron" > "$PATH_FILE"
fi
