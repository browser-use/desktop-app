/**
 * QRCodeDialog — modal that displays a QR code for the current page URL.
 *
 * Uses the `qrcode` package to generate QR code as a data URL, rendered
 * on a canvas-backed image. Supports copy-to-clipboard and download.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Modal } from '../components/base/Modal';

interface QRCodeDialogProps {
  url: string;
  title: string;
  onClose: () => void;
}

// QR code size in pixels
const QR_SIZE = 200;
const QR_MARGIN = 2;

export function QRCodeDialog({ url, title, onClose }: QRCodeDialogProps): React.ReactElement {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    console.log('[QRCodeDialog] Generating QR code for:', url);
    generateQrCode(url)
      .then((dataUrl) => {
        console.log('[QRCodeDialog] QR code generated successfully');
        setQrDataUrl(dataUrl);
      })
      .catch((err) => {
        console.error('[QRCodeDialog] QR code generation failed:', err);
        setError('Failed to generate QR code');
      });
  }, [url]);

  const handleCopyLink = useCallback(() => {
    console.log('[QRCodeDialog] Copying link to clipboard');
    navigator.clipboard.writeText(url).then(() => {
      setCopyFeedback(true);
      setTimeout(() => setCopyFeedback(false), 1500);
    });
  }, [url]);

  const handleDownload = useCallback(() => {
    if (!qrDataUrl) return;
    console.log('[QRCodeDialog] Downloading QR code image');
    const a = document.createElement('a');
    const safeName = (title || 'qrcode').replace(/[/\\?%*:|"<>]/g, '-').slice(0, 80);
    a.download = `${safeName}-qr.png`;
    a.href = qrDataUrl;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [qrDataUrl, title]);

  return (
    <Modal open onClose={onClose} size="sm" title="QR Code">
      <div className="qr-dialog">
        <div className="qr-dialog__preview">
          {error && <div className="qr-dialog__error">{error}</div>}
          {!error && !qrDataUrl && <div className="qr-dialog__loading">Generating…</div>}
          {qrDataUrl && (
            <img
              src={qrDataUrl}
              alt={`QR code for ${url}`}
              width={QR_SIZE}
              height={QR_SIZE}
              className="qr-dialog__image"
            />
          )}
        </div>

        <div className="qr-dialog__url" title={url}>
          {url}
        </div>

        <canvas ref={canvasRef} style={{ display: 'none' }} />

        <div className="qr-dialog__actions">
          <button className="qr-dialog__btn qr-dialog__btn--secondary" onClick={handleCopyLink}>
            {copyFeedback ? 'Copied!' : 'Copy link'}
          </button>
          <button
            className="qr-dialog__btn qr-dialog__btn--primary"
            onClick={handleDownload}
            disabled={!qrDataUrl}
          >
            Download
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// QR Code generation using canvas
// ---------------------------------------------------------------------------

async function generateQrCode(text: string): Promise<string> {
  // Dynamic import — qrcode is bundled by Vite
  const QRCode = await import('qrcode');
  const dataUrl = await QRCode.toDataURL(text, {
    width: QR_SIZE,
    margin: QR_MARGIN,
    color: {
      dark: '#000000',
      light: '#ffffff',
    },
    errorCorrectionLevel: 'M',
  });
  return dataUrl;
}
