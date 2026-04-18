/**
 * @vitest-environment jsdom
 *
 * ExtensionsApp renderer smoke tests — backfilled coverage for
 * chrome://extensions (non-mv3 surface; PR #119 owns the mv3 page).
 *
 * Tests cover:
 *   - mounts and renders the title + dev-mode toggle
 *   - shows EmptyState when no extensions are loaded
 *   - renders an extension card per record
 *   - clicking the per-card toggle calls extensionsAPI.disable / enable
 *   - clicking the Remove button opens the confirmation modal
 *   - toggling developer mode reveals the dev toolbar
 *   - close button calls extensionsAPI.closeWindow
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';

import { ExtensionsApp } from '../../../src/renderer/extensions/ExtensionsApp';

interface FakeExtension {
  id: string;
  name: string;
  version: string;
  description: string;
  path: string;
  enabled: boolean;
  permissions: string[];
  hostPermissions: string[];
  hostAccess: 'all-sites' | 'specific-sites' | 'on-click';
  icons: Record<string, string>;
}

function makeAPI(initial: FakeExtension[] = [], devModeStart = false) {
  let extensions = initial.map((e) => ({ ...e }));
  let devMode = devModeStart;
  return {
    listExtensions: vi.fn(async () => extensions.map((e) => ({ ...e }))),
    enableExtension: vi.fn(async (id: string) => {
      const e = extensions.find((x) => x.id === id);
      if (e) e.enabled = true;
    }),
    disableExtension: vi.fn(async (id: string) => {
      const e = extensions.find((x) => x.id === id);
      if (e) e.enabled = false;
    }),
    removeExtension: vi.fn(async (id: string) => {
      extensions = extensions.filter((e) => e.id !== id);
    }),
    getExtensionDetails: vi.fn(async (id: string) =>
      extensions.find((e) => e.id === id) ?? null,
    ),
    loadUnpacked: vi.fn(async () => null),
    updateExtension: vi.fn(async () => undefined),
    setHostAccess: vi.fn(async () => undefined),
    getDeveloperMode: vi.fn(async () => devMode),
    setDeveloperMode: vi.fn(async (enabled: boolean) => {
      devMode = enabled;
    }),
    pickDirectory: vi.fn(async () => null),
    closeWindow: vi.fn(),
  };
}

function makeExt(over: Partial<FakeExtension> = {}): FakeExtension {
  return {
    id: 'ext-1',
    name: 'Sample Extension',
    version: '1.0.0',
    description: 'A sample',
    path: '/path/to/ext',
    enabled: true,
    permissions: [],
    hostPermissions: [],
    hostAccess: 'on-click',
    icons: {},
    ...over,
  };
}

describe('ExtensionsApp', () => {
  beforeEach(() => {
    (window as unknown as { extensionsAPI?: unknown }).extensionsAPI = undefined;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('mounts and renders the Extensions title once loaded', async () => {
    (window as unknown as { extensionsAPI: ReturnType<typeof makeAPI> }).extensionsAPI = makeAPI();
    render(<ExtensionsApp />);
    expect(await screen.findByRole('heading', { level: 1, name: /^extensions$/i })).toBeTruthy();
  });

  it('shows the empty state when there are no extensions', async () => {
    (window as unknown as { extensionsAPI: ReturnType<typeof makeAPI> }).extensionsAPI = makeAPI();
    render(<ExtensionsApp />);
    expect(await screen.findByText(/no extensions installed/i)).toBeTruthy();
  });

  it('renders one card per extension record', async () => {
    const api = makeAPI([
      makeExt({ id: 'a', name: 'Alpha' }),
      makeExt({ id: 'b', name: 'Beta' }),
    ]);
    (window as unknown as { extensionsAPI: typeof api }).extensionsAPI = api;
    render(<ExtensionsApp />);
    expect(await screen.findByText('Alpha')).toBeTruthy();
    expect(await screen.findByText('Beta')).toBeTruthy();
  });

  it('clicking the card toggle calls disableExtension when currently enabled', async () => {
    const api = makeAPI([makeExt({ id: 'a', name: 'Alpha', enabled: true })]);
    (window as unknown as { extensionsAPI: typeof api }).extensionsAPI = api;
    render(<ExtensionsApp />);
    const toggle = await screen.findByRole('switch', { name: /disable alpha/i });
    await act(async () => {
      fireEvent.click(toggle);
    });
    await waitFor(() => expect(api.disableExtension).toHaveBeenCalledWith('a'));
  });

  it('clicking the card toggle calls enableExtension when currently disabled', async () => {
    const api = makeAPI([makeExt({ id: 'a', name: 'Alpha', enabled: false })]);
    (window as unknown as { extensionsAPI: typeof api }).extensionsAPI = api;
    render(<ExtensionsApp />);
    const toggle = await screen.findByRole('switch', { name: /enable alpha/i });
    await act(async () => {
      fireEvent.click(toggle);
    });
    await waitFor(() => expect(api.enableExtension).toHaveBeenCalledWith('a'));
  });

  it('clicking Remove opens the confirmation modal', async () => {
    const api = makeAPI([makeExt({ id: 'a', name: 'Alpha' })]);
    (window as unknown as { extensionsAPI: typeof api }).extensionsAPI = api;
    render(<ExtensionsApp />);
    const removeBtn = await screen.findByRole('button', { name: /remove/i });
    fireEvent.click(removeBtn);
    // The modal body mentions "Remove <strong>Alpha</strong>?"
    expect(await screen.findByText(/remove extension/i)).toBeTruthy();
  });

  it('toggling developer mode calls setDeveloperMode and reveals the dev toolbar', async () => {
    const api = makeAPI([], false);
    (window as unknown as { extensionsAPI: typeof api }).extensionsAPI = api;
    render(<ExtensionsApp />);

    const devToggle = await screen.findByRole('switch', { name: /toggle developer mode/i });
    await act(async () => {
      fireEvent.click(devToggle);
    });
    await waitFor(() => expect(api.setDeveloperMode).toHaveBeenCalledWith(true));
    expect(await screen.findByRole('button', { name: /load unpacked/i })).toBeTruthy();
  });

  it('clicking the close button calls extensionsAPI.closeWindow', async () => {
    const api = makeAPI();
    (window as unknown as { extensionsAPI: typeof api }).extensionsAPI = api;
    render(<ExtensionsApp />);
    const closeBtn = await screen.findByRole('button', { name: /close extensions/i });
    fireEvent.click(closeBtn);
    expect(api.closeWindow).toHaveBeenCalled();
  });

  it('opens the host-access dropdown and persists a new selection', async () => {
    const api = makeAPI([makeExt({ id: 'a', name: 'Alpha', hostAccess: 'on-click' })]);
    (window as unknown as { extensionsAPI: typeof api }).extensionsAPI = api;
    render(<ExtensionsApp />);

    // The button label is the current value: "On click"
    const btn = await screen.findByRole('button', { name: /on click/i });
    fireEvent.click(btn);
    const allSitesOpt = await screen.findByRole('option', { name: /on all sites/i });
    await act(async () => {
      fireEvent.click(allSitesOpt);
    });
    await waitFor(() => expect(api.setHostAccess).toHaveBeenCalledWith('a', 'all-sites'));
  });
});
