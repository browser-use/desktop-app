// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPane } from '../../../src/renderer/hub/SettingsPane';
import type { ActionId, KeyBinding } from '../../../src/renderer/hub/keybindings';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../../src/renderer/hub/ConnectionsPane', () => ({
  ConnectionsPane: (): null => null,
}));

const createPaneBinding: KeyBinding = {
  id: 'action.createPane',
  label: 'New pane',
  keys: ['Cmd+Shift+Space'],
  category: 'Actions',
};

function installElectronApi(): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      shell: { platform: 'darwin' },
      settings: {
        app: {
          getInfo: vi.fn(async () => null),
          getUpdateStatus: vi.fn(async () => ({ status: 'idle' })),
          onUpdateStatus: vi.fn(() => undefined),
          downloadLatest: vi.fn(),
          installUpdate: vi.fn(),
        },
        privacy: {
          get: vi.fn(async () => ({ telemetry: false, telemetryUpdatedAt: null, version: 1 })),
          setTelemetry: vi.fn(async (telemetry: boolean) => ({ telemetry, telemetryUpdatedAt: null, version: 1 })),
          openSystemNotifications: vi.fn(async () => ({ ok: true })),
        },
      },
      on: {},
    },
  });
}

function renderSettingsPane(onUpdateBinding: (id: ActionId, keys: string[]) => Promise<boolean>): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <SettingsPane
        open
        onClose={vi.fn()}
        keybindings={[createPaneBinding]}
        overrides={{}}
        onUpdateBinding={onUpdateBinding}
        onResetBinding={vi.fn()}
        onResetAll={vi.fn()}
        formatShortcut={(shortcut) => shortcut}
      />,
    );
  });
  return { container, root };
}

function keyButton(container: HTMLElement): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>('.settings-pane__key-btn');
  if (!button) throw new Error('Missing key binding button');
  return button;
}

describe('SettingsPane shortcut recorder', () => {
  beforeEach(() => {
    installElectronApi();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('records a global shortcut with the same multi-key space capture used by onboarding', async () => {
    const onUpdateBinding = vi.fn(async () => true);
    const { container, root } = renderSettingsPane(onUpdateBinding);

    act(() => {
      keyButton(container).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(keyButton(container).textContent).toContain('Press key');

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: '\u00A0',
        code: 'Space',
        metaKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(onUpdateBinding).toHaveBeenCalledWith('action.createPane', ['Cmd+Alt+Space']);
    expect(container.querySelector('.settings-pane__key-error')).toBeNull();

    act(() => root.unmount());
  });

  it('shows an unavailable-shortcut error when the global save is rejected', async () => {
    const onUpdateBinding = vi.fn(async () => false);
    const { container, root } = renderSettingsPane(onUpdateBinding);

    act(() => {
      keyButton(container).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', {
        key: ' ',
        code: 'Space',
        metaKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(container.querySelector('.settings-pane__key-error')?.textContent).toBe(
      'That shortcut is unavailable. Choose another one.',
    );

    act(() => root.unmount());
  });
});
