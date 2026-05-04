import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import kimiLogo from './kimi-color.svg';
import minimaxLogo from './minimax-color.svg';
import qwenLogo from './qwen-color.svg';

interface BrowserCodeProvider {
  id: string;
  name: string;
  defaultModel: string;
  models: Array<{ id: string; label: string }>;
}

interface BrowserCodeStatus {
  present: boolean;
  providerId?: string;
  model?: string;
  masked?: string;
  installed?: { installed: boolean; version?: string; error?: string };
  providers: BrowserCodeProvider[];
}

interface BrowserCodeModelPickerProps {
  visible: boolean;
  compact?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function ChevronIcon(): React.ReactElement {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
      <path d="M2.5 4l2.5 2.5L7.5 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ProviderMark({ providerId }: { providerId: string }): React.ReactElement {
  if (providerId === 'minimax') {
    return <img className="browsercode-model-picker__logo" src={minimaxLogo} alt="" />;
  }
  if (providerId === 'alibaba') {
    return <img className="browsercode-model-picker__logo" src={qwenLogo} alt="" />;
  }
  if (providerId === 'moonshotai' || providerId === 'kimi-for-coding') {
    return <img className="browsercode-model-picker__logo" src={kimiLogo} alt="" />;
  }
  return <span className="browsercode-model-picker__mark">{providerId.slice(0, 1).toUpperCase()}</span>;
}

function modelLabel(providers: BrowserCodeProvider[], modelId: string | undefined): string {
  if (!modelId) return 'Model';
  for (const provider of providers) {
    const match = provider.models.find((model) => model.id === modelId);
    if (match) return match.label;
  }
  return modelId.includes('/') ? modelId.split('/').pop() ?? modelId : modelId;
}

export function BrowserCodeModelPicker({
  visible,
  compact = false,
  onOpenChange,
}: BrowserCodeModelPickerProps): React.ReactElement | null {
  const [status, setStatus] = useState<BrowserCodeStatus>({ present: false, providers: [] });
  const [open, setOpen] = useState(false);
  const [savingModel, setSavingModel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => { onOpenChange?.(open); }, [open, onOpenChange]);

  const refresh = useCallback(async () => {
    const api = window.electronAPI?.settings?.browserCode;
    if (!api) return;
    try {
      const next = await api.getStatus();
      setStatus(next);
      setError(null);
      console.info('[BrowserCodeModelPicker] status', {
        present: next.present,
        providerId: next.providerId,
        model: next.model,
        installed: next.installed?.installed,
      });
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      console.warn('[BrowserCodeModelPicker] status.failed', { error: message });
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    void refresh();
  }, [refresh, visible]);

  useEffect(() => {
    if (!visible) setOpen(false);
  }, [visible]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const currentProvider = useMemo(() => {
    const providerId = status.providerId ?? status.providers[0]?.id;
    return status.providers.find((provider) => provider.id === providerId) ?? status.providers[0];
  }, [status.providerId, status.providers]);

  const currentModel = status.model ?? currentProvider?.defaultModel;
  const currentModelLabel = modelLabel(status.providers, currentModel);
  const canSwitchModels = status.present && status.installed?.installed !== false && Boolean(status.providerId);

  const selectModel = useCallback(async (providerId: string, model: string) => {
    const api = window.electronAPI?.settings?.browserCode;
    if (!api) return;
    if (!status.present || status.providerId !== providerId) {
      setOpen(false);
      await window.electronAPI?.settings?.open?.();
      return;
    }
    setSavingModel(model);
    setError(null);
    try {
      console.info('[BrowserCodeModelPicker] model.save.request', { providerId, model });
      await api.save({ providerId, model, apiKey: '' });
      console.info('[BrowserCodeModelPicker] model.save.ok', { providerId, model });
      await refresh();
      setOpen(false);
    } catch (err) {
      const message = (err as Error).message;
      setError(message);
      console.warn('[BrowserCodeModelPicker] model.save.failed', { providerId, model, error: message });
    } finally {
      setSavingModel(null);
    }
  }, [refresh, status.present, status.providerId]);

  if (!visible) return null;

  return (
    <div className={`browsercode-model-picker${compact ? ' browsercode-model-picker--compact' : ''}`} ref={menuRef}>
      <button
        type="button"
        className="browsercode-model-picker__toggle"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        title={status.present ? `BrowserCode model: ${currentModelLabel}` : 'Set up BrowserCode model'}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {currentProvider && <ProviderMark providerId={currentProvider.id} />}
        <span className="browsercode-model-picker__label">{currentModelLabel}</span>
        <ChevronIcon />
      </button>
      {open && (
        <div className="browsercode-model-picker__menu" role="menu">
          {!canSwitchModels && (
            <button
              type="button"
              className="browsercode-model-picker__setup"
              onClick={() => {
                setOpen(false);
                void window.electronAPI?.settings?.open?.();
              }}
              role="menuitem"
            >
              Set up BrowserCode in Settings
            </button>
          )}
          {status.providers.map((provider) => (
            <div className="browsercode-model-picker__group" key={provider.id}>
              <div className="browsercode-model-picker__group-label">
                <ProviderMark providerId={provider.id} />
                <span>{provider.name}</span>
              </div>
              {provider.models.map((model) => {
                const isActive = status.providerId === provider.id && currentModel === model.id;
                const isConfiguredProvider = status.providerId === provider.id;
                return (
                  <button
                    key={model.id}
                    type="button"
                    className={`browsercode-model-picker__item${isActive ? ' browsercode-model-picker__item--active' : ''}`}
                    onClick={() => { void selectModel(provider.id, model.id); }}
                    disabled={savingModel === model.id}
                    role="menuitem"
                    title={isConfiguredProvider ? `Use ${model.label}` : `Add a ${provider.name} key in Settings`}
                  >
                    <span className="browsercode-model-picker__item-name">{model.label}</span>
                    {isActive && <span className="browsercode-model-picker__check">✓</span>}
                    {!isConfiguredProvider && <span className="browsercode-model-picker__locked">Settings</span>}
                  </button>
                );
              })}
            </div>
          ))}
          {error && <div className="browsercode-model-picker__error">{error}</div>}
        </div>
      )}
    </div>
  );
}
