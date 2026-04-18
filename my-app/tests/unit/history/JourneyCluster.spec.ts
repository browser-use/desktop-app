/**
 * JourneyCluster unit tests — backfilled coverage for chrome://history journeys.
 *
 * Tests cover:
 *   - clusterEntries returns [] for empty input and for single-entry input
 *     (MIN_CLUSTER_SIZE is 2)
 *   - groups entries by root domain (strips www., uses last-2 labels)
 *   - splits clusters when gap exceeds CLUSTER_GAP_MS (30 minutes)
 *   - keeps clusters together at the boundary (gap == CLUSTER_GAP_MS)
 *   - sorts clusters newest-first by endTime
 *   - cluster label uses the unique title when ≤ 60 chars, else "Site — N pages"
 *   - queryJourneys filters on label, domain, and entry title/url
 *   - queryJourneys honours limit and offset
 *   - removeClusterEntries returns the entry ids; empty array for unknown id
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/main/logger', () => ({
  mainLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  clusterEntries,
  queryJourneys,
  removeClusterEntries,
} from '../../../src/main/history/JourneyCluster';
import type { HistoryEntry } from '../../../src/main/history/HistoryStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const BASE = 1_700_000_000_000; // arbitrary fixed timestamp

function makeEntry(
  id: string,
  url: string,
  title: string,
  visitTime: number,
): HistoryEntry {
  return { id, url, title, visitTime, favicon: null };
}

// ---------------------------------------------------------------------------
// clusterEntries
// ---------------------------------------------------------------------------

describe('clusterEntries — edge cases', () => {
  it('returns an empty array for an empty input', () => {
    expect(clusterEntries([])).toEqual([]);
  });

  it('returns an empty array when only one visit per domain (below MIN_CLUSTER_SIZE)', () => {
    const entries = [makeEntry('1', 'https://a.com', 'A', BASE)];
    expect(clusterEntries(entries)).toEqual([]);
  });

  it('returns an empty array when single visits across many domains never reach 2-per-cluster', () => {
    const entries = [
      makeEntry('1', 'https://a.com', 'A', BASE),
      makeEntry('2', 'https://b.com', 'B', BASE + MIN),
      makeEntry('3', 'https://c.com', 'C', BASE + 2 * MIN),
    ];
    expect(clusterEntries(entries)).toEqual([]);
  });
});

describe('clusterEntries — grouping by domain', () => {
  it('groups two visits to the same domain within 30 minutes into one cluster', () => {
    const entries = [
      makeEntry('1', 'https://example.com/page1', 'Page 1', BASE),
      makeEntry('2', 'https://example.com/page2', 'Page 2', BASE + 5 * MIN),
    ];
    const clusters = clusterEntries(entries);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].domain).toBe('example.com');
    expect(clusters[0].entries).toHaveLength(2);
  });

  it('treats www. and bare hostnames as the same domain', () => {
    const entries = [
      makeEntry('1', 'https://www.example.com/a', 'A', BASE),
      makeEntry('2', 'https://example.com/b', 'B', BASE + MIN),
    ];
    const clusters = clusterEntries(entries);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].domain).toBe('example.com');
  });

  it('uses the last two hostname labels for subdomains', () => {
    const entries = [
      makeEntry('1', 'https://docs.github.com/foo', 'Foo', BASE),
      makeEntry('2', 'https://api.github.com/bar', 'Bar', BASE + 2 * MIN),
    ];
    const clusters = clusterEntries(entries);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].domain).toBe('github.com');
  });

  it('keeps separate domains in separate clusters', () => {
    const entries = [
      makeEntry('1', 'https://a.com/1', 'A1', BASE),
      makeEntry('2', 'https://a.com/2', 'A2', BASE + MIN),
      makeEntry('3', 'https://b.com/1', 'B1', BASE + 2 * MIN),
      makeEntry('4', 'https://b.com/2', 'B2', BASE + 3 * MIN),
    ];
    const clusters = clusterEntries(entries);
    expect(clusters).toHaveLength(2);
    expect(new Set(clusters.map((c) => c.domain))).toEqual(new Set(['a.com', 'b.com']));
  });
});

describe('clusterEntries — temporal splitting', () => {
  it('splits into two clusters when a same-domain gap exceeds 30 minutes', () => {
    const entries = [
      makeEntry('1', 'https://a.com/1', 'A', BASE),
      makeEntry('2', 'https://a.com/2', 'A', BASE + 10 * MIN),
      // 31-minute gap → starts new cluster
      makeEntry('3', 'https://a.com/3', 'A', BASE + 41 * MIN),
      makeEntry('4', 'https://a.com/4', 'A', BASE + 50 * MIN),
    ];
    const clusters = clusterEntries(entries);
    expect(clusters).toHaveLength(2);
    expect(clusters.every((c) => c.entries.length === 2)).toBe(true);
  });

  it('keeps a cluster together at the exact 30-minute boundary', () => {
    const entries = [
      makeEntry('1', 'https://a.com/1', 'A', BASE),
      makeEntry('2', 'https://a.com/2', 'A', BASE + 30 * MIN),
    ];
    const clusters = clusterEntries(entries);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].entries).toHaveLength(2);
  });

  it('drops orphaned visits that do not reach MIN_CLUSTER_SIZE within their group', () => {
    // First 2 form a cluster; the 3rd is orphaned across the gap
    const entries = [
      makeEntry('1', 'https://a.com/1', 'A', BASE),
      makeEntry('2', 'https://a.com/2', 'A', BASE + 10 * MIN),
      makeEntry('3', 'https://a.com/3', 'A', BASE + 60 * MIN),
    ];
    const clusters = clusterEntries(entries);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].entries).toHaveLength(2);
  });
});

describe('clusterEntries — sorting and labelling', () => {
  it('sorts clusters newest-first by endTime', () => {
    const entries = [
      // Older cluster on a.com
      makeEntry('1', 'https://a.com/1', 'A', BASE),
      makeEntry('2', 'https://a.com/2', 'A', BASE + MIN),
      // Newer cluster on b.com
      makeEntry('3', 'https://b.com/1', 'B', BASE + 5 * HOUR),
      makeEntry('4', 'https://b.com/2', 'B', BASE + 5 * HOUR + MIN),
    ];
    const clusters = clusterEntries(entries);
    expect(clusters[0].domain).toBe('b.com');
    expect(clusters[1].domain).toBe('a.com');
  });

  it('uses the unique short title for the cluster label when applicable', () => {
    const entries = [
      makeEntry('1', 'https://a.com/x', 'Same Title', BASE),
      makeEntry('2', 'https://a.com/y', 'Same Title', BASE + MIN),
    ];
    const [cluster] = clusterEntries(entries);
    expect(cluster.label).toBe('Same Title');
  });

  it('falls back to "Site — N pages" label when titles differ', () => {
    const entries = [
      makeEntry('1', 'https://example.com/x', 'First', BASE),
      makeEntry('2', 'https://example.com/y', 'Second', BASE + MIN),
      makeEntry('3', 'https://example.com/z', 'Third', BASE + 2 * MIN),
    ];
    const [cluster] = clusterEntries(entries);
    expect(cluster.label).toBe('Example — 3 pages');
  });

  it('returns clusters with entries reversed (most-recent first within cluster)', () => {
    const entries = [
      makeEntry('older', 'https://a.com/1', 'A', BASE),
      makeEntry('newer', 'https://a.com/2', 'A', BASE + MIN),
    ];
    const [cluster] = clusterEntries(entries);
    expect(cluster.entries[0].id).toBe('newer');
    expect(cluster.entries[1].id).toBe('older');
  });
});

// ---------------------------------------------------------------------------
// queryJourneys
// ---------------------------------------------------------------------------

describe('queryJourneys', () => {
  function fixtures(): HistoryEntry[] {
    return [
      // github cluster
      makeEntry('g1', 'https://github.com/foo', 'Foo PR', BASE),
      makeEntry('g2', 'https://github.com/bar', 'Bar issue', BASE + 5 * MIN),
      // hacker news cluster (different domain)
      makeEntry('h1', 'https://news.ycombinator.com/a', 'Top story', BASE + 6 * HOUR),
      makeEntry('h2', 'https://news.ycombinator.com/b', 'Comments', BASE + 6 * HOUR + MIN),
    ];
  }

  it('returns all clusters when no query is given', () => {
    const result = queryJourneys(fixtures());
    expect(result.totalCount).toBe(2);
    expect(result.clusters).toHaveLength(2);
  });

  it('filters by domain substring', () => {
    const result = queryJourneys(fixtures(), { query: 'github' });
    expect(result.totalCount).toBe(1);
    expect(result.clusters[0].domain).toBe('github.com');
  });

  it('filters by entry title substring', () => {
    const result = queryJourneys(fixtures(), { query: 'comments' });
    expect(result.totalCount).toBe(1);
    expect(result.clusters[0].domain).toBe('ycombinator.com');
  });

  it('filters by entry URL substring', () => {
    const result = queryJourneys(fixtures(), { query: '/foo' });
    expect(result.totalCount).toBe(1);
    expect(result.clusters[0].domain).toBe('github.com');
  });

  it('returns empty result when nothing matches', () => {
    const result = queryJourneys(fixtures(), { query: 'no-such-thing' });
    expect(result.totalCount).toBe(0);
    expect(result.clusters).toHaveLength(0);
  });

  it('respects limit and offset', () => {
    const result = queryJourneys(fixtures(), { limit: 1, offset: 1 });
    expect(result.totalCount).toBe(2);
    expect(result.clusters).toHaveLength(1);
  });

  it('treats whitespace-only queries as no-filter', () => {
    const result = queryJourneys(fixtures(), { query: '   ' });
    expect(result.totalCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// removeClusterEntries
// ---------------------------------------------------------------------------

describe('removeClusterEntries', () => {
  it('returns the entry ids belonging to the targeted cluster', () => {
    const entries = [
      makeEntry('1', 'https://a.com/1', 'A', BASE),
      makeEntry('2', 'https://a.com/2', 'A', BASE + MIN),
    ];
    const [cluster] = clusterEntries(entries);
    const ids = removeClusterEntries(entries, cluster.id);
    expect(ids).toEqual(expect.arrayContaining(['1', '2']));
    expect(ids).toHaveLength(2);
  });

  it('returns an empty array when the cluster id is unknown', () => {
    const entries = [
      makeEntry('1', 'https://a.com/1', 'A', BASE),
      makeEntry('2', 'https://a.com/2', 'A', BASE + MIN),
    ];
    const ids = removeClusterEntries(entries, 'j-not-a-real-cluster');
    expect(ids).toEqual([]);
  });
});
