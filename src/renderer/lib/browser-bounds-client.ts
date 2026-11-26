import {
  HIDDEN_BROWSER_BOUNDS,
  createBrowserBoundsDispatcher,
  type BrowserBoundsDispatcher,
} from "../../shared/browser-bounds.js";
import type { BrowserBounds } from "../../shared/types.js";

type BoundsSender = (bounds: BrowserBounds) => Promise<void> | void;

const dispatcherBySender = new WeakMap<BoundsSender, BrowserBoundsDispatcher>();

function getDispatcher(sender: BoundsSender): BrowserBoundsDispatcher {
  let dispatcher = dispatcherBySender.get(sender);
  if (!dispatcher) {
    dispatcher = createBrowserBoundsDispatcher(sender);
    dispatcherBySender.set(sender, dispatcher);
  }
  return dispatcher;
}

interface GlobalWithConductor {
  window?: {
    conductor?: {
      browserSetBounds?: BoundsSender;
    };
  };
}

/**
 * Sends normalized `browserSetBounds` IPC only when bounds have actually changed
 * since the last call across any renderer component (`App`, `UnifiedRightPane`,
 * `InAppBrowserPane`). State is scoped per `window.conductor.browserSetBounds`
 * function reference so unit-test mocks stay cleanly isolated.
 */
export function syncBrowserBounds(bounds: BrowserBounds): boolean {
  const win = (globalThis as unknown as GlobalWithConductor).window;
  const sender = win?.conductor?.browserSetBounds;
  if (!sender) {
    return false;
  }
  return getDispatcher(sender).dispatch(bounds);
}

export function hideBrowserBounds(): boolean {
  return syncBrowserBounds(HIDDEN_BROWSER_BOUNDS);
}
