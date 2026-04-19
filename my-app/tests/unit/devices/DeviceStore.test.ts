/**
 * DeviceStore unit tests.
 *
 * Tests cover:
 *   - isGranted / getAll / getForApi / getForOrigin queries
 *   - grant: insert new device, upsert existing (apiType, origin, deviceId)
 *   - revoke: returns true/false, only removes exact device
 *   - revokeForOrigin: removes all devices for an origin
 *   - revokeAll: clears all devices
 *   - Persistence round-trip via flushSync
 *   - Invalid JSON / missing file / wrong version starts fresh
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Logger mock only — store takes dataDir directly
vi.mock('../../../src/main/logger', () => ({
  mainLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { DeviceStore } from '../../../src/main/devices/DeviceStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devicestore-'));
  vi.clearAllMocks();
});

function newStore(dir = tmpDir): DeviceStore {
  return new DeviceStore(dir);
}

const USB_A = { apiType: 'usb' as const, origin: 'https://a.com', deviceId: 'device-1', name: 'USB Device', vendorId: '0x1234', productId: '0x5678' };
const HID_A = { apiType: 'hid' as const, origin: 'https://a.com', deviceId: 'hid-1', name: 'HID Device', vendorId: '0xabcd', productId: '0xef01' };
const USB_B = { apiType: 'usb' as const, origin: 'https://b.com', deviceId: 'device-2', name: 'USB Device B', vendorId: '0x4321', productId: '0x8765' };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DeviceStore', () => {
  describe('isGranted()', () => {
    it('returns false for an unknown device', () => {
      expect(newStore().isGranted('usb', 'https://a.com', 'device-1')).toBe(false);
    });

    it('returns true after grant()', () => {
      const store = newStore();
      store.grant(USB_A);
      expect(store.isGranted('usb', 'https://a.com', 'device-1')).toBe(true);
    });

    it('returns false for a different origin with the same deviceId', () => {
      const store = newStore();
      store.grant(USB_A);
      expect(store.isGranted('usb', 'https://other.com', 'device-1')).toBe(false);
    });

    it('returns false after revoke()', () => {
      const store = newStore();
      store.grant(USB_A);
      store.revoke('usb', 'https://a.com', 'device-1');
      expect(store.isGranted('usb', 'https://a.com', 'device-1')).toBe(false);
    });
  });

  describe('getAll()', () => {
    it('returns empty array on fresh store', () => {
      expect(newStore().getAll()).toEqual([]);
    });

    it('returns all granted devices', () => {
      const store = newStore();
      store.grant(USB_A);
      store.grant(HID_A);
      expect(store.getAll()).toHaveLength(2);
    });

    it('returns a copy (mutations do not affect internal state)', () => {
      const store = newStore();
      store.grant(USB_A);
      const list = store.getAll();
      list.pop();
      expect(store.getAll()).toHaveLength(1);
    });
  });

  describe('getForApi()', () => {
    it('returns devices matching the API type', () => {
      const store = newStore();
      store.grant(USB_A);
      store.grant(HID_A);
      store.grant(USB_B);
      const usb = store.getForApi('usb');
      expect(usb).toHaveLength(2);
      usb.forEach((d) => expect(d.apiType).toBe('usb'));
    });

    it('returns empty array for unknown API type', () => {
      expect(newStore().getForApi('serial')).toEqual([]);
    });
  });

  describe('getForOrigin()', () => {
    it('returns devices for the given origin', () => {
      const store = newStore();
      store.grant(USB_A);
      store.grant(HID_A);
      store.grant(USB_B);
      const results = store.getForOrigin('https://a.com');
      expect(results).toHaveLength(2);
      results.forEach((d) => expect(d.origin).toBe('https://a.com'));
    });

    it('returns empty array for unknown origin', () => {
      expect(newStore().getForOrigin('https://unknown.com')).toEqual([]);
    });
  });

  describe('grant()', () => {
    it('inserts a new device record with grantedAt timestamp', () => {
      const store = newStore();
      store.grant(USB_A);
      const all = store.getAll();
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ apiType: 'usb', origin: 'https://a.com', deviceId: 'device-1' });
      expect(typeof all[0].grantedAt).toBe('number');
    });

    it('updates name/vendorId/productId and grantedAt when the same (apiType, origin, deviceId) is granted again', () => {
      const store = newStore();
      store.grant(USB_A);
      const firstGrantedAt = store.getAll()[0].grantedAt;

      vi.spyOn(Date, 'now').mockReturnValueOnce(firstGrantedAt + 5000);
      store.grant({ ...USB_A, name: 'Updated Name', vendorId: '0x9999' });

      const all = store.getAll();
      expect(all).toHaveLength(1); // no duplicate
      expect(all[0].name).toBe('Updated Name');
      expect(all[0].vendorId).toBe('0x9999');
      expect(all[0].grantedAt).toBe(firstGrantedAt + 5000);
    });

    it('different (apiType, origin, deviceId) triples are separate entries', () => {
      const store = newStore();
      store.grant(USB_A);
      store.grant(HID_A);
      store.grant(USB_B);
      expect(store.getAll()).toHaveLength(3);
    });
  });

  describe('revoke()', () => {
    it('returns true when the device was removed', () => {
      const store = newStore();
      store.grant(USB_A);
      expect(store.revoke('usb', 'https://a.com', 'device-1')).toBe(true);
    });

    it('removes the device from the list', () => {
      const store = newStore();
      store.grant(USB_A);
      store.revoke('usb', 'https://a.com', 'device-1');
      expect(store.getAll()).toHaveLength(0);
    });

    it('returns false when device was not found', () => {
      expect(newStore().revoke('usb', 'https://a.com', 'device-1')).toBe(false);
    });

    it('only removes the exact (apiType, origin, deviceId) triple', () => {
      const store = newStore();
      store.grant(USB_A);
      store.grant(HID_A);
      store.revoke('usb', 'https://a.com', 'device-1');
      expect(store.getAll()).toHaveLength(1);
      expect(store.getAll()[0].apiType).toBe('hid');
    });
  });

  describe('revokeForOrigin()', () => {
    it('removes all devices for the given origin', () => {
      const store = newStore();
      store.grant(USB_A);
      store.grant(HID_A);
      store.grant(USB_B);
      store.revokeForOrigin('https://a.com');
      expect(store.getForOrigin('https://a.com')).toHaveLength(0);
      expect(store.getForOrigin('https://b.com')).toHaveLength(1);
    });

    it('is safe when the origin has no devices', () => {
      expect(() => newStore().revokeForOrigin('https://unknown.com')).not.toThrow();
    });
  });

  describe('revokeAll()', () => {
    it('removes all devices', () => {
      const store = newStore();
      store.grant(USB_A);
      store.grant(USB_B);
      store.revokeAll();
      expect(store.getAll()).toHaveLength(0);
    });

    it('is safe on an empty store', () => {
      expect(() => newStore().revokeAll()).not.toThrow();
    });
  });

  describe('persistence', () => {
    it('persists and reloads devices via flushSync', () => {
      const store = newStore();
      store.grant(USB_A);
      store.grant(HID_A);
      store.flushSync();

      const reloaded = newStore();
      expect(reloaded.getAll()).toHaveLength(2);
      expect(reloaded.isGranted('usb', 'https://a.com', 'device-1')).toBe(true);
      expect(reloaded.isGranted('hid', 'https://a.com', 'hid-1')).toBe(true);
    });

    it('starts fresh when file does not exist', () => {
      expect(newStore().getAll()).toEqual([]);
    });

    it('starts fresh with invalid JSON', () => {
      fs.writeFileSync(path.join(tmpDir, 'granted-devices.json'), '{ bad json }', 'utf-8');
      expect(newStore().getAll()).toEqual([]);
    });

    it('starts fresh when version is wrong', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'granted-devices.json'),
        JSON.stringify({ version: 99, devices: [] }),
        'utf-8',
      );
      expect(newStore().getAll()).toEqual([]);
    });
  });
});
