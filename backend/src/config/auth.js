'use strict';

// Centralised JWT configuration. Loaded once at module-require time, so a
// misconfigured deployment fails fast at boot rather than silently issuing
// tokens with a weak/missing secret.
//
// Why fail-fast over fall-back?
//   A hard-coded fallback secret (the prior behaviour) means a deploy with an
//   empty JWT_SECRET passes health checks, signs real tokens against a string
//   that lives in version control, and gets noticed only after compromise.
//   A boot-time exception forces operators to provide a real value before the
//   first request is served.

const WEAK_SECRETS = new Set([
  'my-super-secret-secret-key-12345!!!',
  'secret',
  'jwt-secret',
  'change-me',
  'changeme',
  'password',
]);

const MIN_SECRET_LENGTH = 32;

function loadJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || !secret.trim()) {
    throw new Error(
      'JWT_SECRET is not set. Refusing to start with an insecure default. ' +
      'Generate one with: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))"'
    );
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new Error(
      `JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters of high-entropy random data.`
    );
  }
  if (WEAK_SECRETS.has(secret)) {
    throw new Error(
      'JWT_SECRET matches a known weak/sample value. Rotate it before starting the server.'
    );
  }
  return secret;
}

module.exports = {
  jwtSecret: loadJwtSecret(),
  // Pin a single symmetric algorithm. Without this, jsonwebtoken historically
  // accepted whatever the token header advertised — the foundation of the
  // alg-confusion class of bypass attacks (RS256 → HS256 with the public key,
  // alg:none, etc.).
  jwtAlgorithm: 'HS256',
  // Short-lived access tokens cap the blast radius of theft. Operators can
  // override via env without code changes. The next iteration should add a
  // refresh-token endpoint so the client can renew silently.
  jwtAccessTtl: process.env.JWT_ACCESS_TTL || '1h',
  // Issuer / audience claims let us reject tokens that were valid for a
  // different service even if signed with the same secret (common during
  // multi-service rollouts where secrets get copy-pasted).
  jwtIssuer: 'haqms-api',
  jwtAudience: 'haqms-clients',
};
