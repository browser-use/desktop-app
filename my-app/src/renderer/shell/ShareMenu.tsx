/**
 * ShareMenu — dropdown popover for sharing the current page.
 *
 * Options: Copy Link, QR Code, Email This Page, Save Page As.
 * Rendered as a positioned dropdown anchored to the share button.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeDialog } from './QRCodeDialog';

interface ShareMenuProps {
  open: boolean;
  onClose: () => void;
  anchorRect: DOMRect | null;
}

declare const electronAPI: {
  share: {
    copyLink: () => Promise<boolean>;
    emailPage: () => Promise<boolean>;
    savePageAs: () => Promise<boolean>;
    getPageInfo: () => Promise<{ url: string; title: string } | null>;
  };
};

export function ShareMenu({ open, onClose, anchorRect }: ShareMenuProps): React.ReactElement | null {
  const menuRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [qrDialogOpen, setQrDialogOpen] = useState(false);
  const [pageInfo, setPageInfo] = useState<{ url: string; title: string } | null>(null);

  useEffect(() => {
    if (open) {
      console.log('[ShareMenu] Opened, fetching page info');
      electronAPI.share.getPageInfo().then((info) => {
        console.log('[ShareMenu] Page info received:', info);
        setPageInfo(info);
      });
      setCopied(false);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open, onClose]);

  const handleCopyLink = useCallback(async () => {
    console.log('[ShareMenu] Copy link clicked');
    const ok = await electronAPI.share.copyLink();
    if (ok) {
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
        onClose();
      }, 1200);
    }
  }, [onClose]);

  const handleQRCode = useCallback(() => {
    console.log('[ShareMenu] QR code clicked');
    setQrDialogOpen(true);
    onClose();
  }, [onClose]);

  const handleEmail = useCallback(async () => {
    console.log('[ShareMenu] Email clicked');
    await electronAPI.share.emailPage();
    onClose();
  }, [onClose]);

  const handleSaveAs = useCallback(async () => {
    console.log('[ShareMenu] Save Page As clicked');
    onClose();
    await electronAPI.share.savePageAs();
  }, [onClose]);

  if (!open && !qrDialogOpen) return null;

  const style: React.CSSProperties = {};
  if (anchorRect) {
    style.position = 'fixed';
    style.top = anchorRect.bottom + 4;
    style.right = window.innerWidth - anchorRect.right;
  }

  return (
    <>
      {open && (
        <div ref={menuRef} className="share-menu" style={style} role="menu" aria-label="Share">
          <div className="share-menu__header">Share this page</div>

          <button
            className="share-menu__item"
            onClick={handleCopyLink}
            role="menuitem"
          >
            <svg className="share-menu__icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="5.5" y="5.5" width="7" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
              <path d="M3.5 10.5v-8a1.5 1.5 0 011.5-1.5h5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
            <span>{copied ? 'Copied!' : 'Copy link'}</span>
          </button>

          <button
            className="share-menu__item"
            onClick={handleQRCode}
            role="menuitem"
          >
            <svg className="share-menu__icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="1" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
              <rect x="10" y="1" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
              <rect x="1" y="10" width="5" height="5" rx="1" stroke="currentColor" strokeWidth="1.2" />
              <rect x="10" y="10" width="2.5" height="2.5" fill="currentColor" />
              <rect x="13.5" y="10" width="1.5" height="1.5" fill="currentColor" />
              <rect x="10" y="13.5" width="1.5" height="1.5" fill="currentColor" />
              <rect x="13.5" y="13.5" width="1.5" height="1.5" fill="currentColor" />
              <rect x="3" y="3" width="1" height="1" fill="currentColor" />
              <rect x="12" y="3" width="1" height="1" fill="currentColor" />
              <rect x="3" y="12" width="1" height="1" fill="currentColor" />
            </svg>
            <span>QR Code</span>
          </button>

          <div className="share-menu__separator" />

          <button
            className="share-menu__item"
            onClick={handleEmail}
            role="menuitem"
          >
            <svg className="share-menu__icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
              <path d="M1.5 4.5l6.5 4.5 6.5-4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>Email this page</span>
            <span className="share-menu__shortcut">⌘⇧I</span>
          </button>

          <button
            className="share-menu__item"
            onClick={handleSaveAs}
            role="menuitem"
          >
            <svg className="share-menu__icon" width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M8 2v8m0 0l-3-3m3 3l3-3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M2.5 11v2a1.5 1.5 0 001.5 1.5h8a1.5 1.5 0 001.5-1.5v-2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
            <span>Save page as…</span>
            <span className="share-menu__shortcut">⌘S</span>
          </button>
        </div>
      )}

      {qrDialogOpen && pageInfo && (
        <QRCodeDialog
          url={pageInfo.url}
          title={pageInfo.title}
          onClose={() => setQrDialogOpen(false)}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// ShareButton — toolbar icon that toggles the share menu
// ---------------------------------------------------------------------------
interface ShareButtonProps {
  onClick: (rect: DOMRect) => void;
}

export function ShareButton({ onClick }: ShareButtonProps): React.ReactElement {
  const btnRef = useRef<HTMLButtonElement>(null);

  const handleClick = useCallback(() => {
    if (btnRef.current) {
      onClick(btnRef.current.getBoundingClientRect());
    }
  }, [onClick]);

  return (
    <button
      ref={btnRef}
      className="toolbar-btn share-btn"
      title="Share this page"
      aria-label="Share this page"
      onClick={handleClick}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path
          d="M4.5 6.5v6a1.5 1.5 0 001.5 1.5h4a1.5 1.5 0 001.5-1.5v-6"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
        <path
          d="M8 1.5v7M5.5 4L8 1.5 10.5 4"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}
