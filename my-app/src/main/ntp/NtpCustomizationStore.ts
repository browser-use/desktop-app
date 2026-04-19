/**
 * NtpCustomizationStore — persistence layer for New Tab Page customization.
 * Stores user preferences for background, theme color, shortcuts, and cards
 * in `userData/ntp-customization.json`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { mainLogger } from '../logger';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NtpShortcut {
  id: string;
  name: string;
  url: string;
}

export interface NtpCustomization {
  backgroundType: 'default' | 'solid-color' | 'uploaded-image';
  backgroundColor: string;
  backgroundImageDataUrl: string;

  accentColor: string;
  colorScheme: 'light' | 'dark' | 'system';

  shortcutMode: 'most-visited' | 'custom';
  shortcutsVisible: boolean;
  customShortcuts: NtpShortcut[];

  cardsVisible: boolean;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const FILE_NAME = 'ntp-customization.json';

const DEFAULTS: NtpCustomization = {
  backgroundType: 'default',
  backgroundColor: '#202124',
  backgroundImageDataUrl: '',

  accentColor: '#6D8196',
  colorScheme: 'system',

  shortcutMode: 'most-visited',
  shortcutsVisible: true,
  customShortcuts: [],

  cardsVisible: true,
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class NtpCustomizationStore {
  private filePath: string;
  private cache: NtpCustomization | null = null;

  constructor() {
    let userDataPath: string;
    try {
      userDataPath = app.getPath('userData');
    } catch {
      userDataPath = '/tmp/agentic-browser';
    }
    this.filePath = path.join(userDataPath, FILE_NAME);
    mainLogger.info('NtpCustomizationStore.init', { filePath: this.filePath });
  }

  load(): NtpCustomization {
    if (this.cache) return this.cache;

    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<NtpCustomization>;
      this.cache = { ...DEFAULTS, ...parsed };
      mainLogger.info('NtpCustomizationStore.load.ok', {
        backgroundType: this.cache.backgroundType,
        colorScheme: this.cache.colorScheme,
        shortcutMode: this.cache.shortcutMode,
        customShortcutsCount: this.cache.customShortcuts.length,
      });
    } catch {
      mainLogger.info('NtpCustomizationStore.load.defaults', {
        reason: 'file not found or parse error',
      });
      this.cache = { ...DEFAULTS };
    }

    return this.cache;
  }

  save(patch: Partial<NtpCustomization>): NtpCustomization {
    const current = this.load();
    const merged = { ...current, ...patch };
    this.cache = merged;

    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(merged, null, 2), 'utf-8');
      mainLogger.info('NtpCustomizationStore.save.ok', {
        keys: Object.keys(patch),
      });
    } catch (err) {
      mainLogger.error('NtpCustomizationStore.save.failed', {
        error: (err as Error).message,
      });
    }

    return merged;
  }

  reset(): NtpCustomization {
    this.cache = { ...DEFAULTS };
    try {
      if (fs.existsSync(this.filePath)) {
        fs.unlinkSync(this.filePath);
      }
      mainLogger.info('NtpCustomizationStore.reset.ok');
    } catch (err) {
      mainLogger.warn('NtpCustomizationStore.reset.failed', {
        error: (err as Error).message,
      });
    }
    return this.cache;
  }
}
