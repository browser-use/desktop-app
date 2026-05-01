# Browser Use Desktop

<img width="1456" height="484" alt="desktop-app-banner" src="https://github.com/user-attachments/assets/550ca16a-5a61-4ded-92f0-a30421870223" />

## A desktop app for running browser agents 

Running automations on local Chrome interferes with daily work and requires permissions every time. 

Browser Use Desktop allows you to port your cookies into a new Chromium environment and spawn tasks from anywhere on your computer with a keyboard shortcut. 

We use [Browser Use Harnessless](https://github.com/browser-use/browser-harness) as the agent framework.

## Download

**macOS (Apple Silicon):** [Browser-Use-arm64.dmg](https://github.com/browser-use/desktop-app/releases/latest/download/Browser-Use-arm64.dmg)

The link always points to the latest release. 

<img width="3542" height="2298" alt="CleanShot 2026-05-01 at 12 18 27@2x" src="https://github.com/user-attachments/assets/edd4f6e0-0efe-4b16-b772-b73d5a1a6d23" />

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

## License

MIT
