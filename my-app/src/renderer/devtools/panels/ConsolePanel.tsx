import React, { useState, useEffect, useRef, useCallback } from 'react';

interface CdpPanelProps {
  sendCdp: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  subscribeCdp: (listener: (method: string, params: unknown) => void) => () => void;
}

type LogLevel = 'log' | 'info' | 'warning' | 'error' | 'debug' | 'result';

interface ConsoleEntry {
  id: number;
  level: LogLevel;
  text: string;
  source?: string;
  timestamp: number;
}

const LEVEL_ICONS: Record<LogLevel, string> = {
  log: ' ',
  info: 'ℹ',
  warning: '⚠',
  error: '✕',
  debug: '⊙',
  result: '←',
};

let entryIdCounter = 0;

export function ConsolePanel({ sendCdp, subscribeCdp }: CdpPanelProps): React.ReactElement {
  const [messages, setMessages] = useState<ConsoleEntry[]>([]);
  const [input, setInput] = useState('');
  const [filter, setFilter] = useState('');
  const [activeLevels, setActiveLevels] = useState<Set<LogLevel>>(
    new Set(['log', 'info', 'warning', 'error', 'debug', 'result']),
  );
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    console.log('[ConsolePanel] enabling Runtime + Log domains');

    void sendCdp('Runtime.enable');
    void sendCdp('Log.enable');

    const unsubscribe = subscribeCdp((method, params) => {
      const p = params as Record<string, unknown>;

      if (method === 'Runtime.consoleAPICalled') {
        const args = p.args as Array<{ type: string; value?: unknown; description?: string }>;
        const text = args
          .map((a) => {
            if (a.value !== undefined) return String(a.value);
            if (a.description) return a.description;
            return `[${a.type}]`;
          })
          .join(' ');

        const levelMap: Record<string, LogLevel> = {
          log: 'log',
          info: 'info',
          warning: 'warning',
          error: 'error',
          debug: 'debug',
          dir: 'log',
          table: 'log',
          trace: 'log',
          assert: 'error',
        };
        const type = p.type as string;
        const level = levelMap[type] ?? 'log';

        const stackTrace = p.stackTrace as { callFrames?: Array<{ url?: string; lineNumber?: number }> } | undefined;
        const frame = stackTrace?.callFrames?.[0];
        const source = frame?.url ? `${frame.url}:${(frame.lineNumber ?? 0) + 1}` : undefined;

        setMessages((prev) => [
          ...prev,
          { id: entryIdCounter++, level, text, source, timestamp: Date.now() },
        ]);
      }

      if (method === 'Runtime.exceptionThrown') {
        const detail = p.exceptionDetails as {
          text?: string;
          exception?: { description?: string };
          url?: string;
          lineNumber?: number;
        };
        const text = detail?.exception?.description ?? detail?.text ?? 'Unknown error';
        const source = detail?.url ? `${detail.url}:${(detail.lineNumber ?? 0) + 1}` : undefined;

        setMessages((prev) => [
          ...prev,
          { id: entryIdCounter++, level: 'error', text, source, timestamp: Date.now() },
        ]);
      }

      if (method === 'Log.entryAdded') {
        const entry = p.entry as { level?: string; text?: string; url?: string; lineNumber?: number };
        const levelMap: Record<string, LogLevel> = {
          verbose: 'debug',
          info: 'info',
          warning: 'warning',
          error: 'error',
        };
        setMessages((prev) => [
          ...prev,
          {
            id: entryIdCounter++,
            level: levelMap[entry.level ?? ''] ?? 'log',
            text: entry.text ?? '',
            source: entry.url ? `${entry.url}:${(entry.lineNumber ?? 0) + 1}` : undefined,
            timestamp: Date.now(),
          },
        ]);
      }
    });

    return () => {
      unsubscribe();
      void sendCdp('Runtime.disable').catch(() => {});
      void sendCdp('Log.disable').catch(() => {});
    };
  }, [sendCdp, subscribeCdp]);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const handleEval = useCallback(async () => {
    const expression = input.trim();
    if (!expression) return;

    setHistory((prev) => [...prev.filter((h) => h !== expression), expression]);
    setHistoryIndex(-1);

    setMessages((prev) => [
      ...prev,
      { id: entryIdCounter++, level: 'log', text: `> ${expression}`, timestamp: Date.now() },
    ]);
    setInput('');

    try {
      const result = (await sendCdp('Runtime.evaluate', {
        expression,
        generatePreview: true,
        replMode: true,
        awaitPromise: true,
      })) as {
        result?: { type?: string; value?: unknown; description?: string; subtype?: string };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      };

      if (result.exceptionDetails) {
        const errText =
          result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          'Evaluation error';
        setMessages((prev) => [
          ...prev,
          { id: entryIdCounter++, level: 'error', text: errText, timestamp: Date.now() },
        ]);
      } else if (result.result) {
        const r = result.result;
        let text: string;
        if (r.subtype === 'null') text = 'null';
        else if (r.type === 'undefined') text = 'undefined';
        else if (r.value !== undefined) text = JSON.stringify(r.value);
        else if (r.description) text = r.description;
        else text = `[${r.type}]`;

        setMessages((prev) => [
          ...prev,
          { id: entryIdCounter++, level: 'result', text, timestamp: Date.now() },
        ]);
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { id: entryIdCounter++, level: 'error', text: String(err), timestamp: Date.now() },
      ]);
    }
  }, [input, sendCdp]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        void handleEval();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (history.length > 0) {
          const newIdx = historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1);
          setHistoryIndex(newIdx);
          setInput(history[newIdx]);
        }
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (historyIndex >= 0) {
          const newIdx = historyIndex + 1;
          if (newIdx >= history.length) {
            setHistoryIndex(-1);
            setInput('');
          } else {
            setHistoryIndex(newIdx);
            setInput(history[newIdx]);
          }
        }
      }
    },
    [handleEval, history, historyIndex],
  );

  const toggleLevel = (level: LogLevel): void => {
    setActiveLevels((prev) => {
      const next = new Set(prev);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  };

  const clearMessages = (): void => {
    setMessages([]);
  };

  const filteredMessages = messages.filter((m) => {
    if (!activeLevels.has(m.level)) return false;
    if (filter && !m.text.toLowerCase().includes(filter.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="console-panel">
      <div className="console-toolbar">
        <input
          className="console-filter-input"
          type="text"
          placeholder="Filter output..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {(['error', 'warning', 'info', 'log', 'debug'] as LogLevel[]).map((level) => (
          <button
            key={level}
            className="console-level-btn"
            data-active={activeLevels.has(level) ? 'true' : 'false'}
            onClick={() => toggleLevel(level)}
          >
            {level}
          </button>
        ))}
        <button className="console-clear-btn" onClick={clearMessages}>
          Clear
        </button>
      </div>

      <div className="console-messages">
        {filteredMessages.map((msg) => (
          <div key={msg.id} className="console-message" data-level={msg.level}>
            <span className="console-message-level">{LEVEL_ICONS[msg.level]}</span>
            <span className="console-message-text">{msg.text}</span>
            {msg.source && <span className="console-message-source">{msg.source}</span>}
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="console-input-row">
        <span className="console-prompt-symbol">›</span>
        <input
          ref={inputRef}
          className="console-input"
          type="text"
          placeholder="Evaluate JavaScript..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          autoFocus
        />
      </div>
    </div>
  );
}
