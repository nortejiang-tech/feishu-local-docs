/**
 * Pure asynchronous scheduling helpers for capture reads.
 *
 * No process globals are used beyond the default timer functions supplied
 * through options, and no side effects occur other than timer scheduling
 * which is always cleared on settlement.
 */

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_TIMEOUT_CODE = 'CAPTURE_EXECUTION_TIMEOUT';
const RETRYABLE_CODE = 'CAPTURE_TIMEOUT';
const MAX_ATTEMPTS = 2;

/**
 * Invoke `read` exactly once and race it against a deadline timer.
 *
 * - Rejects with an Error whose message and code are `options.code`
 *   (default CAPTURE_EXECUTION_TIMEOUT) when the deadline elapses first.
 * - Always clears the timer on settlement, including synchronous throws.
 * - A late resolution/rejection after the deadline cannot alter the result.
 *
 * @param {() => any} read
 * @param {{timeoutMs?: number, code?: string, setTimer?: Function, clearTimer?: Function}} [options]
 */
export async function readWithDeadline(read, options = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    code = DEFAULT_TIMEOUT_CODE,
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (id) => clearTimeout(id),
  } = options;

  let timerId;
  let rejectTimeout;
  let settled = false;
  const settle = (fn, value) => {
    if (settled) return;
    settled = true;
    fn(value);
  };

  try {
    // Start the timer before invoking read so a synchronous throw still
    // leaves a scheduled timer for the finally block to clear.
    timerId = setTimer(() => {
      const error = new Error(code);
      error.code = code;
      rejectTimeout(error);
    }, timeoutMs);
  } catch (timerError) {
    // Timer scheduling itself failed; nothing to clear.
    timerId = undefined;
    throw timerError;
  }

  try {
    return await new Promise((resolve, reject) => {
      rejectTimeout = (error) => settle(reject, error);

      Promise.resolve()
        .then(() => read())
        .then(
          (value) => settle(resolve, value),
          (err) => settle(reject, err),
        );
    });
  } finally {
    clearTimer(timerId);
  }
}

/**
 * Run a capture read with a pre-attempt checkpoint and a single bounded retry
 * limited to ordinary `{ ok: false, code: 'CAPTURE_TIMEOUT' }` results.
 *
 * Outer deadline rejections and any thrown read/checkpoint error propagate
 * unchanged and never trigger a retry. Results are returned unmodified.
 *
 * @param {{read: () => any, checkpoint?: () => any, timeoutMs?: number}} options
 */
export async function runCaptureRead({
  read,
  checkpoint = async () => {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  let lastTimeoutResult;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    await checkpoint();
    const result = await readWithDeadline(read, { timeoutMs });
    if (
      result !== null &&
      typeof result === 'object' &&
      result.ok === false &&
      result.code === RETRYABLE_CODE
    ) {
      lastTimeoutResult = result;
      continue;
    }
    return result;
  }
  return lastTimeoutResult;
}
