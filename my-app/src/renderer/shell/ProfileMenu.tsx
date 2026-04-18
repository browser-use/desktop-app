/**
 * ProfileMenu: Chrome-style avatar button + dropdown in the top-right toolbar.
 * Shows current profile, profile list for switching, and add profile action.
 * Wired to real ProfileStore via IPC (profiles:get-all, profiles:get-current,
 * profiles:switch-to, profiles:add).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { SignOutDialog } from './SignOutDialog';

declare const electronAPI: {
  profiles: {
    getAll: () => Promise<{
      profiles: Array<{ id: string; name: string; color: string; createdAt: string }>;
      lastSelectedId: string | null;
    }>;
    getCurrent: () => Promise<{
      profileId: string;
      profile: { id: string; name: string; color: string } | null;
    }>;
    add: (payload: { name: string; color: string }) => Promise<{ id: string; name: string; color: string }>;
    switchTo: (id: string) => Promise<void>;
    getColors: () => Promise<readonly string[]>;
  };
};

interface Profile {
  id: string;
  name: string;
  color: string;
}

interface ProfileMenuProps {
  onDropdownChange?: (open: boolean) => void;
}

function getInitial(name: string): string {
  return (name[0] ?? '?').toUpperCase();
}

export function ProfileMenu({ onDropdownChange }: ProfileMenuProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [currentProfileId, setCurrentProfileId] = useState<string>('default');
  const [colors, setColors] = useState<readonly string[]>([]);
  const [signOutOpen, setSignOutOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);

  const currentProfile = profiles.find((p) => p.id === currentProfileId) ?? profiles[0];

  useEffect(() => {
    console.log('[ProfileMenu] Loading profiles from store');
    Promise.all([
      electronAPI.profiles.getAll(),
      electronAPI.profiles.getCurrent(),
      electronAPI.profiles.getColors(),
    ]).then(([allData, currentData, colorsData]) => {
      console.log('[ProfileMenu] Loaded profiles:', allData.profiles.length, 'current:', currentData.profileId);
      setProfiles(allData.profiles);
      setCurrentProfileId(currentData.profileId);
      setColors(colorsData);
    }).catch((err) => {
      console.error('[ProfileMenu] Failed to load profiles:', err);
    });
  }, []);

  const setOpenState = useCallback((next: boolean) => {
    setOpen(next);
    onDropdownChange?.(next);
  }, [onDropdownChange]);

  const toggle = useCallback(() => {
    console.log('[ProfileMenu] Toggle dropdown, currently:', open ? 'open' : 'closed');
    setOpenState(!open);
  }, [open, setOpenState]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const menu = menuRef.current;
      const btn = btnRef.current;
      if (menu && !menu.contains(e.target as Node) && btn && !btn.contains(e.target as Node)) {
        console.log('[ProfileMenu] Outside click, closing');
        setOpenState(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        console.log('[ProfileMenu] Escape pressed, closing');
        setOpenState(false);
      }
    };
    const t = setTimeout(() => document.addEventListener('mousedown', onDocClick), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, setOpenState]);

  const handleSwitchProfile = useCallback((id: string) => {
    console.log('[ProfileMenu] Switch to profile:', id);
    setOpenState(false);
    electronAPI.profiles.switchTo(id).catch((err) => {
      console.error('[ProfileMenu] Switch failed:', err);
    });
  }, [setOpenState]);

  const handleAddProfile = useCallback(() => {
    const colorIndex = profiles.length % (colors.length || 10);
    const name = `Person ${profiles.length + 1}`;
    const color = colors[colorIndex] ?? '#6366f1';
    console.log('[ProfileMenu] Adding new profile:', name, color);
    setOpenState(false);
    electronAPI.profiles.add({ name, color }).then((newProfile) => {
      console.log('[ProfileMenu] Profile created:', newProfile.id);
      setProfiles((prev) => [...prev, newProfile]);
      electronAPI.profiles.switchTo(newProfile.id).catch((err) => {
        console.error('[ProfileMenu] Switch to new profile failed:', err);
      });
    }).catch((err) => {
      console.error('[ProfileMenu] Add profile failed:', err);
    });
  }, [profiles.length, colors, setOpenState]);

  const handleOpenGuest = useCallback(() => {
    console.log('[ProfileMenu] Opening guest window');
    setOpenState(false);
  }, [setOpenState]);

  const handleSignOut = useCallback(() => {
    console.log('[ProfileMenu] Opening sign out dialog');
    setOpenState(false);
    setSignOutOpen(true);
  }, [setOpenState]);

  if (!currentProfile) {
    return <div className="profile-menu" />;
  }

  return (
    <div className="profile-menu">
      <button
        ref={btnRef}
        type="button"
        className="profile-menu__avatar-btn"
        aria-label="Profile"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={toggle}
        title={currentProfile.name}
      >
        <span
          className="profile-menu__avatar"
          style={{ background: currentProfile.color }}
        >
          {getInitial(currentProfile.name)}
        </span>
      </button>

      {open && (
        <div
          ref={menuRef}
          className="profile-menu__dropdown"
          role="menu"
          aria-label="Profile menu"
        >
          {/* Current profile header */}
          <div className="profile-menu__current">
            <span
              className="profile-menu__current-avatar"
              style={{ background: currentProfile.color }}
            >
              {getInitial(currentProfile.name)}
            </span>
            <div className="profile-menu__current-info">
              <span className="profile-menu__current-name">
                {currentProfile.name}
              </span>
            </div>
          </div>

          <div className="profile-menu__divider" />

          {/* Profile list for quick switch */}
          {profiles.length > 1 && (
            <>
              <div className="profile-menu__section-label">Other profiles</div>
              {profiles
                .filter((p) => p.id !== currentProfileId)
                .map((profile) => (
                  <button
                    key={profile.id}
                    type="button"
                    className="profile-menu__item"
                    role="menuitem"
                    onClick={() => handleSwitchProfile(profile.id)}
                  >
                    <span
                      className="profile-menu__item-avatar"
                      style={{ background: profile.color }}
                    >
                      {getInitial(profile.name)}
                    </span>
                    <span className="profile-menu__item-name">
                      {profile.name}
                    </span>
                  </button>
                ))}
              <div className="profile-menu__divider" />
            </>
          )}

          {/* Add profile + Guest */}
          <button
            type="button"
            className="profile-menu__item"
            role="menuitem"
            onClick={handleAddProfile}
          >
            <span className="profile-menu__item-icon" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M8 3v10M3 8h10"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <span className="profile-menu__item-name">Add</span>
          </button>

          <button
            type="button"
            className="profile-menu__item"
            role="menuitem"
            onClick={handleOpenGuest}
          >
            <span className="profile-menu__item-icon" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <circle
                  cx="8"
                  cy="6"
                  r="2.5"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
                <path
                  d="M3.5 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </span>
            <span className="profile-menu__item-name">Open Guest</span>
          </button>

          <div className="profile-menu__divider" />

          <button
            type="button"
            className="profile-menu__item profile-menu__item--signout"
            role="menuitem"
            onClick={handleSignOut}
          >
            <span className="profile-menu__item-icon" aria-hidden="true">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M6 2H4a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2M10 12l4-4-4-4M14 8H6"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
            <span className="profile-menu__item-name">Sign out</span>
          </button>
        </div>
      )}
    <SignOutDialog open={signOutOpen} onClose={() => setSignOutOpen(false)} />
    </div>
  );
}
