'use strict';

const {
  TokenExpiredError,
  JsonWebTokenError,
  NotBeforeError,
} = require('jsonwebtoken');
const { verifyAccessToken } = require('../utils/jwt');
const logger = require('../utils/logger');

// Canonical role set. Centralised so call sites can't fat-finger a role
// string and silently produce an always-denying gate.
const ROLES = Object.freeze({
  ADMIN: 'ADMIN',
  DOCTOR: 'DOCTOR',
  RECEPTIONIST: 'RECEPTIONIST',
});
const VALID_ROLES = new Set(Object.values(ROLES));

// Authentication middleware — verifies the bearer token and attaches a
// normalised { id, role } to req.user. See utils/jwt for verify hardening.
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
    if (!payload.id || !payload.role || !VALID_ROLES.has(payload.role)) {
      // A token signed by us but carrying a role outside the canonical set
      // must be rejected — never trust the payload past the signature check.
      return res.status(401).json({ error: 'Invalid token.' });
    }
    req.user = { id: payload.id, role: payload.role };
    return next();
  } catch (err) {
    if (err instanceof TokenExpiredError) {
      return res.status(401).json({
        error: 'Session expired. Please sign in again.',
        code: 'TOKEN_EXPIRED',
      });
    }
    if (err instanceof JsonWebTokenError || err instanceof NotBeforeError) {
      logger.warn('Rejected JWT', { reason: err.name });
      return res.status(401).json({ error: 'Invalid token.' });
    }
    logger.error('Unexpected JWT verification failure', err);
    return res.status(401).json({ error: 'Invalid token.' });
  }
}

// Role-based authorisation factory.
//
// Usage:
//   authorize('ADMIN')
//   authorize(['ADMIN', 'RECEPTIONIST'])
//
// Defensive contract: an empty/invalid role list is a developer error, not a
// permissive default. We throw at *registration* time (when the route file is
// required) so misconfigured gates surface during boot, never at runtime as
// a silent open door.
function authorize(roles) {
  const list = typeof roles === 'string' ? [roles] : (roles || []);
  if (list.length === 0) {
    throw new Error('authorize() requires at least one role');
  }
  for (const r of list) {
    if (!VALID_ROLES.has(r)) {
      throw new Error(`authorize() got unknown role "${r}"`);
    }
  }
  const allowed = new Set(list);

  return function authorizeMiddleware(req, res, next) {
    if (!req.user || !req.user.role) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    if (!allowed.has(req.user.role)) {
      // Audit trail for denied privileged access — useful for spotting
      // probing or compromised-account behaviour. Generic client response.
      logger.warn('Authorization denied', {
        userId: req.user.id,
        role: req.user.role,
        required: Array.from(allowed),
        path: req.originalUrl,
        method: req.method,
      });
      return res.status(403).json({ error: 'Forbidden.' });
    }
    return next();
  };
}

module.exports = {
  authenticate,
  authorize,
  ROLES,
};
