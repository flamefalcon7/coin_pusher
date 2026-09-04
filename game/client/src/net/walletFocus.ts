// Helpers for the mobile WalletConnect round-trip.
//
// WalletConnect's sign-client deep-links back into the wallet app whenever it
// publishes a request (it appends `/wc?requestId=…&sessionTopic=…` to the
// `WALLETCONNECT_DEEPLINK_CHOICE` href AppKit stored at connect time) — but it
// only does so when `document.hasFocus()` is true, otherwise it logs
// "Document does not have focus, skipping deeplink." and the request just sits
// on the relay until the user manually switches back to the wallet.
//
// On Android the session-approval callback fires while the wallet app is still
// in the foreground, so a request sent immediately after connect is exactly the
// case that gets skipped. Waiting for focus before sending fixes that.

interface FocusDoc {
  hasFocus(): boolean;
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
}

interface FocusWin {
  addEventListener(type: string, cb: () => void): void;
  removeEventListener(type: string, cb: () => void): void;
  setInterval(cb: () => void, ms: number): number;
  clearInterval(id: number | undefined): void;
  setTimeout(cb: () => void, ms: number): number;
  clearTimeout(id: number | undefined): void;
}

export interface WaitForPageFocusOptions {
  /** Give up waiting and resolve "timeout" after this long. */
  timeoutMs: number;
  /** Fallback poll cadence in case no focus/visibility event fires. */
  pollMs?: number;
  doc?: FocusDoc;
  win?: FocusWin;
}

export type FocusOutcome = "focused" | "timeout";

/**
 * Resolve as soon as the page has focus (immediately if it already does), or
 * with "timeout" once `timeoutMs` elapses. Never rejects.
 */
export function waitForPageFocus(opts: WaitForPageFocusOptions): Promise<FocusOutcome> {
  const doc = opts.doc ?? document;
  const win = opts.win ?? window;
  const pollMs = opts.pollMs ?? 250;

  if (doc.hasFocus()) return Promise.resolve("focused");

  return new Promise<FocusOutcome>((resolve) => {
    let interval: number | undefined;
    let timer: number | undefined;
    const events: Array<[FocusDoc | FocusWin, string]> = [
      [win, "focus"],
      [win, "pageshow"],
      [doc, "visibilitychange"],
    ];

    const finish = (outcome: FocusOutcome) => {
      win.clearInterval(interval);
      win.clearTimeout(timer);
      for (const [target, type] of events) target.removeEventListener(type, check);
      resolve(outcome);
    };
    const check = () => {
      if (doc.hasFocus()) finish("focused");
    };

    for (const [target, type] of events) target.addEventListener(type, check);
    interval = win.setInterval(check, pollMs);
    timer = win.setTimeout(() => finish("timeout"), opts.timeoutMs);
  });
}

/** Same heuristic AppKit uses to decide it is on a mobile browser. */
export function isMobileBrowser(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;
  const coarse =
    typeof window.matchMedia === "function" && window.matchMedia("(pointer:coarse)").matches;
  return coarse || /Android|webOS|iPhone|iPad|iPod|BlackBerry|Opera Mini/u.test(navigator.userAgent);
}
