// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVimKeys } from '../../../src/renderer/hub/useVimKeys';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function installElectronApi(accelerator = 'CommandOrControl+Alt+Space'): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      shell: { platform: 'darwin' },
      hotkeys: {
        getGlobalCmdbar: vi.fn(async () => accelerator),
        setGlobalCmdbar: vi.fn(async (next: string) => ({ ok: true, accelerator: next })),
      },
      on: {
        globalCmdbarChanged: vi.fn(() => undefined),
      },
      pill: {
        toggle: vi.fn(),
      },
    },
  });
}

function Harness({ onCreatePane }: { onCreatePane: () => void }): React.ReactElement {
  useVimKeys({ 'action.createPane': onCreatePane });
  return <input data-testid="task-input" />;
}

function renderHarness(onCreatePane: () => void): { container: HTMLDivElement; root: Root } {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<Harness onCreatePane={onCreatePane} />);
  });
  return { container, root };
}

describe('useVimKeys global command fallback', () => {
  beforeEach(() => {
    installElectronApi();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('fires the configured command shortcut even when an input has focus', async () => {
    const onCreatePane = vi.fn();
    const { container, root } = renderHarness(onCreatePane);
    const input = container.querySelector<HTMLInputElement>('[data-testid="task-input"]');
    if (!input) throw new Error('Missing input');

    await act(async () => {
      await Promise.resolve();
    });
    input.focus();

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: '\u00A0',
        code: 'Space',
        metaKey: true,
        altKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });

    expect(onCreatePane).toHaveBeenCalledTimes(1);

    act(() => root.unmount());
  });
});
