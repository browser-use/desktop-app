# Chrome Profile Import — Implementation Plan

## Goal
Add an onboarding step that imports cookies + bookmarks from the user's local Chrome installation so they're immediately logged into all their sites.

## Onboarding Flow
`welcome → chrome-import → account → complete`

Chrome import comes before Google OAuth since imported cookies may already contain Google session tokens.

## Architecture

### 1. ChromeProfileReader (main process)
**File:** `src/main/chrome-import/ChromeProfileReader.ts`

- Detect Chrome profiles at `~/Library/Application Support/Google/Chrome/`
- List available profiles (Default, Profile 1, Profile 2, etc.)
- Read `Local State` JSON for profile names/avatars
- Return profile list to renderer for selection

### 2. ChromeCookieImporter (main process)
**File:** `src/main/chrome-import/ChromeCookieImporter.ts`

- Read Chrome's `Cookies` SQLite DB (read-only, copy first to avoid lock)
- Decrypt cookie values using Chrome Safe Storage key from macOS Keychain
- Chrome encryption: AES-128-CBC with PBKDF2-derived key from Keychain password
- Insert decrypted cookies into Electron session via `session.defaultSession.cookies.set()`

### 3. ChromeBookmarkImporter (main process)
**File:** `src/main/chrome-import/ChromeBookmarkImporter.ts`

- Read Chrome's `Bookmarks` JSON file (plain text, no encryption)
- Transform Chrome bookmark tree → app's BookmarkNode format
- Merge into existing BookmarkStore

### 4. IPC Channels
- `chrome-import:list-profiles` → returns detected Chrome profiles
- `chrome-import:run` → imports cookies + bookmarks for selected profile
- `chrome-import:progress` → sends progress updates to renderer

### 5. Onboarding Step Component
**File:** `src/renderer/onboarding/ChromeImport.tsx`

- Shows detected Chrome profiles with names/avatars
- User picks which profile to import
- Progress indicator during import
- Skip option ("I'll start fresh")

### 6. Dependencies
- `better-sqlite3` — read Chrome's SQLite cookie DB
- `keytar` (already installed) — read Chrome Safe Storage key from Keychain

## Cookie Decryption (macOS)
1. Read encryption key: `keytar.getPassword('Chrome Safe Storage', 'Chrome')`
2. Derive AES key: PBKDF2(password, salt='saltysalt', iterations=1003, keylen=16, digest='sha1')
3. For each cookie: AES-128-CBC decrypt with IV = 16 bytes of space (0x20)
4. Strip PKCS7 padding

## Data Flow
```
Chrome Profile Dir → copy Cookies DB → SQLite read → decrypt values → session.cookies.set()
Chrome Profile Dir → read Bookmarks JSON → transform → BookmarkStore.importChromeBookmarks()
```
