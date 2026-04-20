#!/bin/bash
# Patches the dev-mode Electron binary's Info.plist so the dock shows
# "Browser Use" instead of "Electron".
PLIST="node_modules/electron/dist/Electron.app/Contents/Info.plist"
if [ -f "$PLIST" ]; then
  /usr/libexec/PlistBuddy -c "Set :CFBundleName 'Browser Use'" "$PLIST" 2>/dev/null
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName 'Browser Use'" "$PLIST" 2>/dev/null
fi
