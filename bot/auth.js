// =============================================================================
// AUTH MIDDLEWARE — bearer token protection for bot endpoints
//
// Setup:
//   1. Generate a token: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
//   2. Set env var: BOT_AUTH_TOKEN=<your-token>
//   3. Use in server.js: app.use("/run", authMiddleware);
//
// Calling protected endpoints:
//   curl -H "Authorization: Bearer <token>" https://your-bot.railway.app/run
// =============================================================================

/**
 * Express middleware that validates a Bearer token from the Authorization header.
 * If BOT_AUTH_TOKEN is not set, ALL requests are blocked (fail-closed).
 */
export function authMiddleware(req, res, next) {
  const token = process.env.BOT_AUTH_TOKEN;

  // Fail-closed: if no token is configured, reject everything
  if (!token) {
    console.warn("[AUTH] BOT_AUTH_TOKEN not set — rejecting request to", req.path);
    return res.status(503).json({
      ok: false,
      error: "Bot auth not configured. Set BOT_AUTH_TOKEN env var."
    });
  }

  const authHeader = req.headers.authorization;
  const queryToken = req.query.token;
  if (queryToken && queryToken === token) return next();
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      ok: false,
      error: "Missing or invalid Authorization header. Use: Bearer <token>"
    });
  }

  const provided = authHeader.slice(7);

  // Constant-time comparison to prevent timing attacks
  if (!timingSafeEqual(provided, token)) {
    console.warn("[AUTH] Invalid token attempt from", req.ip, "to", req.path);
    return res.status(403).json({ ok: false, error: "Invalid token" });
  }

  next();
}

/**
 * Constant-time string comparison.
 * Prevents timing attacks on token validation.
 */
function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Rate limiter — simple in-memory sliding window.
 * Protects against brute-force and accidental rapid re-triggers.
 *
 * Usage:
 *   const limiter = createRateLimiter({ windowMs: 60000, maxRequests: 5 });
 *   app.use("/run", limiter);
 */
export function createRateLimiter({ windowMs = 60000, maxRequests = 10 } = {}) {
  const hits = new Map(); // ip -> [timestamps]

  // Cleanup stale entries every 5 minutes
  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, timestamps] of hits) {
      const fresh = timestamps.filter(t => t > cutoff);
      if (fresh.length === 0) hits.delete(ip);
      else hits.set(ip, fresh);
    }
  }, 5 * 60 * 1000).unref();

  return (req, res, next) => {
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const now = Date.now();
    const cutoff = now - windowMs;

    const timestamps = (hits.get(ip) || []).filter(t => t > cutoff);
    timestamps.push(now);
    hits.set(ip, timestamps);

    if (timestamps.length > maxRequests) {
      return res.status(429).json({
        ok: false,
        error: `Rate limited. Max ${maxRequests} requests per ${windowMs / 1000}s.`
      });
    }

    next();
  };
}

// =============================================================================
// PATCHED SERVER SETUP — drop-in replacement for server.js route registration
//
// Replace your current app.get("/run", ...) etc. with:
//
//   import { authMiddleware, createRateLimiter } from "./bot/auth.js";
//   const limiter = createRateLimiter({ windowMs: 60000, maxRequests: 5 });
//
//   // Public endpoints (no auth needed)
//   app.get("/", (_, res) => res.send("Live"));
//   app.get("/health", ...);
//
//   // Protected endpoints
//   app.get("/run",   authMiddleware, limiter, async (req, res) => { ... });
//   app.get("/state", authMiddleware, async (req, res) => { ... });
//   app.get("/pnl",   authMiddleware, async (req, res) => { ... });
//
//   // Destructive endpoints — POST only, double-protected
//   app.post("/reset", authMiddleware, async (req, res) => { ... });
//   //   ↑ changed from GET to POST
// =============================================================================
