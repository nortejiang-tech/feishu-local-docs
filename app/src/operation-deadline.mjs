export const DEFAULT_OPERATION_TIMEOUT_MS = 15_000;

export function withDeadline(operation, timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS, timers = globalThis) {
  const schedule = timers.setTimeout || globalThis.setTimeout;
  const cancel = timers.clearTimeout || globalThis.clearTimeout;
  let timer;
  let settled = false;
  const deadline = new Promise((_, reject) => {
    timer = schedule(() => {
      settled = true;
      reject(new Error('OPERATION_TIMEOUT'));
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve(operation), deadline]).finally(() => {
    if (!settled) cancel(timer);
  });
}
