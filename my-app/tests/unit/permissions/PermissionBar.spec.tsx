/**
 * PermissionBar (permission infobar) renderer smoke test.
 *
 * Coverage:
 *   - Mounts; renders nothing when there is no pending prompt
 *   - Receives a prompt via electronAPI.on.permissionPrompt and renders it
 *   - Renders Allow / Allow this time / Never buttons
 *   - Click Allow → electronAPI.permissions.respond('id', 'allow')
 *   - Click Never → electronAPI.permissions.respond('id', 'deny')
 *   - Quiet UI variant (only Allow + dismiss)
 *   - Dismiss button → electronAPI.permissions.dismiss('id')
 */

// @vitest-environment jsdom

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';

import { PermissionBar } from '../../../src/renderer/shell/PermissionBar';

interface ElectronAPIShape {
  permissions: {
    respond: ReturnType<typeof vi.fn>;
    dismiss: ReturnType<typeof vi.fn>;
  };
  on: {
    permissionPrompt: ReturnType<typeof vi.fn>;
    permissionPromptDismiss: ReturnType<typeof vi.fn>;
  };
  __fire: (data: unknown) => void;
  __dismiss: (id: string) => void;
}

beforeEach(() => {
  cleanup();
  let promptListener: ((data: unknown) => void) | null = null;
  let dismissListener: ((id: string) => void) | null = null;

  const api: ElectronAPIShape = {
    permissions: {
      respond: vi.fn(() => Promise.resolve()),
      dismiss: vi.fn(() => Promise.resolve()),
    },
    on: {
      permissionPrompt: vi.fn((cb: (data: unknown) => void) => {
        promptListener = cb;
        return () => { promptListener = null; };
      }),
      permissionPromptDismiss: vi.fn((cb: (id: string) => void) => {
        dismissListener = cb;
        return () => { dismissListener = null; };
      }),
    },
    __fire: (data: unknown) => promptListener?.(data),
    __dismiss: (id: string) => dismissListener?.(id),
  };

  // Component looks up `electronAPI` as a global identifier; assign on globalThis.
  (globalThis as unknown as { electronAPI: ElectronAPIShape }).electronAPI = api;
});

function getApi(): ElectronAPIShape {
  return (globalThis as unknown as { electronAPI: ElectronAPIShape }).electronAPI;
}

describe('PermissionBar', () => {
  it('renders nothing when there are no pending prompts', () => {
    const { container } = render(<PermissionBar activeTabId="tab-1" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a prompt for the active tab with Allow / Allow this time / Never', () => {
    render(<PermissionBar activeTabId="tab-1" />);

    act(() => {
      getApi().__fire({
        id: 'p1',
        tabId: 'tab-1',
        origin: 'https://example.com',
        permissionType: 'geolocation',
        isMainFrame: true,
      });
    });

    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /allow this time/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Never' })).toBeTruthy();
  });

  it('does NOT render a prompt for a non-active tab', () => {
    render(<PermissionBar activeTabId="tab-1" />);
    act(() => {
      getApi().__fire({
        id: 'p2',
        tabId: 'tab-99',
        origin: 'https://example.com',
        permissionType: 'geolocation',
        isMainFrame: true,
      });
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('clicking Allow fires electronAPI.permissions.respond("id", "allow")', () => {
    render(<PermissionBar activeTabId="tab-1" />);
    act(() => {
      getApi().__fire({
        id: 'p3',
        tabId: 'tab-1',
        origin: 'https://example.com',
        permissionType: 'geolocation',
        isMainFrame: true,
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(getApi().permissions.respond).toHaveBeenCalledWith('p3', 'allow');
  });

  it('clicking Never fires electronAPI.permissions.respond("id", "deny")', () => {
    render(<PermissionBar activeTabId="tab-1" />);
    act(() => {
      getApi().__fire({
        id: 'p4',
        tabId: 'tab-1',
        origin: 'https://example.com',
        permissionType: 'geolocation',
        isMainFrame: true,
      });
    });
    fireEvent.click(screen.getByRole('button', { name: 'Never' }));
    expect(getApi().permissions.respond).toHaveBeenCalledWith('p4', 'deny');
  });

  it('clicking Allow this time fires "allow-once"', () => {
    render(<PermissionBar activeTabId="tab-1" />);
    act(() => {
      getApi().__fire({
        id: 'p5',
        tabId: 'tab-1',
        origin: 'https://example.com',
        permissionType: 'geolocation',
        isMainFrame: true,
      });
    });
    fireEvent.click(screen.getByRole('button', { name: /allow this time/i }));
    expect(getApi().permissions.respond).toHaveBeenCalledWith('p5', 'allow-once');
  });

  it('dismiss button fires electronAPI.permissions.dismiss("id")', () => {
    render(<PermissionBar activeTabId="tab-1" />);
    act(() => {
      getApi().__fire({
        id: 'p6',
        tabId: 'tab-1',
        origin: 'https://example.com',
        permissionType: 'geolocation',
        isMainFrame: true,
      });
    });
    fireEvent.click(screen.getByRole('button', { name: /dismiss permission prompt/i }));
    expect(getApi().permissions.dismiss).toHaveBeenCalledWith('p6');
  });

  it('quiet UI variant renders only Allow + dismiss (no "Never" / "Allow this time")', () => {
    render(<PermissionBar activeTabId="tab-1" />);
    act(() => {
      getApi().__fire({
        id: 'p7',
        tabId: 'tab-1',
        origin: 'https://example.com',
        permissionType: 'notifications',
        isMainFrame: true,
        quietUI: true,
      });
    });
    expect(screen.getByText(/blocked/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Never' })).toBeNull();
    expect(screen.queryByRole('button', { name: /allow this time/i })).toBeNull();
  });
});
