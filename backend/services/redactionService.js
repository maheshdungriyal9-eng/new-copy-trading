const sensitive = /password|secret|token|authorization|apikey|api.key|privatekey|totp|^2fa$|^pin$/i;

function redact(value, key = '') {
  if (sensitive.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map(item => redact(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
  if (typeof value === 'string') return value.replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]').replace(/((?:accessToken|password|totp|pin|apiKey)["'\s]*[:=]["'\s]*)[^&\s,"'}]+/gi, '$1[REDACTED]').replace(/Generated TOTP code:.*/gi, 'TOTP generated');
  return value;
}

module.exports = { redact };
