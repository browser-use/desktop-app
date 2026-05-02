<img width="1456" height="484" alt="desktop-app-banner" src="https://github.com/user-attachments/assets/550ca16a-5a61-4ded-92f0-a30421870223" />

# Browser Use Desktop App

> Run a team of browser agents on your Mac.

[![Download for Mac](https://img.shields.io/badge/Download_for_Mac-000000?style=for-the-badge&logo=apple&logoColor=white)](https://github.com/browser-use/desktop-app/releases/latest/download/Browser-Use-arm64.dmg)

Every AI browser tries to be both a browser *and* an agent. Keep your normal Chrome — this is just the agent half.

Ports your cookies into a fresh Chromium so agents are logged in everywhere you are, and spawns tasks from anywhere on your Mac with a keyboard shortcut.

Built on [Browser Harness](https://github.com/browser-use/browser-harness).

<img width="3542" height="2298" alt="CleanShot 2026-05-01 at 12 18 27@2x" src="https://github.com/user-attachments/assets/edd4f6e0-0efe-4b16-b772-b73d5a1a6d23" />

## Download

**macOS (Apple Silicon):** [Browser-Use-arm64.dmg](https://github.com/browser-use/desktop-app/releases/latest/download/Browser-Use-arm64.dmg)

**Linux:** [Browser-Use-x64.AppImage](https://github.com/browser-use/desktop-app/releases/latest/download/Browser-Use-x64.AppImage) supports in-app auto-updates. `.deb` and `.rpm` packages are also published on GitHub Releases for manual installs.

The link always points to the latest release.

## Providers

- **Anthropic** - Claude Code Subscription or API Key
- **Codex** - ChatGPT Subscription or API Key

## Channels 

Inbound message channels can trigger agent sessions automatically. 

- **WhatsApp** — text yourself with `@BU` to send and receive agent messages

## Development

Requires [Task](https://taskfile.dev) (`brew install go-task`).

```bash
task up    # Install deps and start the app
```

Linux packages are built in Docker so local distro tools do not affect the output:

```bash
task linux:make:docker
```

## License

MIT
