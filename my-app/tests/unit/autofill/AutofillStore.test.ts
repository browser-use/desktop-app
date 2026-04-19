/**
 * AutofillStore unit tests.
 *
 * Tests cover:
 *   - detectCardNetwork: Visa, Mastercard, Amex, Discover, JCB, Diners, unknown
 *   - extractLastFour: strips non-digits, returns last 4 digits
 *   - Address CRUD: saveAddress, listAddresses, getAddress, updateAddress, deleteAddress
 *   - Card CRUD: saveCard (network/lastFour detection), listCards (no numberEncrypted),
 *     revealCardNumber, updateCard, deleteCard
 *   - deleteAll: empties addresses and cards
 *   - Persistence round-trip via flushSync
 *   - Invalid JSON / missing file / wrong version starts fresh
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let uuidCounter = 0;

const { loggerSpy } = vi.hoisted(() => ({
  loggerSpy: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../src/main/logger', () => ({ mainLogger: loggerSpy }));
vi.mock('uuid', () => ({ v4: vi.fn(() => `test-id-${++uuidCounter}`) }));

// Mock safeStorage — use base64 passthrough so card number tests are simple
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => false), // triggers base64 path
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

import { AutofillStore, detectCardNetwork, extractLastFour } from '../../../src/main/autofill/AutofillStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autofillstore-'));
  uuidCounter = 0;
  vi.clearAllMocks();
});

function newStore(dir = tmpDir): AutofillStore {
  return new AutofillStore(dir);
}

const ADDR_FIELDS = {
  firstName: 'John',
  lastName: 'Doe',
  email: 'john@example.com',
  phone: '555-1234',
  company: '',
  addressLine1: '123 Main St',
  addressLine2: '',
  city: 'Springfield',
  state: 'IL',
  zip: '62701',
  country: 'US',
};

// ---------------------------------------------------------------------------
// Pure function tests
// ---------------------------------------------------------------------------

describe('detectCardNetwork', () => {
  it('identifies Visa (starts with 4)', () => {
    expect(detectCardNetwork('4111111111111111')).toBe('Visa');
  });

  it('identifies Mastercard (51-55 prefix)', () => {
    expect(detectCardNetwork('5500005555555559')).toBe('Mastercard');
  });

  it('identifies Mastercard (2221-2720 range)', () => {
    expect(detectCardNetwork('2221000000000009')).toBe('Mastercard');
  });

  it('identifies Amex (starts with 34 or 37)', () => {
    expect(detectCardNetwork('378282246310005')).toBe('Amex');
    expect(detectCardNetwork('371449635398431')).toBe('Amex');
  });

  it('identifies Discover (6011 or 65 prefix)', () => {
    expect(detectCardNetwork('6011111111111117')).toBe('Discover');
    expect(detectCardNetwork('6500000000000002')).toBe('Discover');
  });

  it('identifies JCB (starts with 35)', () => {
    expect(detectCardNetwork('3530111333300000')).toBe('JCB');
  });

  it('identifies Diners Club (300-305, 36, 38)', () => {
    expect(detectCardNetwork('30569309025904')).toBe('Diners');
    expect(detectCardNetwork('38520000023237')).toBe('Diners');
  });

  it('returns "Card" for unknown prefixes', () => {
    expect(detectCardNetwork('1234567890123456')).toBe('Card');
    expect(detectCardNetwork('9999999999999999')).toBe('Card');
  });

  it('strips formatting characters before detection', () => {
    expect(detectCardNetwork('4111 1111 1111 1111')).toBe('Visa');
    expect(detectCardNetwork('4111-1111-1111-1111')).toBe('Visa');
  });
});

describe('extractLastFour', () => {
  it('returns the last 4 digits of a card number', () => {
    expect(extractLastFour('4111111111111111')).toBe('1111');
    expect(extractLastFour('5500005555555559')).toBe('5559');
  });

  it('strips formatting before extracting', () => {
    expect(extractLastFour('4111 1111 1111 1234')).toBe('1234');
  });

  it('returns last 4 digits of a short number', () => {
    expect(extractLastFour('1234')).toBe('1234');
  });
});

// ---------------------------------------------------------------------------
// AutofillStore — Address CRUD
// ---------------------------------------------------------------------------

describe('AutofillStore', () => {
  describe('address CRUD', () => {
    it('listAddresses returns empty array on fresh store', () => {
      expect(newStore().listAddresses()).toEqual([]);
    });

    it('saveAddress inserts and returns a new address with generated id', () => {
      const store = newStore();
      const addr = store.saveAddress(ADDR_FIELDS);
      expect(addr.id).toBe('test-id-1');
      expect(addr.firstName).toBe('John');
      expect(typeof addr.createdAt).toBe('number');
      expect(typeof addr.updatedAt).toBe('number');
    });

    it('listAddresses returns all saved addresses', () => {
      const store = newStore();
      store.saveAddress(ADDR_FIELDS);
      store.saveAddress({ ...ADDR_FIELDS, firstName: 'Jane' });
      const list = store.listAddresses();
      expect(list).toHaveLength(2);
    });

    it('listAddresses returns a copy (no internal state leak)', () => {
      const store = newStore();
      store.saveAddress(ADDR_FIELDS);
      const list = store.listAddresses();
      list.pop();
      expect(store.listAddresses()).toHaveLength(1);
    });

    it('getAddress returns the correct address by id', () => {
      const store = newStore();
      const addr = store.saveAddress(ADDR_FIELDS);
      expect(store.getAddress(addr.id)?.firstName).toBe('John');
    });

    it('getAddress returns null for unknown id', () => {
      expect(newStore().getAddress('bad-id')).toBeNull();
    });

    it('updateAddress patches fields and returns true', () => {
      const store = newStore();
      const addr = store.saveAddress(ADDR_FIELDS);
      const ok = store.updateAddress(addr.id, { city: 'Chicago' });
      expect(ok).toBe(true);
      expect(store.getAddress(addr.id)?.city).toBe('Chicago');
      expect(store.getAddress(addr.id)?.firstName).toBe('John'); // unchanged
    });

    it('updateAddress returns false for unknown id', () => {
      expect(newStore().updateAddress('bad-id', { city: 'X' })).toBe(false);
    });

    it('deleteAddress removes the entry and returns true', () => {
      const store = newStore();
      const addr = store.saveAddress(ADDR_FIELDS);
      expect(store.deleteAddress(addr.id)).toBe(true);
      expect(store.listAddresses()).toHaveLength(0);
    });

    it('deleteAddress returns false for unknown id', () => {
      expect(newStore().deleteAddress('bad-id')).toBe(false);
    });
  });

  describe('card CRUD', () => {
    it('listCards returns empty array on fresh store', () => {
      expect(newStore().listCards()).toEqual([]);
    });

    it('saveCard detects network and extracts last four', () => {
      const store = newStore();
      const card = store.saveCard({
        cardNumber: '4111111111111111',
        nameOnCard: 'John Doe',
        expiryMonth: '12',
        expiryYear: '2030',
      });
      expect(card.network).toBe('Visa');
      expect(card.lastFour).toBe('1111');
    });

    it('listCards omits numberEncrypted field', () => {
      const store = newStore();
      store.saveCard({ cardNumber: '4111111111111111', nameOnCard: 'John', expiryMonth: '12', expiryYear: '2030' });
      const list = store.listCards();
      expect(list[0]).not.toHaveProperty('numberEncrypted');
      expect(list[0].lastFour).toBe('1111');
    });

    it('revealCardNumber returns decrypted card number', () => {
      const store = newStore();
      const card = store.saveCard({ cardNumber: '4111111111111111', nameOnCard: 'John', expiryMonth: '12', expiryYear: '2030' });
      // safeStorage.isEncryptionAvailable() = false → base64 stored
      expect(store.revealCardNumber(card.id)).toBe('4111111111111111');
    });

    it('revealCardNumber returns null for unknown id', () => {
      expect(newStore().revealCardNumber('bad-id')).toBeNull();
    });

    it('updateCard patches fields', () => {
      const store = newStore();
      const card = store.saveCard({ cardNumber: '4111111111111111', nameOnCard: 'Old Name', expiryMonth: '01', expiryYear: '2025' });
      store.updateCard(card.id, { nameOnCard: 'New Name', expiryYear: '2030' });
      const updated = store.listCards().find((c) => c.id === card.id)!;
      expect(updated.nameOnCard).toBe('New Name');
      expect(updated.expiryYear).toBe('2030');
      expect(updated.expiryMonth).toBe('01'); // unchanged
    });

    it('updateCard returns false for unknown id', () => {
      expect(newStore().updateCard('bad-id', { nameOnCard: 'X' })).toBe(false);
    });

    it('deleteCard removes entry and returns true', () => {
      const store = newStore();
      const card = store.saveCard({ cardNumber: '4111111111111111', nameOnCard: 'J', expiryMonth: '1', expiryYear: '2030' });
      expect(store.deleteCard(card.id)).toBe(true);
      expect(store.listCards()).toHaveLength(0);
    });

    it('deleteCard returns false for unknown id', () => {
      expect(newStore().deleteCard('bad-id')).toBe(false);
    });
  });

  describe('deleteAll()', () => {
    it('clears addresses and cards', () => {
      const store = newStore();
      store.saveAddress(ADDR_FIELDS);
      store.saveCard({ cardNumber: '4111111111111111', nameOnCard: 'J', expiryMonth: '1', expiryYear: '2030' });
      store.deleteAll();
      expect(store.listAddresses()).toHaveLength(0);
      expect(store.listCards()).toHaveLength(0);
    });
  });

  describe('persistence', () => {
    it('persists and reloads addresses via flushSync', () => {
      const store = newStore();
      store.saveAddress(ADDR_FIELDS);
      store.flushSync();

      const reloaded = newStore();
      expect(reloaded.listAddresses()).toHaveLength(1);
      expect(reloaded.listAddresses()[0].firstName).toBe('John');
    });

    it('starts fresh when file does not exist', () => {
      const store = newStore();
      expect(store.listAddresses()).toHaveLength(0);
      expect(store.listCards()).toHaveLength(0);
    });

    it('starts fresh with invalid JSON', () => {
      fs.writeFileSync(path.join(tmpDir, 'autofill.json'), '{ bad json }', 'utf-8');
      const store = newStore();
      expect(store.listAddresses()).toHaveLength(0);
    });

    it('starts fresh when version is wrong', () => {
      fs.writeFileSync(
        path.join(tmpDir, 'autofill.json'),
        JSON.stringify({ version: 99, addresses: [], cards: [] }),
        'utf-8',
      );
      const store = newStore();
      expect(store.listAddresses()).toHaveLength(0);
    });
  });
});
