import rateLimit from 'express-rate-limit';

// Generic API limiter — protects every Express route from accidental
// floods or abusive scraping. Numbers are per-IP per-window.
export const apiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

// Stricter limiter for authentication endpoints to slow brute-force
// attempts on /api/auth/login. Keep room for legitimate retries / page
// reloads but cap clearly below a useful guessing rate.
export const authLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

// Public Prometheus exposition endpoint is hit on a regular scrape
// interval. Allow a comfortable rate so a healthy scraper never trips
// the limiter, while still blocking pathological loops.
export const metricsLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

// Public, unauthenticated bare-metal install endpoints (/install.sh,
// /agent.mjs). They're hit at most a handful of times per host during
// enrollment; anything beyond that is either pathological retry loops
// or scraping. A tight cap keeps the hub safe without affecting any
// real install workflow.
export const installLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});
