import React from 'react';

function tryParseJSON(str: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(str);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    return null;
  } catch {
    return null;
  }
}

function formatValue(val: unknown, depth: number): React.ReactNode {
  if (val === null || val === undefined) return <span className="cr__null">null</span>;
  if (typeof val === 'boolean') return <span className="cr__bool">{val ? 'on' : 'off'}</span>;
  if (typeof val === 'number') return <span className="cr__num">{val.toLocaleString()}</span>;
  if (typeof val === 'string') {
    if (val.length > 200) return <span className="cr__str">{val.slice(0, 200)}…</span>;
    return <span className="cr__str">{val}</span>;
  }
  if (Array.isArray(val)) {
    if (val.length === 0) return <span className="cr__null">[]</span>;
    if (val.every((v) => typeof v === 'string' || typeof v === 'number')) {
      return <span className="cr__str">{val.join(', ')}</span>;
    }
    return (
      <div className="cr__nested">
        {val.map((item, i) => (
          <div key={i} className="cr__row">
            <span className="cr__key">{i}</span>
            <span className="cr__val">{formatValue(item, depth + 1)}</span>
          </div>
        ))}
      </div>
    );
  }
  if (typeof val === 'object') {
    if (depth > 2) return <span className="cr__str">{JSON.stringify(val)}</span>;
    return (
      <div className="cr__nested">
        {Object.entries(val as Record<string, unknown>).map(([k, v]) => (
          <div key={k} className="cr__row">
            <span className="cr__key">{k}</span>
            <span className="cr__val">{formatValue(v, depth + 1)}</span>
          </div>
        ))}
      </div>
    );
  }
  return <span className="cr__str">{String(val)}</span>;
}

export function getPreview(content: string): string {
  const parsed = tryParseJSON(content);
  if (!parsed) {
    return content.length > 80 ? content.slice(0, 80) + '…' : content;
  }
  const vals = Object.values(parsed);
  const firstStr = vals.find((v) => typeof v === 'string') as string | undefined;
  if (firstStr) return firstStr.length > 80 ? firstStr.slice(0, 80) + '…' : firstStr;
  const firstNum = vals.find((v) => typeof v === 'number');
  if (firstNum !== undefined) return String(firstNum);
  return content.length > 80 ? content.slice(0, 80) + '…' : content;
}

interface ContentRendererProps {
  content: string;
  type: string;
}

export function ContentRenderer({ content, type }: ContentRendererProps): React.ReactElement {
  if (type === 'thinking' || type === 'text' || type === 'error') {
    return <pre className="entry__pre">{content}</pre>;
  }

  const parsed = tryParseJSON(content);

  if (!parsed) {
    return <pre className="entry__pre">{content}</pre>;
  }

  return (
    <div className="cr">
      {Object.entries(parsed).map(([key, val]) => (
        <div key={key} className="cr__row">
          <span className="cr__key">{key}</span>
          <span className="cr__val">{formatValue(val, 0)}</span>
        </div>
      ))}
    </div>
  );
}

export default ContentRenderer;
