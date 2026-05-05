/**
 * TerminalPane — an xterm.js instance scoped to a single session.
 *
 * - Mounts imperatively on a ref (no React wrapper — same as VS Code).
 * - On mount, pulls the full translated event history from main for replay,
 *   then subscribes to the live `session-output-term` stream.
 * - Infinite-ish scrollback (100k lines). xterm virtualizes DOM rows
 *   internally so only visible rows live in the DOM.
 * - Read-only for v1: stdin is disabled. Follow-up still goes through the
 *   existing `FollowUpInput` → IPC path.
 * - Clickable link provider routes `outputs/<sessionId>/…` paths through the
 *   existing IDE/Finder IPC so parity with `FileOutputRow` is preserved.
 * - Renders an idle "thinking" spinner (cli-spinners dots2) directly into
 *   the xterm grid via ANSI writes. The spinner overwrites its own row via
 *   \r so it never grows scrollback, never overlaps content, and always
 *   stays at the cursor row.
 */
import React, { useEffect, useRef } from 'react';
import { Terminal, type ITerminalOptions, type IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';

const SCROLLBACK_LINES = 100_000;
const OUTPUT_PATH_RE = /(?:^|\s)(outputs\/[a-zA-Z0-9_-]{6,}\/[^\s]+)/g;

const SPINNER_FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];
const SPINNER_INTERVAL_MS = 80;
const SPINNER_IDLE_MS = 250;

function spinnerColorAnsi(engine: string | null | undefined): string {
  if (engine === 'claude-code') return '\x1b[38;2;204;120;92m';
  if (engine === 'codex') return '\x1b[38;2;91;155;255m';
  return '\x1b[38;2;214;216;220m';
}

function readCssVar(name: string, fallback: string): string {
  try {
    const v = getComputedStyle(document.body).getPropertyValue(name).trim();
    return v || fallback;
  } catch { return fallback; }
}

function buildTheme(): NonNullable<ITerminalOptions['theme']> {
  return {
    background: readCssVar('--color-bg', '#0b0d10'),
    foreground: readCssVar('--color-fg', '#d6d8dc'),
    cursor: readCssVar('--color-bg', '#0b0d10'),
    cursorAccent: readCssVar('--color-bg', '#0b0d10'),
    selectionBackground: readCssVar('--color-selection', '#2a3340'),
    black: '#1a1d22',
    red: '#e06c75',
    green: '#98c379',
    yellow: '#e5c07b',
    blue: '#61afef',
    magenta: '#c678dd',
    cyan: '#56b6c2',
    white: '#abb2bf',
    brightBlack: '#5c6370',
    brightRed: '#ff7b86',
    brightGreen: '#b0e08c',
    brightYellow: '#f2d08a',
    brightBlue: '#79c0ff',
    brightMagenta: '#d48cee',
    brightCyan: '#7dd3fc',
    brightWhite: '#e6eaee',
  };
}

interface TerminalPaneProps {
  sessionId: string;
  engine?: string | null;
  isActive?: boolean;
}

export function TerminalPane({ sessionId, engine, isActive }: TerminalPaneProps): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  // Mutable spinner state — refs (not React state) so the byte-stream callback
  // doesn't churn renders. The mount effect wires up the timers; the
  // engine/isActive effect just updates these fields.
  const spin = useRef<{
    frame: number;
    timer: number | null;
    idleTimer: number | null;
    visible: boolean;
    cursorAtLineStart: boolean;
    lastByteAt: number;
    engine: string | null | undefined;
    active: boolean;
    term: Terminal | null;
  }>({
    frame: 0,
    timer: null,
    idleTimer: null,
    visible: false,
    cursorAtLineStart: true,
    lastByteAt: 0,
    engine: null,
    active: false,
    term: null,
  });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      fontFamily: 'JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      theme: buildTheme(),
      cursorBlink: false,
      cursorStyle: 'bar',
      disableStdin: true,
      convertEol: true,
      scrollback: SCROLLBACK_LINES,
      allowTransparency: true,
      fontWeight: '400',
      fontWeightBold: '600',
      smoothScrollDuration: 0,
    });

    const fit = new FitAddon();
    term.loadAddon(fit);
    const webLinks = new WebLinksAddon((_evt, uri) => {
      window.open(uri, '_blank', 'noopener,noreferrer');
    });
    term.loadAddon(webLinks);
    term.open(host);

    spin.current.term = term;

    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => { try { webgl.dispose(); } catch { /* already disposed */ } });
      term.loadAddon(webgl);
    } catch (err) {
      console.warn('[TerminalPane] webgl addon unavailable', err);
    }

    const linkDisposable: IDisposable = term.registerLinkProvider({
      provideLinks: (y, callback) => {
        const line = term.buffer.active.getLine(y - 1);
        const text = line?.translateToString(true) ?? '';
        if (!text) return callback(undefined);
        const links: Array<{ range: { start: { x: number; y: number }; end: { x: number; y: number } }; text: string; activate: () => void }> = [];
        let m: RegExpExecArray | null;
        OUTPUT_PATH_RE.lastIndex = 0;
        while ((m = OUTPUT_PATH_RE.exec(text)) !== null) {
          const rel = m[1];
          const start = m.index + (m[0].length - rel.length) + 1;
          links.push({
            range: { start: { x: start, y }, end: { x: start + rel.length - 1, y } },
            text: rel,
            activate: () => {
              const api = window.electronAPI?.sessions;
              if (!api) return;
              api.revealOutput(rel).catch((e: unknown) => console.error('[TerminalPane] revealOutput', e));
            },
          });
        }
        callback(links.length ? links : undefined);
      },
    });

    /** Wipe the spinner row in place. Cursor returns to col 0 of the same row,
     *  so the next event writes there — no extra blank rows in the buffer. */
    const stopSpinner = (): void => {
      const s = spin.current;
      if (s.timer != null) {
        window.clearInterval(s.timer);
        s.timer = null;
      }
      if (s.visible) {
        try { term.write('\r\x1b[2K'); } catch { /* term disposed */ }
        s.visible = false;
      }
    };

    const paintSpinner = (): void => {
      const s = spin.current;
      const color = spinnerColorAnsi(s.engine);
      const glyph = SPINNER_FRAMES[s.frame % SPINNER_FRAMES.length];
      try {
        term.write(`\r\x1b[2K${color}${glyph} thinking…\x1b[0m`);
      } catch { /* term disposed */ }
      s.frame = (s.frame + 1) % SPINNER_FRAMES.length;
    };

    const startSpinner = (): void => {
      const s = spin.current;
      if (s.timer != null) return;
      s.visible = true;
      paintSpinner();
      s.timer = window.setInterval(paintSpinner, SPINNER_INTERVAL_MS);
    };

    // Hoisted above the idle timer so the spinner gate can check it. The
    // replay write path (`term.write(replay)` below) bypasses
    // `writeStreamBytes` and therefore can't call `stopSpinner` itself, so
    // the spinner MUST stay dormant until replay finishes — otherwise its
    // periodic `\r\x1b[2K` repaints race the replay stream and erase rows
    // mid-render.
    let disposed = false;
    let replayApplied = false;
    const pending: string[] = [];

    const maybeStartSpinner = (): void => {
      const s = spin.current;
      if (!replayApplied) return;
      if (!s.active) return;
      if (s.visible) return;
      if (!s.cursorAtLineStart) return;
      const idleFor = performance.now() - s.lastByteAt;
      if (s.lastByteAt !== 0 && idleFor < SPINNER_IDLE_MS) return;
      startSpinner();
    };

    spin.current.idleTimer = window.setInterval(maybeStartSpinner, SPINNER_INTERVAL_MS);

    const api = window.electronAPI;

    const writeStreamBytes = (bytes: string): void => {
      const s = spin.current;
      stopSpinner();
      term.write(bytes);
      s.lastByteAt = performance.now();
      const last = bytes.charCodeAt(bytes.length - 1);
      s.cursorAtLineStart = last === 0x0a /* \n */;
    };

    const offTerm = api?.on?.sessionOutputTerm?.((id, bytes) => {
      if (id !== sessionId) return;
      if (!replayApplied) {
        pending.push(bytes);
        return;
      }
      writeStreamBytes(bytes);
    });

    (async () => {
      try {
        const replay = await api?.sessions?.getTermReplay?.(sessionId);
        if (disposed) return;
        if (replay) {
          term.write(replay);
          const last = replay.charCodeAt(replay.length - 1);
          spin.current.cursorAtLineStart = replay.length === 0 || last === 0x0a;
          spin.current.lastByteAt = performance.now();
        }
      } catch (err) {
        console.error('[TerminalPane] getTermReplay failed', err);
      }
      replayApplied = true;
      if (pending.length > 0) {
        for (const chunk of pending) writeStreamBytes(chunk);
        pending.length = 0;
      }
      try { fit.fit(); } catch { /* container not ready */ }
    })();

    let raf = 0;
    const onResize = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        try { fit.fit(); } catch { /* noop */ }
      });
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(host);
    const onLayoutChange = () => onResize();
    window.addEventListener('pane:layout-change', onLayoutChange);

    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      const s = spin.current;
      if (s.timer != null) window.clearInterval(s.timer);
      if (s.idleTimer != null) window.clearInterval(s.idleTimer);
      s.timer = null;
      s.idleTimer = null;
      s.visible = false;
      s.term = null;
      ro.disconnect();
      window.removeEventListener('pane:layout-change', onLayoutChange);
      try { offTerm?.(); } catch { /* noop */ }
      try { linkDisposable.dispose(); } catch { /* noop */ }
      try { term.dispose(); } catch { /* noop */ }
    };
  }, [sessionId]);

  // Sync engine + active gating into the mutable spinner state. When isActive
  // flips false, also wipe any visible spinner immediately so we don't leave
  // a stale row.
  useEffect(() => {
    const s = spin.current;
    s.engine = engine ?? null;
    s.active = !!isActive;
    if (!s.active && s.visible) {
      if (s.timer != null) {
        window.clearInterval(s.timer);
        s.timer = null;
      }
      try { s.term?.write('\r\x1b[2K'); } catch { /* term disposed */ }
      s.visible = false;
    }
  }, [engine, isActive]);

  return <div className="pane__terminal" ref={hostRef} />;
}

export default TerminalPane;
