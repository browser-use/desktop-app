import React from 'react';
import { Markdown, linkifyOutputPaths, linkifyPathsToReact } from './Markdown';

// Strings that mention an output path get rendered via Markdown so the path
// becomes a clickable link. Pure plain text stays plain to avoid mangling
// backticks/asterisks in bash commands etc.
const OUTPUT_PATH_MARKER = /\boutputs\/[a-zA-Z0-9_-]{6,}\//;

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
    if (OUTPUT_PATH_MARKER.test(val)) {
      return <span className="cr__str">{linkifyPathsToReact(val)}</span>;
    }
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

function isGarbage(str: string): boolean {
  const trimmed = str.trim();
  if (/^[0-9A-Fa-f]{16,}$/.test(trimmed)) return true;
  if (trimmed.startsWith('iVBOR') || trimmed.startsWith('data:image')) return true;
  if (trimmed.startsWith('Skip to main content')) return true;
  if (/^[0-9]+$/.test(trimmed)) return true;
  if (trimmed.startsWith('{') && trimmed.includes('"body":"<!doctype')) return true;
  if (trimmed.startsWith('"') && trimmed.includes('\\n')) return true;
  const lower = trimmed.toLowerCase();
  if (lower === 'true' || lower === 'false' || lower === 'not supported' || lower === 'null') return true;
  return false;
}

export function getPreview(content: string): string {
  const parsed = tryParseJSON(content);
  if (!parsed) {
    if (isGarbage(content)) return '';
    const clean = content.replace(/\n/g, ' ').trim();
    return clean.length > 60 ? clean.slice(0, 60) + '…' : clean;
  }
  const vals = Object.values(parsed);
  const firstStr = vals.find((v) => typeof v === 'string' && !isGarbage(v as string)) as string | undefined;
  if (firstStr) {
    const clean = firstStr.replace(/\n/g, ' ').trim();
    return clean.length > 60 ? clean.slice(0, 60) + '…' : clean;
  }
  const firstNum = vals.find((v) => typeof v === 'number');
  if (firstNum !== undefined) return String(firstNum);
  return '';
}

interface ContentRendererProps {
  content: string;
  type: string;
}

export function ContentRenderer({ content, type }: ContentRendererProps): React.ReactElement {
  if (type === 'text' || type === 'done' || type === 'user_input') {
    return <Markdown source={content} />;
  }
  if (type === 'thinking' || type === 'error') {
    if (OUTPUT_PATH_MARKER.test(content)) {
      return <pre className="entry__pre">{linkifyPathsToReact(content)}</pre>;
    }
    return <pre className="entry__pre">{content}</pre>;
  }

  const parsed = tryParseJSON(content);

  if (!parsed) {
    if (OUTPUT_PATH_MARKER.test(content)) {
      return <pre className="entry__pre">{linkifyPathsToReact(content)}</pre>;
    }
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
