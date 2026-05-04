# Contributing to Browser Use Desktop

Install these first:

- [Task](https://taskfile.dev) (`brew install go-task` on macOS)
- Node.js 22
- Yarn

From root:

```bash
git clone https://github.com/browser-use/desktop-app.git
cd desktop-app
task up
```

`task up` installs dependencies, patches the local Electron app bundle, and
starts the desktop app. 

Useful development commands:

```bash
task --list          # show available tasks
task lint            # run ESLint
task typecheck       # run tsc --noEmit
cd app && yarn test  # run unit and integration tests
task make            # build platform installers
```

Linux packages are built in Docker:

```bash
task linux:make:docker
```

## Pull requests

Great PRs are focused and easy to review:

1. Explain why the change is needed.
2. Keep the PR scoped to one bug fix, feature, or cleanup.
3. Include screenshots or a short recording for UI changes.

To get your PR reviewed faster, you can message any of the Browser Use employees on discord, twitter, or email.

## Reporting bugs

Open an issue at
[browser-use/desktop-app/issues](https://github.com/browser-use/desktop-app/issues)
with enough detail for someone else to reproduce the problem.

Good bug reports include:

- The app version / git commit.
- Your operating system.
- The provider you were using, such as Claude Code or Codex.
- Clear steps to reproduce the issue.
- What you expected to happen and what happened instead.
- Screenshots or recordings when the bug is visible.
- Relevant logs, with secrets and private URLs redacted.

Helpful log commands:

```bash
task logs:all
task logs:main
task logs:browser
task logs:renderer
task logs:engine
task logs:session SESSION_ID=<session-id>
```

By default, local logs are read from:

```text
~/Library/Application Support/Browser Use/logs
```

## Feature Reuests

Please describe both a problem + solution! Include:

- Why the current app does not solve it well / atall.
- The specific outcome you want.
- Screenshots, recordings, or example sites if they clarify the request.

If you plan to send a PR for the feature, open an issue first! and tag it in your PR. 

## Where to ask questions

[Browser Use Discord](https://discord.com/invite/fqPB2NCNKV)
[Twitter](https://x.com/browser_use)
