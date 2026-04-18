/**
 * ProfilePickerApp renderer smoke test.
 *
 * Coverage:
 *   - Mounts without throwing
 *   - Renders the loaded profile list (avatar + name)
 *   - Clicking a profile card calls window.profilePickerAPI.selectProfile
 *   - Clicking "Add" opens the modal
 *   - Submitting the add modal calls window.profilePickerAPI.addProfile
 *   - Clicking "Browse as Guest" calls window.profilePickerAPI.browseAsGuest
 */

// @vitest-environment jsdom

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

// Stub global CSS imports brought in by the components
vi.mock('../../../src/renderer/components/base/components.css', () => ({}));

import { ProfilePickerApp } from '../../../src/renderer/profile-picker/ProfilePickerApp';

const PROFILES_FIXTURE = [
  { id: 'default', name: 'Default', color: '#6366f1', createdAt: new Date('2026-01-01').toISOString() },
  { id: 'work',    name: 'Work',    color: '#22c55e', createdAt: new Date('2026-01-02').toISOString() },
];
const COLORS = ['#6366f1', '#22c55e', '#f97316'];

beforeEach(() => {
  cleanup();
  // window.profilePickerAPI is the IPC bridge exposed by the preload
  Object.defineProperty(window, 'profilePickerAPI', {
    configurable: true,
    writable: true,
    value: {
      getProfiles: vi.fn(() => Promise.resolve({ profiles: PROFILES_FIXTURE, lastSelectedId: 'work' })),
      addProfile: vi.fn(() => Promise.resolve(PROFILES_FIXTURE[1])),
      removeProfile: vi.fn(() => Promise.resolve(true)),
      selectProfile: vi.fn(() => Promise.resolve()),
      browseAsGuest: vi.fn(() => Promise.resolve()),
      getColors: vi.fn(() => Promise.resolve(COLORS)),
    },
  });
});

describe('ProfilePickerApp', () => {
  it('mounts and renders the loaded profiles', async () => {
    render(<ProfilePickerApp />);
    expect(screen.getByText(/loading profiles/i)).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText('Default')).toBeTruthy();
      expect(screen.getByText('Work')).toBeTruthy();
    });
    expect((window as unknown as { profilePickerAPI: { getProfiles: { mock: { calls: unknown[] } } } })
      .profilePickerAPI.getProfiles.mock.calls.length).toBeGreaterThan(0);
  });

  it('clicking a profile card fires selectProfile via IPC', async () => {
    const api = (window as unknown as { profilePickerAPI: { selectProfile: ReturnType<typeof vi.fn> } })
      .profilePickerAPI;

    render(<ProfilePickerApp />);
    await waitFor(() => screen.getByText('Work'));

    fireEvent.click(screen.getByText('Work'));
    expect(api.selectProfile).toHaveBeenCalledWith('work');
  });

  it('clicking Browse as Guest fires browseAsGuest via IPC', async () => {
    const api = (window as unknown as { profilePickerAPI: { browseAsGuest: ReturnType<typeof vi.fn> } })
      .profilePickerAPI;

    render(<ProfilePickerApp />);
    await waitFor(() => screen.getByText('Default'));

    fireEvent.click(screen.getByText(/browse as guest/i));
    expect(api.browseAsGuest).toHaveBeenCalledTimes(1);
  });

  it('clicking Add opens the modal and submitting fires addProfile via IPC', async () => {
    const api = (window as unknown as {
      profilePickerAPI: { addProfile: ReturnType<typeof vi.fn> };
    }).profilePickerAPI;

    render(<ProfilePickerApp />);
    await waitFor(() => screen.getByText('Default'));

    // Click the "Add" card (renders text "Add")
    fireEvent.click(screen.getByText('Add'));

    // Modal opens; type a name
    const nameInput = await screen.findByLabelText(/profile name/i) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'New One' } });

    // Click the Add button (in modal)
    const buttons = screen.getAllByRole('button', { name: 'Add' });
    // The submit button inside the modal is the second "Add" (first is the card)
    const submit = buttons[buttons.length - 1];
    fireEvent.click(submit);

    await waitFor(() => {
      expect(api.addProfile).toHaveBeenCalled();
      expect(api.addProfile.mock.calls[0][0]).toBe('New One');
    });
  });
});
