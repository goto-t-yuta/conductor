import type { BrowserBounds } from "./types.js";

export const HIDDEN_BROWSER_BOUNDS: BrowserBounds = Object.freeze({
  x: 0,
  y: 0,
  width: 0,
  height: 0,
  visible: false,
});

function finiteRound(value: number): number {
  return Number.isFinite(value) ? Math.round(value) : 0;
}

/**
 * Normalizes pixel bounds to integer coordinates and canonicalizes hidden bounds
 * so duplicate hide calls from different components always compare equal.
 */
export function normalizeBrowserBounds(bounds: BrowserBounds): BrowserBounds {
  const width = Math.max(0, finiteRound(bounds.width));
  const height = Math.max(0, finiteRound(bounds.height));
  const visible = Boolean(bounds.visible) && width > 10 && height > 10;

  if (!visible) {
    return HIDDEN_BROWSER_BOUNDS;
  }

  return {
    x: finiteRound(bounds.x),
    y: finiteRound(bounds.y),
    width,
    height,
    visible: true,
  };
}

export function areBrowserBoundsEqual(
  a: BrowserBounds | null | undefined,
  b: BrowserBounds | null | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const na = normalizeBrowserBounds(a);
  const nb = normalizeBrowserBounds(b);
  return (
    na.visible === nb.visible &&
    na.x === nb.x &&
    na.y === nb.y &&
    na.width === nb.width &&
    na.height === nb.height
  );
}

export interface BrowserBoundsDispatcher {
  dispatch(bounds: BrowserBounds): boolean;
  getLastBounds(): BrowserBounds | null;
  reset(): void;
}

/**
 * Deduplicates consecutive `browserSetBounds` calls so identical bounds skip IPC.
 */
export function createBrowserBoundsDispatcher(
  send: (bounds: BrowserBounds) => Promise<void> | void,
): BrowserBoundsDispatcher {
  let lastSent: BrowserBounds | null = null;

  return {
    dispatch(bounds: BrowserBounds): boolean {
      const normalized = normalizeBrowserBounds(bounds);
      if (lastSent && areBrowserBoundsEqual(lastSent, normalized)) {
        return false;
      }
      lastSent = normalized;
      void send(normalized);
      return true;
    },
    getLastBounds(): BrowserBounds | null {
      return lastSent;
    },
    reset(): void {
      lastSent = null;
    },
  };
}
