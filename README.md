# Browser Use Desktop

<img width="1456" height="484" alt="desktop-app-banner" src="https://github.com/user-attachments/assets/550ca16a-5a61-4ded-92f0-a30421870223" />

## A desktop app for running browser agents 

Running automations on your local Chrome interferes with your daily work and also requires permissions every time. 

Browser Use Desktop allows you to port your cookies into a new Chromium environment and spawn tasks from anywhere on your computer with a keyboard shortcut. 

We use [Browser Use Harnessless](https://github.com/browser-use/browser-harness) as the agent framework.

## Providers

- **Anthropic** - Claude Code Subscription or API Key
- **Codex** - ChatGPT Subscription or API Key

## Channels

Inbound message channels can trigger agent sessions automatically. 

- **WhatsApp** — text yourself to send and receive agent messages

## Development

Requires [Task](https://taskfile.dev) (`brew install go-task`).

```bash
task up    # Install deps and start the app
```

## License

MIT
