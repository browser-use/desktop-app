#!/bin/bash
# Patches the dev-mode Electron binary so the dock and menu bar show
# "BrowserUse" / "Browser Use" instead of "Electron".
#
# Uses BrowserUse.app (no space) because Node's child_process.spawn
# cannot handle spaces in executable paths.

ELECTRON_DIR="node_modules/electron/dist"
OLD_APP="$ELECTRON_DIR/Electron.app"
NEW_APP="$ELECTRON_DIR/BrowserUse.app"
PATH_FILE="node_modules/electron/path.txt"

# 1. Rename Electron.app -> BrowserUse.app (fixes Dock tooltip)
if [ -d "$OLD_APP" ] && [ ! -d "$NEW_APP" ]; then
  mv "$OLD_APP" "$NEW_APP"
fi

# 2. Patch Info.plist (fixes menu bar name to "Browser Use")
PLIST="$NEW_APP/Contents/Info.plist"
if [ -f "$PLIST" ]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleName 'Browser Use'" "$PLIST" 2>/dev/null
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName 'Browser Use'" "$PLIST" 2>/dev/null
fi

# 3. Update path.txt (NO trailing newline)
if [ -f "$PATH_FILE" ]; then
  printf "BrowserUse.app/Contents/MacOS/Electron" > "$PATH_FILE"
fi
