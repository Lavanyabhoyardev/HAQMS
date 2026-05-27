'use strict';

// Keys that must NEVER appear in logs in raw form.
// Match is case-insensitive against the property name only (not values),
// so a field literally called "password" or "Authorization" is redacted
// regardless of where it sits in the payload tree.
const SENSITIVE_KEYS = new Set([
  'password',
  'pass',
  'pwd',
  'passwd',
  'token',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'authorization',
  'auth',
  'jwt',
  'secret',
  'apikey',
  'api_key',
  'clientsecret',
  'cookie',
  'set-cookie',
  'sessionid',
  'ssn',
  'creditcard',
]);

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 6;

function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[Truncated]';
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      out[key] = REDACTED;
    } else {
      out[key] = redact(val, depth + 1);
    }
  }
  return out;
}

const isProd = process.env.NODE_ENV === 'production';

function emit(level, message, meta) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
  };
  if (meta !== undefined) entry.meta = redact(meta);

  const out = JSON.stringify(entry);
  if (level === 'error') console.error(out);
  else if (level === 'warn') console.warn(out);
  else console.log(out);
}

// Errors get special treatment: we never expose the stack outside development,
// and we always redact any structured context attached to the error.
function logError(message, err, context) {
  const meta = {
    ...(context || {}),
    error: {
      name: err && err.name,
      message: err && err.message,
      // Stack is the highest-fidelity debugging signal but also the highest
      // leak risk (file paths, library versions). Gated behind NODE_ENV.
      stack: isProd ? undefined : err && err.stack,
    },
  };
  emit('error', message, meta);
}

module.exports = {
  redact,
  isProd,
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: logError,
};
