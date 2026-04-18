/**
 * ProfileStore — persists browser profiles to userData/profiles.json.
 *
 * Each profile has a name, color, and optional avatar initial.
 * Also stores the "show profile picker on launch" preference.
 *
 * Write is atomic: data is written to a .tmp file then renamed.
 * File location: ${app.getPath('userData')}/profiles.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { mainLogger } from '../logger';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const PROFILES_FILE_NAME = 'profiles.json';

export const PROFILE_COLORS = [
  '#6366f1', // indigo
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#f43f5e', // rose
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#14b8a6', // teal
  '#06b6d4', // cyan
  '#3b82f6', // blue
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Profile {
  id: string;
  name: string;
  color: string;
  createdAt: string;
}

export interface ProfilesData {
  profiles: Profile[];
  showPickerOnLaunch: boolean;
  lastSelectedProfileId: string | null;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

function createDefaultData(): ProfilesData {
  return {
    profiles: [
      {
        id: 'default',
        name: 'Default',
        color: PROFILE_COLORS[0],
        createdAt: new Date().toISOString(),
      },
    ],
    showPickerOnLaunch: false,
    lastSelectedProfileId: 'default',
  };
}

// ---------------------------------------------------------------------------
// ProfileStore
// ---------------------------------------------------------------------------

export class ProfileStore {
  private readonly filePath: string;
  private readonly tmpPath: string;
  private cache: ProfilesData | null = null;

  constructor(userDataPath?: string) {
    const dir = userDataPath ?? (() => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { app } = require('electron') as typeof import('electron');
        return app.getPath('userData');
      } catch {
        return '/tmp/agentic-browser';
      }
    })();

    this.filePath = path.join(dir, PROFILES_FILE_NAME);
    this.tmpPath = path.join(dir, `profiles.tmp.${process.pid}`);

    mainLogger.debug('ProfileStore.init', { filePath: this.filePath });
  }

  load(): ProfilesData {
    if (this.cache) return this.cache;

    mainLogger.debug('ProfileStore.load', { filePath: this.filePath });
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as ProfilesData;
      if (!Array.isArray(data.profiles) || data.profiles.length === 0) {
        mainLogger.warn('ProfileStore.load.invalid', { msg: 'Empty or invalid profiles array, using defaults' });
        this.cache = createDefaultData();
        return this.cache;
      }
      this.cache = data;
      mainLogger.debug('ProfileStore.load.ok', {
        profileCount: data.profiles.length,
        showPicker: data.showPickerOnLaunch,
      });
      return data;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        mainLogger.debug('ProfileStore.load.notFound', { msg: 'Creating default profiles' });
      } else {
        mainLogger.warn('ProfileStore.load.parseError', { error: (err as Error).message });
      }
      const defaults = createDefaultData();
      this.cache = defaults;
      this.save(defaults);
      return defaults;
    }
  }

  save(data: ProfilesData): void {
    mainLogger.debug('ProfileStore.save', {
      profileCount: data.profiles.length,
      showPicker: data.showPickerOnLaunch,
    });

    const serialised = JSON.stringify(data, null, 2);

    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.tmpPath, serialised, 'utf-8');
      fs.renameSync(this.tmpPath, this.filePath);
      this.cache = data;
      mainLogger.debug('ProfileStore.save.ok');
    } catch (err) {
      mainLogger.error('ProfileStore.save.failed', {
        error: (err as Error).message,
        stack: (err as Error).stack,
      });
      throw err;
    }
  }

  getProfiles(): Profile[] {
    return this.load().profiles;
  }

  addProfile(name: string, color: string): Profile {
    const data = this.load();
    const profile: Profile = {
      id: `profile-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      color,
      createdAt: new Date().toISOString(),
    };
    data.profiles.push(profile);
    this.save(data);
    mainLogger.info('ProfileStore.addProfile', { id: profile.id, name: profile.name, color });
    return profile;
  }

  removeProfile(id: string): boolean {
    const data = this.load();
    const idx = data.profiles.findIndex((p) => p.id === id);
    if (idx === -1) return false;
    if (data.profiles.length <= 1) {
      mainLogger.warn('ProfileStore.removeProfile.denied', { msg: 'Cannot remove last profile' });
      return false;
    }
    data.profiles.splice(idx, 1);
    if (data.lastSelectedProfileId === id) {
      data.lastSelectedProfileId = data.profiles[0]?.id ?? null;
    }
    this.save(data);
    mainLogger.info('ProfileStore.removeProfile', { id });
    return true;
  }

  getShowPickerOnLaunch(): boolean {
    return this.load().showPickerOnLaunch;
  }

  setShowPickerOnLaunch(show: boolean): void {
    const data = this.load();
    data.showPickerOnLaunch = show;
    this.save(data);
    mainLogger.info('ProfileStore.setShowPickerOnLaunch', { show });
  }

  setLastSelectedProfileId(id: string): void {
    const data = this.load();
    data.lastSelectedProfileId = id;
    this.save(data);
  }

  getLastSelectedProfileId(): string | null {
    return this.load().lastSelectedProfileId;
  }
}
