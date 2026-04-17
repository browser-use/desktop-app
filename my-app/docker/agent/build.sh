#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
OUT_DIR="$SCRIPT_DIR/dist"

echo "[agent:build] bundling hl/ → $OUT_DIR/agent-bundle.js"

mkdir -p "$OUT_DIR"

# Bundle cli.ts + all hl/ imports into one self-contained JS file.
# --platform=node so it resolves node: imports.
# --external for native modules that must come from node_modules at runtime.
npx esbuild "$PROJECT_ROOT/src/main/hl/cli.ts" \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=cjs \
  --outfile="$OUT_DIR/agent-bundle.js" \
  --external:@anthropic-ai/sdk \
  --external:ws \
  --external:electron \
  --define:process.env.NODE_ENV=\"production\"

echo "[agent:build] bundle size: $(wc -c < "$OUT_DIR/agent-bundle.js") bytes"
echo "[agent:build] building Docker image agent-task:latest"

docker build -t agent-task:latest "$SCRIPT_DIR"

echo "[agent:build] done"
