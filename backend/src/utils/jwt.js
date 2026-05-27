'use strict';

const jwt = require('jsonwebtoken');
const {
  jwtSecret,
  jwtAlgorithm,
  jwtAccessTtl,
  jwtIssuer,
  jwtAudience,
} = require('../config/auth');

// All verification options live here so every call site applies the same
// hardening — pinned algorithm, required issuer + audience, default expiry
// enforcement. Misconfiguration in one route can't weaken another.
const VERIFY_OPTIONS = Object.freeze({
  algorithms: [jwtAlgorithm],
  issuer: jwtIssuer,
  audience: jwtAudience,
});

// Issue an access token. The payload is intentionally minimal: `sub` carries
// the user id (RFC 7519 standard claim) and `role` carries the coarse-grained
// authorization context. Personally identifying fields (name, email) are NOT
// embedded — clients fetch them via /auth/me when needed. This shrinks the
// token, removes PII from log lines and HTTP headers, and limits damage if a
// token leaks.
function signAccessToken({ id, role }) {
  if (!id || !role) {
    throw new Error('signAccessToken requires id and role');
  }
  return jwt.sign(
    { role },
    jwtSecret,
    {
      algorithm: jwtAlgorithm,
      subject: String(id),
      issuer: jwtIssuer,
      audience: jwtAudience,
      expiresIn: jwtAccessTtl,
    }
  );
}

// Verify and normalise. Returns a plain { id, role, exp } shape so route code
// never has to care about JWT internals. Throws the original jsonwebtoken
// error subclasses so the middleware can branch on them.
function verifyAccessToken(token) {
  const decoded = jwt.verify(token, jwtSecret, VERIFY_OPTIONS);
  return {
    id: decoded.sub,
    role: decoded.role,
    exp: decoded.exp,
  };
}

module.exports = { signAccessToken, verifyAccessToken };
