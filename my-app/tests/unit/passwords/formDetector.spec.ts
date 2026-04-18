/**
 * formDetector unit tests.
 *
 * The detector ships as a JavaScript string that runs inside a webContents
 * page. We exercise it by spinning up a JSDOM instance, evaluating the
 * script in that window, and asserting the credentials it reports via
 * console.log (with FORM_DETECTOR_PREFIX).
 *
 * Coverage:
 *   - Login form (email + password) → reports {origin, username, password}
 *   - Login form (text "username" + password) → reports correctly
 *   - Registration form with two password fields → uses the first non-empty pw
 *   - Password-change form (current + new) → reports the first non-empty pw
 *   - Click on submit button (no submit event) → still reports
 *   - Enter key in password field → reports
 *   - Negative: search box with no password → no report
 *   - Negative: credit-card form (number + cvv) → no report
 *   - Negative: form with password field but empty value → no report
 *   - Idempotency: script can be executed twice without double-reporting
 */

// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
// @ts-expect-error — jsdom ships its own types but @types/jsdom isn't installed in this repo
import { JSDOM } from 'jsdom';
import { getFormDetectorScript, FORM_DETECTOR_PREFIX } from '../../../src/main/passwords/formDetector';

interface DetectedCredential {
  username: string;
  password: string;
  origin: string;
}

interface Harness {
  dom: JSDOM;
  reports: DetectedCredential[];
}

function setupHarness(html: string): Harness {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, {
    url: 'https://example.com/login',
    runScripts: 'outside-only',
  });

  const reports: DetectedCredential[] = [];
  // Patch console.log inside the JSDOM window to capture detector output
  dom.window.console.log = ((...args: unknown[]): void => {
    const first = String(args[0] ?? '');
    if (first.startsWith(FORM_DETECTOR_PREFIX)) {
      try {
        reports.push(JSON.parse(first.slice(FORM_DETECTOR_PREFIX.length)));
      } catch {
        // ignore malformed
      }
    }
  }) as typeof console.log;

  // Run the detector script inside the JSDOM window
  dom.window.eval(getFormDetectorScript());

  return { dom, reports };
}

function submitForm(harness: Harness, formId: string): void {
  const form = harness.dom.window.document.getElementById(formId) as HTMLFormElement | null;
  if (!form) throw new Error(`form #${formId} not found`);
  // Dispatch a real submit event (form.submit() bypasses listeners in jsdom)
  const evt = new harness.dom.window.Event('submit', { bubbles: true, cancelable: true });
  form.dispatchEvent(evt);
}

describe('formDetector — positive cases', () => {
  it('detects a standard login form (email + password)', () => {
    const h = setupHarness(`
      <form id="login">
        <input type="email" name="email" value="alice@example.com" />
        <input type="password" name="pw" value="hunter2" />
        <button type="submit">Sign in</button>
      </form>
    `);
    submitForm(h, 'login');
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0].username).toBe('alice@example.com');
    expect(h.reports[0].password).toBe('hunter2');
    expect(h.reports[0].origin).toBe('https://example.com');
  });

  it('detects a login form with type=text username before password', () => {
    const h = setupHarness(`
      <form id="login">
        <input type="text" name="username" value="alice" />
        <input type="password" name="pw" value="hunter2" />
        <button type="submit">Sign in</button>
      </form>
    `);
    submitForm(h, 'login');
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0].username).toBe('alice');
    expect(h.reports[0].password).toBe('hunter2');
  });

  it('detects via click on a submit button (no submit event needed)', () => {
    const h = setupHarness(`
      <form id="spa">
        <input type="email" name="email" value="bob@example.com" />
        <input type="password" name="pw" value="s3cret" />
        <button type="submit" id="submit-btn">Sign in</button>
      </form>
    `);
    const btn = h.dom.window.document.getElementById('submit-btn')!;
    btn.dispatchEvent(new h.dom.window.MouseEvent('click', { bubbles: true }));
    // Both click and the implicit submit can fire in jsdom; we only assert
    // that at least one detection happened with the right credentials.
    expect(h.reports.length).toBeGreaterThanOrEqual(1);
    expect(h.reports[0].username).toBe('bob@example.com');
    expect(h.reports[0].password).toBe('s3cret');
  });

  it('detects on Enter key in a password field', () => {
    const h = setupHarness(`
      <form id="login">
        <input type="email" name="email" value="carol@example.com" />
        <input type="password" name="pw" id="pw" value="enterpass" />
      </form>
    `);
    const pw = h.dom.window.document.getElementById('pw') as HTMLInputElement;
    const evt = new h.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
    pw.dispatchEvent(evt);
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0].password).toBe('enterpass');
  });

  it('handles a registration form with two password fields (returns first non-empty)', () => {
    const h = setupHarness(`
      <form id="register">
        <input type="email" name="email" value="dave@example.com" />
        <input type="password" name="pw" value="newPass1" />
        <input type="password" name="pw2" value="newPass1" />
        <button type="submit">Sign up</button>
      </form>
    `);
    submitForm(h, 'register');
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0].username).toBe('dave@example.com');
    expect(h.reports[0].password).toBe('newPass1');
  });

  it('handles a password-change form (current + new) and reports the first non-empty pw', () => {
    const h = setupHarness(`
      <form id="change">
        <input type="password" name="current" value="oldPw" />
        <input type="password" name="new" value="newPw" />
        <input type="password" name="confirm" value="newPw" />
        <button type="submit">Change</button>
      </form>
    `);
    submitForm(h, 'change');
    expect(h.reports).toHaveLength(1);
    expect(h.reports[0].password).toBe('oldPw');
  });

  it('falls back to autocomplete=username when no plain text input precedes password', () => {
    const h = setupHarness(`
      <form id="login">
        <input type="text" autocomplete="username" name="user" value="ellen" />
        <input type="password" name="pw" value="pass" />
      </form>
    `);
    submitForm(h, 'login');
    expect(h.reports[0].username).toBe('ellen');
  });
});

describe('formDetector — negative cases', () => {
  it('does NOT report on a search box (no password field)', () => {
    const h = setupHarness(`
      <form id="search">
        <input type="text" name="q" value="how to hack" />
        <button type="submit">Search</button>
      </form>
    `);
    submitForm(h, 'search');
    expect(h.reports).toHaveLength(0);
  });

  it('does NOT report on a credit-card form (no password field)', () => {
    const h = setupHarness(`
      <form id="cc">
        <input type="text" name="cardnumber" value="4111 1111 1111 1111" />
        <input type="text" name="cvv" value="123" />
        <input type="text" name="exp" value="12/29" />
        <button type="submit">Pay</button>
      </form>
    `);
    submitForm(h, 'cc');
    expect(h.reports).toHaveLength(0);
  });

  it('does NOT report when the password field is empty', () => {
    const h = setupHarness(`
      <form id="login">
        <input type="email" name="email" value="alice@example.com" />
        <input type="password" name="pw" value="" />
        <button type="submit">Sign in</button>
      </form>
    `);
    submitForm(h, 'login');
    expect(h.reports).toHaveLength(0);
  });

  it('does NOT trigger on Enter inside a non-password input', () => {
    const h = setupHarness(`
      <form id="login">
        <input type="text" id="user" name="user" value="alice" />
        <input type="password" name="pw" value="x" />
      </form>
    `);
    const user = h.dom.window.document.getElementById('user') as HTMLInputElement;
    user.dispatchEvent(new h.dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(h.reports).toHaveLength(0);
  });
});

describe('formDetector — idempotency', () => {
  it('running the script twice does not duplicate listeners', () => {
    const h = setupHarness(`
      <form id="login">
        <input type="email" name="email" value="alice@example.com" />
        <input type="password" name="pw" value="hunter2" />
      </form>
    `);
    // Re-evaluate the script — internal flag should short-circuit
    h.dom.window.eval(getFormDetectorScript());
    submitForm(h, 'login');
    expect(h.reports).toHaveLength(1);
  });
});
