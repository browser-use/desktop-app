/**
 * @vitest-environment jsdom
 *
 * HistoryPage renderer smoke tests — backfilled coverage for chrome://history.
 *
 * Tests cover:
 *   - mounts without crashing
 *   - renders the "List" / "Journeys" tab nav
 *   - renders entries grouped by date (Today/Yesterday/etc.)
 *   - empty-state shows the right copy when there are no entries
 *   - typing in the search box debounces and triggers a re-query
 *   - clicking the per-row remove (X) button calls historyAPI.remove
 *   - clicking the entry link calls historyAPI.navigateTo
 *
 * Strategy: install a global historyAPI stub before mounting; assert the
 * IPC calls landed on the stub.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';

// Stub the JourneysPage subtree to keep this smoke test focused
vi.mock('../../../src/renderer/history/JourneysPage', () => ({
  JourneysPage: () => <div data-testid="journeys-page">journeys</div>,
}));

import { HistoryPage } from '../../../src/renderer/history/HistoryPage';

interface FakeEntry {
  id: string;
  url: string;
  title: string;
  visitTime: number;
  favicon: string | null;
}

function makeAPI(initial: FakeEntry[] = []) {
  let entries = [...initial];
  return {
    query: vi.fn(async () => ({ entries: entries.slice(), totalCount: entries.length })),
    remove: vi.fn(async (id: string) => {
      entries = entries.filter((e) => e.id !== id);
      return true;
    }),
    removeBulk: vi.fn(async (ids: string[]) => {
      const before = entries.length;
      const set = new Set(ids);
      entries = entries.filter((e) => !set.has(e.id));
      return before - entries.length;
    }),
    clearAll: vi.fn(async () => true),
    navigateTo: vi.fn(async () => undefined),
    _entries: () => entries.slice(),
  };
}

function todayAt(hour: number, minute = 0): number {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.getTime();
}

describe('HistoryPage', () => {
  beforeEach(() => {
    // Reset globals between tests
    (globalThis as unknown as { historyAPI?: unknown }).historyAPI = undefined;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('mounts and renders the title and tab nav', async () => {
    (globalThis as unknown as { historyAPI: ReturnType<typeof makeAPI> }).historyAPI = makeAPI();
    render(<HistoryPage />);
    expect(screen.getByText('History')).toBeTruthy();
    expect(screen.getByRole('tab', { name: /list/i })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /journeys/i })).toBeTruthy();
  });

  it('renders entries returned by historyAPI.query', async () => {
    const api = makeAPI([
      { id: 'a', url: 'https://example.com', title: 'Example Site', visitTime: todayAt(9), favicon: null },
      { id: 'b', url: 'https://github.com', title: 'GitHub', visitTime: todayAt(10), favicon: null },
    ]);
    (globalThis as unknown as { historyAPI: typeof api }).historyAPI = api;

    render(<HistoryPage />);
    await waitFor(() => expect(api.query).toHaveBeenCalled());
    expect(await screen.findByText('Example Site')).toBeTruthy();
    expect(await screen.findByText('GitHub')).toBeTruthy();
  });

  it('groups entries under a date label (e.g. "Today")', async () => {
    const api = makeAPI([
      { id: 'a', url: 'https://x.com', title: 'X', visitTime: todayAt(9), favicon: null },
    ]);
    (globalThis as unknown as { historyAPI: typeof api }).historyAPI = api;

    render(<HistoryPage />);
    expect(await screen.findByText('Today')).toBeTruthy();
  });

  it('renders the empty state when no entries are returned', async () => {
    (globalThis as unknown as { historyAPI: ReturnType<typeof makeAPI> }).historyAPI = makeAPI();
    render(<HistoryPage />);
    expect(await screen.findByText(/no browsing history/i)).toBeTruthy();
  });

  it('clicking the row remove button calls historyAPI.remove with the entry id', async () => {
    const api = makeAPI([
      { id: 'doomed', url: 'https://x.com', title: 'Doomed', visitTime: todayAt(9), favicon: null },
    ]);
    (globalThis as unknown as { historyAPI: typeof api }).historyAPI = api;

    render(<HistoryPage />);
    const removeBtn = await screen.findByRole('button', { name: /remove from history/i });
    await act(async () => {
      fireEvent.click(removeBtn);
    });
    expect(api.remove).toHaveBeenCalledWith('doomed');
  });

  it('clicking an entry link calls historyAPI.navigateTo with the URL', async () => {
    const api = makeAPI([
      { id: 'a', url: 'https://example.com/foo', title: 'Foo', visitTime: todayAt(9), favicon: null },
    ]);
    (globalThis as unknown as { historyAPI: typeof api }).historyAPI = api;

    render(<HistoryPage />);
    const link = await screen.findByText('Foo');
    fireEvent.click(link);
    expect(api.navigateTo).toHaveBeenCalledWith('https://example.com/foo');
  });

  it('typing in the search box (after debounce) re-issues query with the term', async () => {
    vi.useFakeTimers();
    const api = makeAPI([
      { id: 'a', url: 'https://x.com', title: 'X', visitTime: todayAt(9), favicon: null },
    ]);
    (globalThis as unknown as { historyAPI: typeof api }).historyAPI = api;

    render(<HistoryPage />);
    // Wait for first effect / initial fetch
    await act(async () => {
      await Promise.resolve();
    });
    const callCountBefore = api.query.mock.calls.length;

    const input = screen.getByLabelText(/search history/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'hello' } });

    // Advance past the 250ms debounce
    await act(async () => {
      vi.advanceTimersByTime(260);
    });
    // Allow the post-state-update fetch to resolve
    await act(async () => {
      await Promise.resolve();
    });

    expect(api.query.mock.calls.length).toBeGreaterThan(callCountBefore);
    const lastCall = api.query.mock.calls[api.query.mock.calls.length - 1] as unknown as
      | [{ query?: string } | undefined]
      | undefined;
    expect(lastCall?.[0]?.query).toBe('hello');

    vi.useRealTimers();
  });

  it('switching to the Journeys tab swaps the page content', async () => {
    (globalThis as unknown as { historyAPI: ReturnType<typeof makeAPI> }).historyAPI = makeAPI();
    render(<HistoryPage />);
    fireEvent.click(screen.getByRole('tab', { name: /journeys/i }));
    expect(screen.getByTestId('journeys-page')).toBeTruthy();
  });

  it('selecting an entry exposes the bulk-delete bar', async () => {
    const api = makeAPI([
      { id: 'a', url: 'https://x.com', title: 'X', visitTime: todayAt(9), favicon: null },
      { id: 'b', url: 'https://y.com', title: 'Y', visitTime: todayAt(10), favicon: null },
    ]);
    (globalThis as unknown as { historyAPI: typeof api }).historyAPI = api;

    render(<HistoryPage />);
    const checkboxes = await screen.findAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    expect(screen.getByText(/1 selected/i)).toBeTruthy();
  });
});
