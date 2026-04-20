import { query } from '@anthropic-ai/claude-agent-sdk';
import type { WebContents } from 'electron';
import { mainLogger } from '../logger';
import { getAnnouncedCdpPort } from '../startup/cli';
import { getHarnessDir, ensureHarness } from './harness';
import type { HlEvent } from './agent';

export async function getCdpWsUrl(webContents: WebContents): Promise<string> {
  const port = getAnnouncedCdpPort();
  const pid = webContents.getOSProcessId();
  const resp = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = (await resp.json()) as Array<{ id: string; webSocketDebuggerUrl: string; type: string }>;
  const target = targets.find((t) => t.type === 'page') ?? targets[0];
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(`No CDP target found on port ${port} for pid ${pid}`);
  }
  mainLogger.info('agentSdk.getCdpWsUrl', { port, pid, targetId: target.id });
  return target.webSocketDebuggerUrl;
}

export interface RunAgentSdkOptions {
  prompt: string;
  apiKey: string;
  cdpWsUrl: string;
  sessionName: string;
  signal?: AbortSignal;
  onEvent: (e: HlEvent) => void;
  model?: string;
  resumeSessionId?: string;
}

const SYSTEM_APPEND = `You have a browser connected via CDP. Use the browser-harness CLI to interact with it:

\`\`\`bash
browser-harness <<'PY'
# Python code here — helpers are pre-imported
new_tab("https://example.com")
wait_for_load()
print(page_info())
PY
\`\`\`

Key rules:
- First navigation: new_tab(url), not goto(url) — goto clobbers the user's active tab.
- After goto: call wait_for_load().
- screenshot() to see the page. Use js() + getBoundingClientRect() for accurate click coords.
- Search domain-skills/ before inventing approaches for a site.
- If you learn something non-obvious about a site, write it to domain-skills/<site>/<topic>.md.
- Auth wall: stop and tell the user. Don't type credentials.
- Be concise. Act, don't narrate.`;

function parseContentBlocks(content: unknown[]): { text: string[]; toolUses: Array<{ id: string; name: string; input: unknown }> } {
  const text: string[] = [];
  const toolUses: Array<{ id: string; name: string; input: unknown }> = [];
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') {
      text.push(b.text);
    } else if (b.type === 'thinking' && typeof b.thinking === 'string') {
      text.push(b.thinking);
    } else if (b.type === 'tool_use') {
      toolUses.push({ id: b.id as string, name: b.name as string, input: b.input });
    }
  }
  return { text, toolUses };
}

function parseToolResults(content: unknown[]): Array<{ toolUseId: string; content: string; isError: boolean }> {
  const results: Array<{ toolUseId: string; content: string; isError: boolean }> = [];
  for (const block of content) {
    const b = block as Record<string, unknown>;
    if (b.type === 'tool_result') {
      results.push({
        toolUseId: b.tool_use_id as string,
        content: String(b.content ?? ''),
        isError: !!(b.is_error),
      });
    }
  }
  return results;
}

export async function runAgentSdk(opts: RunAgentSdkOptions): Promise<string | undefined> {
  const { prompt, apiKey, cdpWsUrl, sessionName, signal, onEvent, model } = opts;

  const harnessDir = ensureHarness();
  mainLogger.info('agentSdk.run', {
    sessionName,
    promptLength: prompt.length,
    harnessDir,
    cdpWsUrl: cdpWsUrl.slice(0, 50),
    resume: !!opts.resumeSessionId,
  });

  const abortController = new AbortController();
  if (signal) {
    signal.addEventListener('abort', () => abortController.abort());
  }

  let sessionId: string | undefined;
  let iterCount = 0;
  const pendingTools = new Map<string, string>();

  try {
    const q = query({
      prompt,
      options: {
        cwd: harnessDir,
        model: model ?? 'claude-opus-4-7',
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: apiKey,
          BU_CDP_WS: cdpWsUrl,
          BU_NAME: sessionName,
        },
        systemPrompt: {
          type: 'preset',
          preset: 'claude_code',
          append: SYSTEM_APPEND,
        },
        allowedTools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: 200,
        abortController,
        ...(opts.resumeSessionId ? { resume: opts.resumeSessionId } : {}),
      },
    });

    for await (const message of q) {
      const msg = message as Record<string, unknown>;

      if (msg.type === 'system' && msg.subtype === 'init') {
        sessionId = msg.session_id as string;
        mainLogger.info('agentSdk.sessionInit', { sessionId, sessionName });
      }

      if (msg.type === 'assistant' && typeof msg.message === 'object') {
        const apiMsg = msg.message as Record<string, unknown>;
        const contentArr = apiMsg.content as unknown[] | undefined;
        if (!Array.isArray(contentArr)) continue;

        const { text, toolUses } = parseContentBlocks(contentArr);

        for (const t of text) {
          if (t.trim()) onEvent({ type: 'thinking', text: t });
        }

        for (const tu of toolUses) {
          iterCount++;
          pendingTools.set(tu.id, tu.name);
          onEvent({ type: 'tool_call', name: tu.name, args: tu.input, iteration: iterCount });
        }
      }

      if (msg.type === 'user' && typeof msg.message === 'object') {
        const userMsg = msg.message as Record<string, unknown>;
        const contentArr = userMsg.content as unknown[] | undefined;
        if (!Array.isArray(contentArr)) continue;

        const results = parseToolResults(contentArr);
        for (const r of results) {
          const toolName = pendingTools.get(r.toolUseId) ?? 'unknown';
          pendingTools.delete(r.toolUseId);
          onEvent({
            type: 'tool_result',
            name: toolName,
            ok: !r.isError,
            preview: r.content.slice(0, 500),
            ms: 0,
          });

          if (toolName === 'Write') {
            const skillMatch = r.content.match(/(?:domain-skills|interaction-skills)\/([^/]+)\/([^/]+)\.md/);
            if (skillMatch) {
              onEvent({ type: 'skill_written', path: skillMatch[0], domain: skillMatch[1], topic: skillMatch[2], bytes: r.content.length });
            }
          }
        }
      }

      if (msg.type === 'result') {
        const summary = String(msg.result ?? '(completed)');
        onEvent({ type: 'done', summary: summary.slice(0, 2000), iterations: iterCount });
      }
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError' || signal?.aborted) {
      onEvent({ type: 'done', summary: 'Halted by user', iterations: iterCount });
    } else {
      const errorMsg = (err as Error).message ?? String(err);
      mainLogger.error('agentSdk.error', { sessionName, error: errorMsg });
      onEvent({ type: 'error', message: errorMsg });
    }
  }

  return sessionId;
}
