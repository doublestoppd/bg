// A small in-memory rate limiter for forms that attackers like to hammer,
// such as login and registration. Each visitor (by IP address) may make
// maxAttempts requests per windowMs; further requests get a 429 page.
//
// State lives in this process only, so it resets on restart and is not
// shared between multiple server processes. That is fine for a single
// small game server, which is all this project aims to run.
export function createRateLimiter({ maxAttempts, windowMs }) {
  // ip -> timestamps (ms) of recent attempts, oldest first
  const attemptsByIp = new Map();

  // Forget visitors whose attempts have all aged out, so the map cannot
  // grow forever. unref() lets the process exit without waiting on it.
  const sweeper = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, timestamps] of attemptsByIp) {
      if (timestamps[timestamps.length - 1] < cutoff) attemptsByIp.delete(ip);
    }
  }, windowMs);
  sweeper.unref();

  return function rateLimit(req, res, next) {
    const now = Date.now();
    const recent = (attemptsByIp.get(req.ip) || []).filter((time) => time > now - windowMs);

    if (recent.length >= maxAttempts) {
      const retryAfterSeconds = Math.ceil((recent[0] + windowMs - now) / 1000);
      res.set('Retry-After', String(retryAfterSeconds));
      return res.status(429).render('error', {
        title: 'Slow down',
        message: `Too many attempts. Please wait ${Math.ceil(retryAfterSeconds / 60)} minute(s) and try again.`,
      });
    }

    recent.push(now);
    attemptsByIp.set(req.ip, recent);
    next();
  };
}
