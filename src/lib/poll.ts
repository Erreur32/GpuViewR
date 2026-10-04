// Polling that stops while the browser tab is hidden. A dashboard left
// open in a background tab used to keep hitting the hub every few
// seconds for data nobody looked at. Runs are chained (next one starts
// `ms` after the previous one settled), so a slow hub never gets
// overlapping requests from the same loop.

/** Calls `fn` every `ms` while the tab is visible, and once right away
 *  when the tab becomes visible again. The caller does its own first
 *  call. Returns the cleanup function. */
export function pollWhileVisible(fn: () => unknown, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let stopped = false;

  const schedule = () => {
    if (stopped || document.hidden) return;
    timer = setTimeout(run, ms);
  };

  async function run(): Promise<void> {
    timer = null;
    if (running) return;
    running = true;
    try {
      await fn();
    } catch {
      // Callers handle their own errors; a failed run must not end the loop.
    } finally {
      running = false;
    }
    schedule();
  }

  const onVisibility = () => {
    if (document.hidden) {
      if (timer) clearTimeout(timer);
      timer = null;
    } else if (!timer && !running) {
      void run();
    }
  };

  document.addEventListener('visibilitychange', onVisibility);
  schedule();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
