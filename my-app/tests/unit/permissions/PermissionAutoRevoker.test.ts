/**
 * PermissionAutoRevoker unit tests.
 *
 * Tests cover:
 *   - scan(): skips non-allow records
 *   - scan(): skips permission types outside AUTO_REVOKE_PERMISSION_TYPES
 *   - scan(): includes sites with no history (never visited)
 *   - scan(): includes sites inactive for >90 days
 *   - scan(): excludes sites visited within last 90 days
 *   - scan(): skips opted-out (origin, permissionType) pairs
 *   - scan(): computes daysSinceVisit correctly
 *   - applyRevoke(): revokes 'allow' permissions by setting to 'deny'
 *   - applyRevoke(): skips non-allow records and returns correct count
 *   - optOut() / clearOptOut(): controls the opt-out set
 *   - getOptedOutKeys(): returns all opted-out keys
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../../src/main/logger', () => ({
  mainLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { PermissionAutoRevoker } from '../../../src/main/permissions/PermissionAutoRevoker';
import type { PermissionRecord, PermissionState, PermissionType } from '../../../src/main/permissions/PermissionStore';
import type { HistoryEntry } from '../../../src/main/history/HistoryStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000; // fixed "now"
const DAY_MS = 24 * 60 * 60 * 1000;
const INACTIVE_THRESHOLD_MS = 90 * DAY_MS;

function makeRecord(
  origin: string,
  permissionType: PermissionType,
  state: PermissionState,
  updatedAt = NOW - DAY_MS,
): PermissionRecord {
  return { origin, permissionType, state, updatedAt };
}

function makeHistoryEntry(url: string, visitTime: number): HistoryEntry {
  return { id: url, url, title: url, visitTime, favicon: null };
}

function makeRevoker(
  records: PermissionRecord[],
  historyEntries: HistoryEntry[],
) {
  const storeMock = {
    getAllRecords: vi.fn(() => records),
    getSitePermission: vi.fn((origin: string, type: PermissionType) => {
      const rec = records.find((r) => r.origin === origin && r.permissionType === type);
      return rec?.state ?? null;
    }),
    setSitePermission: vi.fn((origin: string, type: PermissionType, state: PermissionState) => {
      const rec = records.find((r) => r.origin === origin && r.permissionType === type);
      if (rec) rec.state = state;
    }),
  };

  const historyMock = {
    getAll: vi.fn(() => historyEntries),
  };

  return {
    revoker: new PermissionAutoRevoker({
      store: storeMock as never,
      historyStore: historyMock as never,
    }),
    storeMock,
    historyMock,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PermissionAutoRevoker', () => {
  describe('scan()', () => {
    it('returns empty candidates when there are no records', () => {
      const { revoker } = makeRevoker([], []);
      const { candidates } = revoker.scan();
      expect(candidates).toHaveLength(0);
    });

    it('skips records with state !== allow', () => {
      const records = [
        makeRecord('https://a.com', 'notifications', 'deny'),
        makeRecord('https://b.com', 'notifications', 'ask'),
      ];
      const { revoker } = makeRevoker(records, []);
      expect(revoker.scan().candidates).toHaveLength(0);
    });

    it('skips permission types not in AUTO_REVOKE list (e.g. clipboard-read)', () => {
      const records = [makeRecord('https://a.com', 'clipboard-read' as PermissionType, 'allow')];
      const { revoker } = makeRevoker(records, []);
      expect(revoker.scan().candidates).toHaveLength(0);
    });

    it('includes a site with no history entry (never visited → inactive)', () => {
      const records = [makeRecord('https://a.com', 'notifications', 'allow')];
      const { revoker } = makeRevoker(records, []);
      const { candidates } = revoker.scan();
      expect(candidates).toHaveLength(1);
      expect(candidates[0].origin).toBe('https://a.com');
      expect(candidates[0].lastVisit).toBeNull();
      expect(candidates[0].daysSinceVisit).toBeNull();
    });

    it('includes a site whose last visit was >90 days ago', () => {
      const records = [makeRecord('https://a.com', 'geolocation', 'allow')];
      const history = [makeHistoryEntry('https://a.com/page', NOW - INACTIVE_THRESHOLD_MS - 1)];
      const { revoker } = makeRevoker(records, history);
      expect(revoker.scan().candidates).toHaveLength(1);
    });

    it('excludes a site visited within the last 90 days', () => {
      const records = [makeRecord('https://a.com', 'notifications', 'allow')];
      const history = [makeHistoryEntry('https://a.com/', NOW - DAY_MS)];
      const { revoker } = makeRevoker(records, history);
      expect(revoker.scan().candidates).toHaveLength(0);
    });

    it('uses the most recent visit among multiple history entries', () => {
      const records = [makeRecord('https://a.com', 'camera', 'allow')];
      const history = [
        makeHistoryEntry('https://a.com/old', NOW - 200 * DAY_MS),
        makeHistoryEntry('https://a.com/recent', NOW - 30 * DAY_MS), // within 90d
      ];
      const { revoker } = makeRevoker(records, history);
      // Recent visit → should be excluded
      expect(revoker.scan().candidates).toHaveLength(0);
    });

    it('computes daysSinceVisit correctly', () => {
      const records = [makeRecord('https://a.com', 'microphone', 'allow')];
      const history = [makeHistoryEntry('https://a.com/', NOW - 120 * DAY_MS)];
      const { revoker } = makeRevoker(records, history);
      const [candidate] = revoker.scan().candidates;
      expect(candidate.daysSinceVisit).toBe(120);
    });

    it('includes candidates for all auto-revoke permission types', () => {
      const records = [
        makeRecord('https://a.com', 'notifications', 'allow'),
        makeRecord('https://a.com', 'geolocation', 'allow'),
        makeRecord('https://a.com', 'camera', 'allow'),
        makeRecord('https://a.com', 'microphone', 'allow'),
      ];
      const { revoker } = makeRevoker(records, []);
      expect(revoker.scan().candidates).toHaveLength(4);
    });

    it('skips opted-out (origin, permissionType) pairs', () => {
      const records = [
        makeRecord('https://a.com', 'notifications', 'allow'),
        makeRecord('https://a.com', 'geolocation', 'allow'),
      ];
      const { revoker } = makeRevoker(records, []);
      revoker.optOut('https://a.com', 'notifications');
      const { candidates } = revoker.scan();
      expect(candidates).toHaveLength(1);
      expect(candidates[0].permissionType).toBe('geolocation');
    });

    it('includes the scannedAt timestamp', () => {
      const { revoker } = makeRevoker([], []);
      const { scannedAt } = revoker.scan();
      expect(scannedAt).toBe(NOW);
    });
  });

  describe('applyRevoke()', () => {
    it('revokes allow permissions and returns count', () => {
      const records = [
        makeRecord('https://a.com', 'notifications', 'allow'),
        makeRecord('https://b.com', 'geolocation', 'allow'),
      ];
      const { revoker, storeMock } = makeRevoker(records, []);
      const count = revoker.applyRevoke([
        { origin: 'https://a.com', permissionType: 'notifications' },
        { origin: 'https://b.com', permissionType: 'geolocation' },
      ]);
      expect(count).toBe(2);
      expect(storeMock.setSitePermission).toHaveBeenCalledTimes(2);
      expect(storeMock.setSitePermission).toHaveBeenCalledWith('https://a.com', 'notifications', 'deny');
      expect(storeMock.setSitePermission).toHaveBeenCalledWith('https://b.com', 'geolocation', 'deny');
    });

    it('skips non-allow records and does not count them', () => {
      const records = [makeRecord('https://a.com', 'notifications', 'deny')];
      const { revoker, storeMock } = makeRevoker(records, []);
      const count = revoker.applyRevoke([{ origin: 'https://a.com', permissionType: 'notifications' }]);
      expect(count).toBe(0);
      expect(storeMock.setSitePermission).not.toHaveBeenCalled();
    });

    it('returns 0 for empty revocations list', () => {
      const { revoker } = makeRevoker([], []);
      expect(revoker.applyRevoke([])).toBe(0);
    });
  });

  describe('optOut() / clearOptOut()', () => {
    it('optOut prevents the pair from appearing in scan results', () => {
      const records = [makeRecord('https://a.com', 'notifications', 'allow')];
      const { revoker } = makeRevoker(records, []);
      revoker.optOut('https://a.com', 'notifications');
      expect(revoker.scan().candidates).toHaveLength(0);
    });

    it('clearOptOut makes the pair appear again in scan', () => {
      const records = [makeRecord('https://a.com', 'notifications', 'allow')];
      const { revoker } = makeRevoker(records, []);
      revoker.optOut('https://a.com', 'notifications');
      revoker.clearOptOut('https://a.com', 'notifications');
      expect(revoker.scan().candidates).toHaveLength(1);
    });

    it('optOut is idempotent', () => {
      const { revoker } = makeRevoker([], []);
      revoker.optOut('https://a.com', 'notifications');
      revoker.optOut('https://a.com', 'notifications');
      expect(revoker.getOptedOutKeys()).toHaveLength(1);
    });
  });

  describe('getOptedOutKeys()', () => {
    it('returns empty array initially', () => {
      const { revoker } = makeRevoker([], []);
      expect(revoker.getOptedOutKeys()).toEqual([]);
    });

    it('returns keys in "origin::type" format', () => {
      const { revoker } = makeRevoker([], []);
      revoker.optOut('https://a.com', 'notifications');
      revoker.optOut('https://b.com', 'geolocation');
      const keys = revoker.getOptedOutKeys();
      expect(keys).toContain('https://a.com::notifications');
      expect(keys).toContain('https://b.com::geolocation');
    });
  });
});
