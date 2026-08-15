const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function formatInteger(value) {
  return BigInt(value || 0).toLocaleString('en-US');
}

function formatCompact(value) {
  const amount = BigInt(value || 0);
  const sign = amount < 0n ? '-' : '';
  const absolute = amount < 0n ? -amount : amount;
  const units = [
    [1_000_000_000_000n, 'T'],
    [1_000_000_000n, 'B'],
    [1_000_000n, 'M'],
    [1_000n, 'K'],
  ];

  for (const [divisor, suffix] of units) {
    if (absolute >= divisor) {
      const whole = absolute / divisor;
      const decimal = (absolute % divisor) * 10n / divisor;
      return `${sign}${whole}${decimal ? `.${decimal}` : ''}${suffix}`;
    }
  }
  return `${sign}${absolute}`;
}

function parseAmount(raw) {
  if (raw === null || raw === undefined) return null;
  const normalized = String(raw).trim().toLowerCase().replace(/[,_\s]/g, '');
  const match = normalized.match(/^(\d+(?:\.\d+)?)([kmbt])?$/i);
  if (!match) return null;
  const multipliers = { k: 1_000n, m: 1_000_000n, b: 1_000_000_000n, t: 1_000_000_000_000n };
  const multiplier = multipliers[match[2]] || 1n;
  const [whole, fraction = ''] = match[1].split('.');
  let value = BigInt(whole) * multiplier;
  if (fraction) {
    const scale = 10n ** BigInt(fraction.length);
    value += BigInt(fraction) * multiplier / scale;
  }
  if (value > MAX_SAFE_BIGINT * 1_000_000n) return null;
  return value;
}

function normalizeIgn(value) {
  return String(value || '').trim().replace(/^`|`$/g, '').toLowerCase();
}

function cleanIgn(value) {
  const cleaned = String(value || '').trim().replace(/^<@!?\d+>$/, '').replace(/^[`*_~]+|[`*_~:;,]+$/g, '');
  if (!/^[A-Za-z0-9_\-.]{1,32}$/.test(cleaned)) return null;
  return cleaned;
}

module.exports = { formatInteger, formatCompact, parseAmount, normalizeIgn, cleanIgn };
