/**
 * CommandPalette — the idle-phase rows under the pill input.
 *
 * Rows (in order):
 *   1. Fuzzy-matched open tabs  → "Switch to tab"
 *   2. Always-present            → "Run as agent task: <query>"
 *
 * Selection is driven by parent (keyboard nav in Pill.tsx). onSelect fires
 * when Enter or click lands on a row.
 */

import React from 'react';

export type PaletteRow =
  | { kind: 'tab'; tabId: string; title: string; url: string }
  | { kind: 'agent'; prompt: string };

export interface PaletteProps {
  rows: PaletteRow[];
  activeIndex: number;
  onSelect: (row: PaletteRow) => void;
  onHover: (index: number) => void;
}

/** Subsequence fuzzy match — returns true if every char of q appears in order in s (case-insensitive). */
export function fuzzyMatch(q: string, s: string): boolean {
  if (!q) return true;
  const a = q.toLowerCase(); const b = s.toLowerCase();
  let j = 0;
  for (let i = 0; i < b.length && j < a.length; i++) if (b[i] === a[j]) j++;
  return j === a.length;
}

/** Build palette rows from tabs + query. Fuzzy filter by title or url. */
export function buildRows(
  query: string,
  tabs: Array<{ id: string; title: string; url: string }>,
  maxTabRows = 5,
): PaletteRow[] {
  const q = query.trim();
  const matches = tabs
    .filter((t) => fuzzyMatch(q, t.title) || fuzzyMatch(q, t.url))
    .slice(0, maxTabRows)
    .map((t): PaletteRow => ({ kind: 'tab', tabId: t.id, title: t.title, url: t.url }));

  const rows: PaletteRow[] = [...matches];
  if (q) rows.push({ kind: 'agent', prompt: q });
  return rows;
}

function TabRow({ row, active, onSelect, onHover, index }: {
  row: Extract<PaletteRow, { kind: 'tab' }>;
  active: boolean;
  onSelect: (r: PaletteRow) => void;
  onHover: (i: number) => void;
  index: number;
}): React.ReactElement {
  return (
    <div
      className={`pill-palette-row ${active ? 'is-active' : ''}`}
      data-kind="tab"
      onMouseEnter={() => onHover(index)}
      onClick={() => onSelect(row)}
      role="option"
      aria-selected={active}
    >
      <span className="pill-palette-icon" aria-hidden="true">▸</span>
      <span className="pill-palette-title">{row.title || 'Untitled'}</span>
      <span className="pill-palette-sub">{row.url}</span>
    </div>
  );
}

function AgentRow({ row, active, onSelect, onHover, index }: {
  row: Extract<PaletteRow, { kind: 'agent' }>;
  active: boolean;
  onSelect: (r: PaletteRow) => void;
  onHover: (i: number) => void;
  index: number;
}): React.ReactElement {
  return (
    <div
      className={`pill-palette-row pill-palette-row--agent ${active ? 'is-active' : ''}`}
      data-kind="agent"
      onMouseEnter={() => onHover(index)}
      onClick={() => onSelect(row)}
      role="option"
      aria-selected={active}
    >
      <span className="pill-palette-icon" aria-hidden="true">◆</span>
      <span className="pill-palette-title">Run as agent task</span>
      <span className="pill-palette-sub">{row.prompt}</span>
    </div>
  );
}

export function CommandPalette({ rows, activeIndex, onSelect, onHover }: PaletteProps): React.ReactElement {
  return (
    <div className="pill-palette" role="listbox" aria-label="Command palette">
      {rows.map((row, i) => {
        const active = i === activeIndex;
        if (row.kind === 'tab') {
          return <TabRow key={`t-${row.tabId}`} row={row} active={active} onSelect={onSelect} onHover={onHover} index={i} />;
        }
        return <AgentRow key={`a-${i}`} row={row} active={active} onSelect={onSelect} onHover={onHover} index={i} />;
      })}
    </div>
  );
}
