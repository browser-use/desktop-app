/**
 * Per-tab navigation controller: back, forward, reload, navigate.
 * Wraps WebContents navigation methods.
 */

import { WebContentsView } from 'electron';

export class NavigationController {
  private view: WebContentsView;

  constructor(view: WebContentsView) {
    this.view = view;
  }

  navigate(url: string): void {
    console.log(`[NavigationController] Navigating to: ${url}`);
    this.view.webContents.loadURL(url);
  }

  goBack(): void {
    if (this.view.webContents.navigationHistory.canGoBack()) {
      console.log('[NavigationController] Going back');
      this.view.webContents.navigationHistory.goBack();
    }
  }

  goForward(): void {
    if (this.view.webContents.navigationHistory.canGoForward()) {
      console.log('[NavigationController] Going forward');
      this.view.webContents.navigationHistory.goForward();
    }
  }

  reload(): void {
    console.log('[NavigationController] Reloading');
    this.view.webContents.reload();
  }

  reloadIgnoringCache(): void {
    console.log('[NavigationController] Hard reload (ignoring cache)');
    this.view.webContents.reloadIgnoringCache();
  }

  canGoBack(): boolean {
    return this.view.webContents.navigationHistory.canGoBack();
  }

  canGoForward(): boolean {
    return this.view.webContents.navigationHistory.canGoForward();
  }

  getCurrentURL(): string {
    return this.view.webContents.getURL();
  }
}
