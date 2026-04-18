/**
 * ClearDataDialog — Chrome-parity "Clear browsing data" modal.
 *
 * Two tabs: Basic (3 checkboxes) + Advanced (8 checkboxes total).
 * Time range <select> controls how far back the clears go.
 * "Clear data" button invokes window.settingsAPI.clearBrowsingData(...)
 * — each checkbox maps to its own narrow Electron clear API in the main
 * process, so checking "history" alone does NOT also clear cookies/cache.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Modal } from '../components/base';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// NOTE: the former `hostedApp` entry was removed — it mapped to a silent
// no-op in the main process and presented a false-positive "cleared" state
// to the user. See Issue #200.
type ClearDataType =
  | 'history'
  | 'cookies'
  | 'cache'
  | 'downloads'
  | 'passwords'
  | 'autofill'
  | 'siteSettings';

interface ClearDataResult {
  cleared: ClearDataType[];
  errors: Partial<Record<ClearDataType, string>>;
  notes: Partial<Record<ClearDataType, string>>;
}

interface CheckboxDef {
  type: ClearDataType;
  label: string;
  description: string;
}

interface ClearDataDialogProps {
  open: boolean;
  onClose: () => void;
  onComplete?: (result: ClearDataResult) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TAB_BASIC    = 'basic'    as const;
const TAB_ADVANCED = 'advanced' as const;
type TabId = typeof TAB_BASIC | typeof TAB_ADVANCED;

const MS_HOUR     = 60 * 60 * 1000;
const MS_DAY      = 24 * MS_HOUR;
const MS_WEEK     = 7 * MS_DAY;
const MS_4_WEEKS  = 28 * MS_DAY;
const MS_ALL_TIME = 0;

const TIME_RANGES: Array<{ value: number; label: string }> = [
  { value: MS_HOUR,     label: 'Last hour' },
  { value: MS_DAY,      label: 'Last 24 hours' },
  { value: MS_WEEK,     label: 'Last 7 days' },
  { value: MS_4_WEEKS,  label: 'Last 4 weeks' },
  { value: MS_ALL_TIME, label: 'All time' },
];

const BASIC_CHECKBOXES: CheckboxDef[] = [
  { type: 'history', label: 'Browsing history',           description: 'Clears history from this device.' },
  { type: 'cookies', label: 'Cookies and other site data', description: 'Signs you out of most sites.' },
  { type: 'cache',   label: 'Cached images and files',     description: 'Frees up storage. Pages may load slower next visit.' },
];

const ADVANCED_EXTRA_CHECKBOXES: CheckboxDef[] = [
  { type: 'downloads',    label: 'Download history',              description: 'Clears the download log. Downloaded files are kept.' },
  { type: 'passwords',    label: 'Passwords and other sign-in data', description: 'Clears saved passwords and auth cache.' },
  { type: 'autofill',     label: 'Autofill form data',            description: 'Clears saved form entries.' },
  { type: 'siteSettings', label: 'Site settings',                 description: 'Clears permissions, IndexedDB, service workers, localStorage.' },
];

const DEFAULT_BASIC_SELECTED: Record<ClearDataType, boolean> = {
  history: true,
  cookies: true,
  cache: true,
  downloads: false,
  passwords: false,
  autofill: false,
  siteSettings: false,
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ClearDataDialog(props: ClearDataDialogProps): React.ReactElement {
  const { open, onClose, onComplete } = props;
  const [activeTab, setActiveTab] = useState<TabId>(TAB_BASIC);
  const [timeRangeMs, setTimeRangeMs] = useState<number>(MS_ALL_TIME);
  const [selected, setSelected] = useState<Record<ClearDataType, boolean>>(DEFAULT_BASIC_SELECTED);
  const [busy, setBusy] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setActiveTab(TAB_BASIC);
      setTimeRangeMs(MS_ALL_TIME);
      setSelected(DEFAULT_BASIC_SELECTED);
      setBusy(false);
      setStatusMsg(null);
    }
  }, [open]);

  const visibleCheckboxes = useMemo<CheckboxDef[]>(() => {
    return activeTab === TAB_BASIC
      ? BASIC_CHECKBOXES
      : [...BASIC_CHECKBOXES, ...ADVANCED_EXTRA_CHECKBOXES];
  }, [activeTab]);

  const selectedTypes = useMemo<ClearDataType[]>(() => {
    return visibleCheckboxes.filter((c) => selected[c.type]).map((c) => c.type);
  }, [visibleCheckboxes, selected]);

  const toggle = useCallback((type: ClearDataType) => {
    setSelected((prev) => ({ ...prev, [type]: !prev[type] }));
  }, []);

  const handleClear = useCallback(async () => {
    if (selectedTypes.length === 0) {
      setStatusMsg('Select at least one data type.');
      return;
    }
    setBusy(true);
    setStatusMsg(null);
    try {
      const result = await window.settingsAPI.clearBrowsingData({
        types: selectedTypes,
        timeRangeMs,
      });
      const errorCount = Object.keys(result.errors).length;
      if (errorCount > 0) {
        const firstErr = Object.entries(result.errors)[0];
        setStatusMsg(`Partial clear. ${firstErr?.[0] ?? 'item'}: ${firstErr?.[1] ?? 'failed'}`);
      } else {
        setStatusMsg(`Cleared ${result.cleared.length} item${result.cleared.length === 1 ? '' : 's'}.`);
      }
      onComplete?.(result);
      if (errorCount === 0) {
        // Auto-close on full success after brief confirmation
        setTimeout(() => { onClose(); }, 800);
      }
    } catch (err) {
      setStatusMsg(`Error: ${(err as Error).message ?? 'clear failed'}`);
    } finally {
      setBusy(false);
    }
  }, [selectedTypes, timeRangeMs, onComplete, onClose]);

  if (!open) return <></>;

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title="Clear browsing data"
      size="md"
      closeOnBackdrop={!busy}
    >
      <div className="cdd-body">
        {/* Tab strip */}
        <div className="cdd-tabs" role="tablist" aria-label="Clear data scope">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === TAB_BASIC}
            className={`cdd-tab ${activeTab === TAB_BASIC ? 'cdd-tab--active' : ''}`}
            onClick={() => setActiveTab(TAB_BASIC)}
          >
            Basic
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === TAB_ADVANCED}
            className={`cdd-tab ${activeTab === TAB_ADVANCED ? 'cdd-tab--active' : ''}`}
            onClick={() => setActiveTab(TAB_ADVANCED)}
          >
            Advanced
          </button>
        </div>

        {/* Time range */}
        <div className="cdd-range-row">
          <label htmlFor="cdd-time-range" className="cdd-range-label">
            Time range
          </label>
          <select
            id="cdd-time-range"
            className="cdd-range-select"
            value={timeRangeMs}
            onChange={(e) => setTimeRangeMs(Number(e.target.value))}
            disabled={busy}
          >
            {TIME_RANGES.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </div>

        {/* Checkboxes */}
        <div className="cdd-check-list" role="group" aria-label="Data types to clear">
          {visibleCheckboxes.map((c) => (
            <label key={c.type} className="cdd-check-row">
              <input
                type="checkbox"
                className="cdd-check-box"
                checked={Boolean(selected[c.type])}
                onChange={() => toggle(c.type)}
                disabled={busy}
              />
              <span className="cdd-check-text">
                <span className="cdd-check-label">{c.label}</span>
                <span className="cdd-check-desc">{c.description}</span>
              </span>
            </label>
          ))}
        </div>

        {statusMsg && (
          <p className="cdd-status" role="status" aria-live="polite">
            {statusMsg}
          </p>
        )}
      </div>

      <div className="cdd-footer">
        <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void handleClear()}
          loading={busy}
          disabled={selectedTypes.length === 0}
        >
          Clear data
        </Button>
      </div>
    </Modal>
  );
}

export default ClearDataDialog;
