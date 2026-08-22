// packages/ceo-core/src/timeout.ts
// Timeout arithmetic, deadline signal fusion, and idle detection — the ideas
// behind deepseek-harness's util/timeout (clampTimeout / deadline /
// idleWatchdog), distilled to what ceo-core needs with zero dependencies, so
// the Node CLI and the Electron code can both use it.
//
// Rule carried over from dsh: these helpers only *notify* (abort / callback).
// Each capability still owns the mechanism that actually stops its work and
// translates the notification into a public outcome (llm.ts maps both of its
// hang guards onto LLMError "TIMEOUT").

/** Largest delay Node's setTimeout schedules faithfully; anything larger is
 *  silently clamped to ~1ms (a Node footgun), so guard instead of mis-firing
 *  a safety net milliseconds after arming it. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Validate a delay meant for setTimeout; returns it unchanged. Throwing beats
 *  firing immediately by accident — a mis-armed guard is worse than none. */
function timerDelay(ms: number, name = "timeoutMs"): number {
  if (!Number.isFinite(ms) || ms <= 0 || ms > MAX_TIMER_DELAY_MS) {
    throw new Error(`${name} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
  }
  return ms;
}

/** Schedule fn at ms, unref'd so a pending timer never pins an otherwise idle
 *  CLI/Electron process open. Guarded: non-Node timer handles (browsers,
 *  workers, faked timers) have no unref. */
function arm(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return t;
}

/** Validate an optional, untyped caller hint against a default and a cap:
 *  `min(requested ?? def, max)`. Unlike dsh's clampTimeout (which throws on a
 *  bad hint), ceo-core feeds this straight from user config — garbage falls
 *  back to the default instead of failing a call that could still work, and 0
 *  is not a "disable" sentinel. */
export function clampTimeout(requested: unknown, def: number, max: number): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) return def;
  return Math.min(requested, max);
}

export interface Deadline {
  /** Aborts when the timeout elapses OR the external signal aborts —
   *  whichever comes first. One fused signal, so a fetch() needs no extra
   *  abort wiring beyond `signal: deadline.signal`. */
  readonly signal: AbortSignal;
  /** True only when *our own* timer won the race; stays false on external
   *  abort, so callers can tell "too slow" apart from "caller cancelled". */
  timedOut(): boolean;
  /** Clear the timer and drop the external listener. Idempotent; call on
   *  every exit path so a settled call leaves nothing armed. */
  dispose(): void;
}

/** Fuse an external abort with an attempt-level timeout into one signal.
 *
 *  Node 20+ has AbortSignal.any + AbortSignal.timeout, but
 *  AbortSignal.timeout's abort reason carries no caller-meaningful marker and
 *  `any` propagates the winner's reason opaquely — a plain AbortController
 *  plus setTimeout keeps the "who aborted" answer in timedOut() under our
 *  control, and works on every runtime we ship. */
export function createDeadline(timeoutMs: number, external?: AbortSignal): Deadline {
  const ms = timerDelay(timeoutMs);
  const ctl = new AbortController();
  let timedOut = false;
  const timer = arm(ms, () => {
    if (ctl.signal.aborted) return; // external already won the race: a late fire must not rewrite the cause
    timedOut = true;
    const reason = new Error(`deadline exceeded after ${ms}ms`);
    reason.name = "TimeoutError";
    ctl.abort(reason);
  });
  let detach: () => void = () => { }; // becomes "remove the external listener" once one is attached
  if (external) {
    const ext = external; // non-optional alias the closure below can hold
    const onExternal = (): void => { clearTimeout(timer); ctl.abort(ext.reason); };
    if (ext.aborted) onExternal(); // already cancelled: fuse immediately, timedOut stays false
    else ext.addEventListener("abort", onExternal, { once: true });
    detach = () => ext.removeEventListener("abort", onExternal);
  }
  return {
    signal: ctl.signal,
    timedOut: () => timedOut,
    dispose() { clearTimeout(timer); detach(); },
  };
}

export interface IdleWatchdog {
  /** Report progress: re-arms the timer. No-op after the watchdog fired — a
   *  spent watchdog must not come back to life on a late touch. */
  touch(): void;
  /** Clear the pending timer. Idempotent. */
  stop(): void;
}

/** A rearmable idle timer. Armed from creation (a stream that never yields
 *  its first byte is idle too); every touch() restarts the countdown; if the
 *  full interval passes with no touch, onFire runs exactly once. The callback
 *  only notifies — the caller starts the actual teardown (e.g.
 *  reader.cancel()); this helper deliberately knows nothing about streams. */
export function createIdleWatchdog(timeoutMs: number, onFire: () => void): IdleWatchdog {
  const ms = timerDelay(timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fired = false;
  const armWatch = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = arm(ms, () => {
      timer = undefined;
      fired = true;
      try { onFire(); } catch { /* a timer callback must never crash the process */ }
    });
  };
  armWatch();
  return {
    touch: () => { if (!fired) armWatch(); },
    stop: () => { if (timer !== undefined) { clearTimeout(timer); timer = undefined; } },
  };
}
