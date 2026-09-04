import { describe, expect, it, vi } from "vitest";
import { waitForPageFocus } from "./walletFocus";

function makeEnv(initialFocus: boolean) {
  let focused = initialFocus;
  const listeners = new Map<string, Set<() => void>>();
  const on = (type: string, cb: () => void) => {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type)!.add(cb);
  };
  const off = (type: string, cb: () => void) => listeners.get(type)?.delete(cb);
  const doc = {
    hasFocus: () => focused,
    addEventListener: on,
    removeEventListener: off,
  };
  const win = {
    addEventListener: on,
    removeEventListener: off,
    // Node timers return objects, the DOM-typed helper expects numbers; the
    // cast is safe because the ids only round-trip back into these fakes.
    setInterval: vi.fn((cb: () => void, ms: number) => setInterval(cb, ms) as unknown as number),
    clearInterval: vi.fn((id: number | undefined) =>
      clearInterval(id as unknown as ReturnType<typeof setInterval>)
    ),
    setTimeout: vi.fn((cb: () => void, ms: number) => setTimeout(cb, ms) as unknown as number),
    clearTimeout: vi.fn((id: number | undefined) =>
      clearTimeout(id as unknown as ReturnType<typeof setTimeout>)
    ),
  };
  const fire = (type: string) => listeners.get(type)?.forEach((cb) => cb());
  const listenerCount = () => [...listeners.values()].reduce((n, s) => n + s.size, 0);
  return { doc, win, fire, listenerCount, setFocus: (f: boolean) => (focused = f) };
}

describe("waitForPageFocus", () => {
  it("resolves immediately when the page already has focus", async () => {
    const env = makeEnv(true);
    await expect(waitForPageFocus({ timeoutMs: 1000, doc: env.doc, win: env.win })).resolves.toBe(
      "focused"
    );
    expect(env.listenerCount()).toBe(0);
    expect(env.win.setTimeout).not.toHaveBeenCalled();
  });

  it("resolves on the focus event once the page regains focus, then cleans up", async () => {
    vi.useFakeTimers();
    try {
      const env = makeEnv(false);
      const p = waitForPageFocus({ timeoutMs: 60_000, doc: env.doc, win: env.win });
      expect(env.listenerCount()).toBe(3);

      // A focus event while still unfocused must not resolve.
      env.fire("focus");
      await vi.advanceTimersByTimeAsync(0);

      env.setFocus(true);
      env.fire("visibilitychange");
      await expect(p).resolves.toBe("focused");
      expect(env.listenerCount()).toBe(0);
      expect(env.win.clearTimeout).toHaveBeenCalled();
      expect(env.win.clearInterval).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to polling when no event fires", async () => {
    vi.useFakeTimers();
    try {
      const env = makeEnv(false);
      const p = waitForPageFocus({ timeoutMs: 60_000, pollMs: 100, doc: env.doc, win: env.win });
      env.setFocus(true);
      await vi.advanceTimersByTimeAsync(150);
      await expect(p).resolves.toBe("focused");
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves with timeout when focus never returns", async () => {
    vi.useFakeTimers();
    try {
      const env = makeEnv(false);
      const p = waitForPageFocus({ timeoutMs: 5000, doc: env.doc, win: env.win });
      await vi.advanceTimersByTimeAsync(5000);
      await expect(p).resolves.toBe("timeout");
      expect(env.listenerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
