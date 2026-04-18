/**
 * JourneyCluster — on-device topic-grouped clustering of history visits.
 *
 * Groups history entries into "journeys" based on domain affinity and
 * temporal proximity. Two entries belong to the same cluster when they
 * share a root domain and occur within CLUSTER_GAP_MS of each other.
 */

import { HistoryEntry } from './HistoryStore';
import { mainLogger } from '../logger';

const CLUSTER_GAP_MS = 30 * 60 * 1000; // 30 minutes between visits
const MIN_CLUSTER_SIZE = 2;

export interface JourneyCluster {
  id: string;
  label: string;
  domain: string;
  entries: HistoryEntry[];
  startTime: number;
  endTime: number;
}

export interface JourneyQueryOptions {
  query?: string;
  limit?: number;
  offset?: number;
}

export interface JourneyQueryResult {
  clusters: JourneyCluster[];
  totalCount: number;
}

function extractRootDomain(url: string): string {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    const parts = hostname.split('.');
    if (parts.length > 2) {
      return parts.slice(-2).join('.');
    }
    return hostname;
  } catch {
    return url;
  }
}

function extractSiteName(url: string): string {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '');
    const parts = hostname.split('.');
    if (parts.length >= 2) {
      return parts[parts.length - 2];
    }
    return hostname;
  } catch {
    return url;
  }
}

function generateClusterId(domain: string, startTime: number): string {
  return `j-${domain}-${startTime}`;
}

function buildClusterLabel(entries: HistoryEntry[], domain: string): string {
  const siteName = extractSiteName(entries[0].url);
  const capitalised = siteName.charAt(0).toUpperCase() + siteName.slice(1);

  const uniqueTitles = new Set(entries.map((e) => e.title).filter(Boolean));
  if (uniqueTitles.size === 1) {
    const title = [...uniqueTitles][0];
    if (title.length <= 60) return title;
  }

  return `${capitalised} — ${entries.length} pages`;
}

export function clusterEntries(entries: HistoryEntry[]): JourneyCluster[] {
  mainLogger.debug('JourneyCluster.clusterEntries.start', { entryCount: entries.length });

  const byDomain = new Map<string, HistoryEntry[]>();
  for (const entry of entries) {
    const domain = extractRootDomain(entry.url);
    const existing = byDomain.get(domain);
    if (existing) {
      existing.push(entry);
    } else {
      byDomain.set(domain, [entry]);
    }
  }

  const clusters: JourneyCluster[] = [];

  for (const [domain, domainEntries] of byDomain) {
    const sorted = [...domainEntries].sort((a, b) => a.visitTime - b.visitTime);

    let currentGroup: HistoryEntry[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].visitTime - sorted[i - 1].visitTime;
      if (gap <= CLUSTER_GAP_MS) {
        currentGroup.push(sorted[i]);
      } else {
        if (currentGroup.length >= MIN_CLUSTER_SIZE) {
          const startTime = currentGroup[0].visitTime;
          const endTime = currentGroup[currentGroup.length - 1].visitTime;
          clusters.push({
            id: generateClusterId(domain, startTime),
            label: buildClusterLabel(currentGroup, domain),
            domain,
            entries: [...currentGroup].reverse(),
            startTime,
            endTime,
          });
        }
        currentGroup = [sorted[i]];
      }
    }

    if (currentGroup.length >= MIN_CLUSTER_SIZE) {
      const startTime = currentGroup[0].visitTime;
      const endTime = currentGroup[currentGroup.length - 1].visitTime;
      clusters.push({
        id: generateClusterId(domain, startTime),
        label: buildClusterLabel(currentGroup, domain),
        domain,
        entries: [...currentGroup].reverse(),
        startTime,
        endTime,
      });
    }
  }

  clusters.sort((a, b) => b.endTime - a.endTime);

  mainLogger.debug('JourneyCluster.clusterEntries.done', {
    entryCount: entries.length,
    clusterCount: clusters.length,
  });

  return clusters;
}

export function queryJourneys(
  entries: HistoryEntry[],
  opts: JourneyQueryOptions = {},
): JourneyQueryResult {
  const { query, limit = 50, offset = 0 } = opts;
  let clusters = clusterEntries(entries);

  if (query && query.trim().length > 0) {
    const lower = query.toLowerCase();
    clusters = clusters.filter((cluster) => {
      if (cluster.label.toLowerCase().includes(lower)) return true;
      if (cluster.domain.toLowerCase().includes(lower)) return true;
      return cluster.entries.some(
        (e) =>
          e.title.toLowerCase().includes(lower) ||
          e.url.toLowerCase().includes(lower),
      );
    });
  }

  const totalCount = clusters.length;
  const sliced = clusters.slice(offset, offset + limit);

  mainLogger.debug('JourneyCluster.queryJourneys', {
    query: query ?? '',
    totalCount,
    returned: sliced.length,
  });

  return { clusters: sliced, totalCount };
}

export function removeClusterEntries(
  entries: HistoryEntry[],
  clusterId: string,
): string[] {
  const clusters = clusterEntries(entries);
  const target = clusters.find((c) => c.id === clusterId);
  if (!target) {
    mainLogger.warn('JourneyCluster.removeCluster.notFound', { clusterId });
    return [];
  }
  const ids = target.entries.map((e) => e.id);
  mainLogger.info('JourneyCluster.removeCluster', { clusterId, entryCount: ids.length });
  return ids;
}
