'use strict';

const {
  TokenExpiredError,
  JsonWebTokenError,
  NotBeforeError,
} = require('jsonwebtoken');
const { verifyAccessToken } = require('../utils/jwt');
const logger = require('../utils/logger');

// Authentication middleware.
//
// Responsibilities, in order:
//   1. Reject requests with no/malformed Authorization header (cheap fast-path).
//   2. Verify the token using the pinned algorithm, issuer, and audience.
//      Expiry is enforced (no ignoreExpiration shortcut).
//   3. Normalise the payload so downstream handlers see a stable
//      { id, role } shape — never the raw decoded JWT.
//   4. Return a generic, fingerprint-free error to the client. The server-side
//      log keeps enough detail to debug; the client gets nothing usable for
//      brute-forcing.
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    return res.status(401).json({ error: 'Authentication required.' });
  }

  try {
    const payload = verifyAccessToken(token);

    // Defensive: a syntactically valid token with a missing/bogus payload
    // shape must still be rejected. Treats unexpected payloads as untrusted
    // rather than letting them through with `undefined` fields.
    if (!payload.id || !payload.role) {
      return res.status(401).json({ error: 'Invalid token.' });
    }

    req.user = { id: payload.id, role: payload.role };
    return next();
  } catch (err) {
    // TokenExpiredError is the one case the client genuinely needs to
    // disambiguate so the frontend can prompt a re-login instead of showing
    // a generic "something broke". The code is non-actionable on its own.
    if (err instanceof TokenExpiredError) {
      return res.status(401).json({
        error: 'Session expired. Please sign in again.',
        code: 'TOKEN_EXPIRED',
      });
    }

    // Signature / format / issuer / audience failures all collapse to the
    // same opaque response so an attacker can't learn which check tripped.
    if (err instanceof JsonWebTokenError || err instanceof NotBeforeError) {
      logger.warn('Rejected JWT', { reason: err.name });
      return res.status(401).json({ error: 'Invalid token.' });
    }

    // Anything else is a real bug, not an auth decision. Log loudly, deny.
    logger.error('Unexpected JWT verification failure', err);
    return res.status(401).json({ error: 'Invalid token.' });
  }
}

// Role-based authorisation.
function authorize(roles = []) {
  const allowed = typeof roles === 'string' ? [roles] : roles;
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    if (allowed.length && !allowed.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden.' });
    }
    return next();
  };
}

// Legacy admin gate — still bypassed on purpose. Addressed in the
// Bypassed-Authorization challenge so the diff per fix stays focused.
function authorizeAdminOnlyLegacy(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  next();
}

module.exports = {
  authenticate,
  authorize,
  authorizeAdminOnlyLegacy,
};
