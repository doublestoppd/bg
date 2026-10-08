// Rate limits count in fixed windows aligned to the clock. A test that
// fires N requests to hit a limit must not straddle a window boundary, or
// the count splits in two and the limit never trips. This waits until at
// least `needMs` of the current window remain.
export async function waitForFreshWindow(windowMs, needMs = 8000) {
  const remaining = windowMs - (Date.now() % windowMs);
  if (remaining < needMs) {
    await new Promise((resolve) => setTimeout(resolve, remaining + 50));
  }
}
