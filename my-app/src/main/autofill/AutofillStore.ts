/**
 * AutofillStore — encrypted storage for addresses and payment cards.
 *
 * Stores addresses and cards in userData/autofill.json.
 * Card numbers are encrypted via Electron's safeStorage API (same as PasswordStore).
 * CVC is NEVER stored — it is collected at fill-time and discarded immediately.
 *
 * Follows the PasswordStore pattern: debounced atomic writes, in-memory state.
 */

import { app, safeStorage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';
import { mainLogger } from '../logger';

const AUTOFILL_FILE_NAME = 'autofill.json';
const DEBOUNCE_MS = 300;

// ---------------------------------------------------------------------------
// Address types
// ---------------------------------------------------------------------------

export interface SavedAddress {
  id: string;
  fullName: string;
  company: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  phone: string;
  email: string;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Payment card types
// ---------------------------------------------------------------------------

export interface SavedCard {
  id: string;
  /** Cardholder name */
  nameOnCard: string;
  /** Encrypted card number (full PAN) */
  numberEncrypted: string;
  /** Last 4 digits — stored in plaintext for display */
  lastFour: string;
  /** Card network inferred from first digit (Visa, Mastercard, etc.) */
  network: string;
  /** MM */
  expiryMonth: string;
  /** YYYY */
  expiryYear: string;
  /** Optional nickname chosen by the user */
  nickname: string;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Persisted shape
// ---------------------------------------------------------------------------

export interface PersistedAutofill {
  version: 1;
  addresses: SavedAddress[];
  cards: SavedCard[];
}

function makeEmpty(): PersistedAutofill {
  return { version: 1, addresses: [], cards: [] };
}

function getAutofillPath(): string {
  return path.join(app.getPath('userData'), AUTOFILL_FILE_NAME);
}

// ---------------------------------------------------------------------------
// Card network detection
// ---------------------------------------------------------------------------

const NETWORK_PREFIXES: Array<{ prefix: RegExp; name: string }> = [
  { prefix: /^4/, name: 'Visa' },
  { prefix: /^5[1-5]/, name: 'Mastercard' },
  { prefix: /^2[2-7]/, name: 'Mastercard' },
  { prefix: /^3[47]/, name: 'Amex' },
  { prefix: /^6(?:011|5)/, name: 'Discover' },
  { prefix: /^3(?:0[0-5]|[68])/, name: 'Diners' },
  { prefix: /^35/, name: 'JCB' },
];

export function detectCardNetwork(number: string): string {
  const cleaned = number.replace(/\D/g, '');
  for (const { prefix, name } of NETWORK_PREFIXES) {
    if (prefix.test(cleaned)) return name;
  }
  return 'Card';
}

export function extractLastFour(number: string): string {
  const cleaned = number.replace(/\D/g, '');
  return cleaned.slice(-4);
}

// ---------------------------------------------------------------------------
// AutofillStore
// ---------------------------------------------------------------------------

export class AutofillStore {
  private state: PersistedAutofill;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor() {
    this.state = this.load();
    mainLogger.info('AutofillStore.init', {
      addressCount: this.state.addresses.length,
      cardCount: this.state.cards.length,
    });
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  private load(): PersistedAutofill {
    try {
      const raw = fs.readFileSync(getAutofillPath(), 'utf-8');
      const parsed = JSON.parse(raw) as PersistedAutofill;
      if (parsed.version !== 1) {
        mainLogger.warn('AutofillStore.load.invalid', { msg: 'Resetting autofill store' });
        return makeEmpty();
      }
      mainLogger.info('AutofillStore.load.ok', {
        addressCount: parsed.addresses?.length ?? 0,
        cardCount: parsed.cards?.length ?? 0,
      });
      return {
        version: 1,
        addresses: parsed.addresses ?? [],
        cards: parsed.cards ?? [],
      };
    } catch {
      mainLogger.info('AutofillStore.load.fresh', { msg: 'No autofill.json — starting fresh' });
      return makeEmpty();
    }
  }

  private schedulePersist(): void {
    this.dirty = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flushSync(), DEBOUNCE_MS);
  }

  flushSync(): void {
    if (!this.dirty) return;
    try {
      fs.writeFileSync(getAutofillPath(), JSON.stringify(this.state, null, 2), 'utf-8');
      mainLogger.info('AutofillStore.flushSync.ok');
    } catch (err) {
      mainLogger.error('AutofillStore.flushSync.failed', { error: (err as Error).message });
    }
    this.dirty = false;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Encryption helpers (cards only)
  // -------------------------------------------------------------------------

  private encryptCardNumber(plaintext: string): string {
    if (!safeStorage.isEncryptionAvailable()) {
      mainLogger.warn('AutofillStore.encryptCardNumber.unavailable', {
        msg: 'safeStorage encryption not available, storing base64 only',
      });
      return Buffer.from(plaintext, 'utf-8').toString('base64');
    }
    return safeStorage.encryptString(plaintext).toString('base64');
  }

  private decryptCardNumber(encrypted: string): string {
    const buf = Buffer.from(encrypted, 'base64');
    if (!safeStorage.isEncryptionAvailable()) {
      mainLogger.warn('AutofillStore.decryptCardNumber.unavailable');
      return buf.toString('utf-8');
    }
    try {
      return safeStorage.decryptString(buf);
    } catch (err) {
      mainLogger.error('AutofillStore.decryptCardNumber.failed', { error: (err as Error).message });
      return '';
    }
  }

  // -------------------------------------------------------------------------
  // Address CRUD
  // -------------------------------------------------------------------------

  saveAddress(fields: Omit<SavedAddress, 'id' | 'createdAt' | 'updatedAt'>): SavedAddress {
    const now = Date.now();
    const addr: SavedAddress = {
      id: uuidv4(),
      ...fields,
      createdAt: now,
      updatedAt: now,
    };
    this.state.addresses.push(addr);
    this.schedulePersist();
    mainLogger.info('AutofillStore.saveAddress', { id: addr.id, country: addr.country });
    return addr;
  }

  listAddresses(): SavedAddress[] {
    return [...this.state.addresses];
  }

  getAddress(id: string): SavedAddress | null {
    return this.state.addresses.find((a) => a.id === id) ?? null;
  }

  updateAddress(id: string, patch: Partial<Omit<SavedAddress, 'id' | 'createdAt'>>): boolean {
    const addr = this.state.addresses.find((a) => a.id === id);
    if (!addr) {
      mainLogger.warn('AutofillStore.updateAddress.notFound', { id });
      return false;
    }
    Object.assign(addr, patch, { updatedAt: Date.now() });
    this.schedulePersist();
    mainLogger.info('AutofillStore.updateAddress.ok', { id });
    return true;
  }

  deleteAddress(id: string): boolean {
    const idx = this.state.addresses.findIndex((a) => a.id === id);
    if (idx === -1) {
      mainLogger.warn('AutofillStore.deleteAddress.notFound', { id });
      return false;
    }
    this.state.addresses.splice(idx, 1);
    this.schedulePersist();
    mainLogger.info('AutofillStore.deleteAddress.ok', { id });
    return true;
  }

  // -------------------------------------------------------------------------
  // Card CRUD — card numbers are encrypted at rest; CVC is never stored
  // -------------------------------------------------------------------------

  saveCard(fields: {
    nameOnCard: string;
    cardNumber: string;
    expiryMonth: string;
    expiryYear: string;
    nickname: string;
  }): Omit<SavedCard, 'numberEncrypted'> {
    const now = Date.now();
    const card: SavedCard = {
      id: uuidv4(),
      nameOnCard: fields.nameOnCard,
      numberEncrypted: this.encryptCardNumber(fields.cardNumber),
      lastFour: extractLastFour(fields.cardNumber),
      network: detectCardNetwork(fields.cardNumber),
      expiryMonth: fields.expiryMonth,
      expiryYear: fields.expiryYear,
      nickname: fields.nickname,
      createdAt: now,
      updatedAt: now,
    };
    this.state.cards.push(card);
    this.schedulePersist();
    mainLogger.info('AutofillStore.saveCard', {
      id: card.id,
      network: card.network,
      lastFour: card.lastFour,
    });
    const { numberEncrypted, ...safe } = card;
    return safe;
  }

  listCards(): Array<Omit<SavedCard, 'numberEncrypted'>> {
    return this.state.cards.map(({ numberEncrypted, ...rest }) => rest);
  }

  /** Reveal the full card number — caller must have already passed CVC/biometric gate. */
  revealCardNumber(id: string): string | null {
    const card = this.state.cards.find((c) => c.id === id);
    if (!card) {
      mainLogger.warn('AutofillStore.revealCardNumber.notFound', { id });
      return null;
    }
    mainLogger.info('AutofillStore.revealCardNumber', { id, lastFour: card.lastFour });
    return this.decryptCardNumber(card.numberEncrypted);
  }

  updateCard(id: string, patch: {
    nameOnCard?: string;
    cardNumber?: string;
    expiryMonth?: string;
    expiryYear?: string;
    nickname?: string;
  }): boolean {
    const card = this.state.cards.find((c) => c.id === id);
    if (!card) {
      mainLogger.warn('AutofillStore.updateCard.notFound', { id });
      return false;
    }
    if (patch.nameOnCard !== undefined) card.nameOnCard = patch.nameOnCard;
    if (patch.expiryMonth !== undefined) card.expiryMonth = patch.expiryMonth;
    if (patch.expiryYear !== undefined) card.expiryYear = patch.expiryYear;
    if (patch.nickname !== undefined) card.nickname = patch.nickname;
    if (patch.cardNumber !== undefined) {
      card.numberEncrypted = this.encryptCardNumber(patch.cardNumber);
      card.lastFour = extractLastFour(patch.cardNumber);
      card.network = detectCardNetwork(patch.cardNumber);
    }
    card.updatedAt = Date.now();
    this.schedulePersist();
    mainLogger.info('AutofillStore.updateCard.ok', { id });
    return true;
  }

  deleteCard(id: string): boolean {
    const idx = this.state.cards.findIndex((c) => c.id === id);
    if (idx === -1) {
      mainLogger.warn('AutofillStore.deleteCard.notFound', { id });
      return false;
    }
    this.state.cards.splice(idx, 1);
    this.schedulePersist();
    mainLogger.info('AutofillStore.deleteCard.ok', { id });
    return true;
  }

  // -------------------------------------------------------------------------
  // Batch clear (for "Clear browsing data")
  // -------------------------------------------------------------------------

  deleteAll(): void {
    this.state.addresses = [];
    this.state.cards = [];
    this.schedulePersist();
    mainLogger.info('AutofillStore.deleteAll');
  }
}
