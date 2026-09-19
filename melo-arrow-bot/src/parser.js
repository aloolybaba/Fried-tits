const { cleanIgn, parseAmount } = require('./format');

function flattenMessage(message) {
  const parts = [message.content || ''];
  for (const embed of message.embeds || []) {
    parts.push(embed.title || '', embed.description || '', embed.author?.name || '');
    for (const field of embed.fields || []) parts.push(field.name || '', field.value || '');
    parts.push(embed.footer?.text || '');
  }
  return parts.filter(Boolean).join('\n').replace(/[*~`]/g, '').trim();
}

function compileCustomRegex(pattern) {
  if (!pattern) return null;
  if (!pattern.includes('?<ign>') || !pattern.includes('?<amount>')) {
    throw new Error('DELIVERY_REGEX must use named groups: (?<ign>...) and (?<amount>...)');
  }
  const regex = new RegExp(pattern, 'i');
  return regex;
}

function matchToDelivery(match) {
  if (!match?.groups) return null;
  const ign = cleanIgn(match.groups.ign);
  const amount = parseAmount(match.groups.amount);
  return ign && amount !== null ? { ign, amount } : null;
}

function createDeliveryParser(customPattern) {
  const custom = compileCustomRegex(customPattern);
  const patterns = [
    /(?<ign>[A-Za-z0-9_.-]{1,32})\s+(?:has\s+)?delivered\s+you\s+(?<amount>[\d][\d,_.]*(?:\.\d+)?\s*[kmbt]?)\s*(?:arrows?|🏹)?/i,
    /(?:ign|player|username|deliverer)\s*[:=\-]\s*(?<ign>[A-Za-z0-9_.-]{1,32})[\s\S]{0,160}?(?:arrows?|amount|delivered)\s*[:=\-]?\s*(?<amount>[\d][\d,_.]*(?:\.\d+)?\s*[kmbt]?)/i,
    /(?<ign>[A-Za-z0-9_.-]{1,32})\s+(?:has\s+)?(?:delivered|gave|sent|deposited|turned\s+in|submitted)\s+(?<amount>[\d][\d,_.]*(?:\.\d+)?\s*[kmbt]?)\s*(?:arrows?|🏹)?/i,
    /(?<ign>[A-Za-z0-9_.-]{1,32})\s*[:|\-]\s*(?<amount>[\d][\d,_.]*(?:\.\d+)?\s*[kmbt]?)\s*(?:arrows?|🏹)/i,
    /(?<amount>[\d][\d,_.]*(?:\.\d+)?\s*[kmbt]?)\s*(?:arrows?|🏹)[\s\S]{0,80}?(?:by|from|player|ign)\s*[:=\-]?\s*(?<ign>[A-Za-z0-9_.-]{1,32})/i,
  ];

  return function parseDelivery(message) {
    const text = flattenMessage(message);
    if (!text) return null;
    if (custom) {
      custom.lastIndex = 0;
      const parsed = matchToDelivery(custom.exec(text));
      if (parsed) return { ...parsed, rawText: text };
    }
    for (const pattern of patterns) {
      const parsed = matchToDelivery(pattern.exec(text));
      if (parsed) return { ...parsed, rawText: text };
    }
    return null;
  };
}

module.exports = { createDeliveryParser, flattenMessage };
