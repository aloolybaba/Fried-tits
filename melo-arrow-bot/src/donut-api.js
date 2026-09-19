class DonutApiError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'DonutApiError';
    this.status = status;
  }
}

function decodeHtml(value) {
  return String(value)
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function stripHtml(value) {
  return decodeHtml(String(value).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expandCompactNumber(value) {
  const normalized = String(value || '').replace(/[$,\s]/g, '').toLowerCase();
  const match = normalized.match(/^(\d+(?:\.\d+)?)([kmbt])?$/);
  if (!match) return '0';
  const multiplier = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[match[2]] || 1;
  return String(Math.round(Number(match[1]) * multiplier));
}

class DonutApi {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.baseUrl = options.baseUrl || 'https://api.donutsmp.net/v1';
    this.fetch = options.fetch || globalThis.fetch;
    this.cacheTtlMs = options.cacheTtlMs || 15_000;
    this.cache = new Map();
  }

  async request(path) {
    const cacheKey = path.toLowerCase();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;

    const promise = (async () => {
      let response;
      try {
        response = await this.fetch(`${this.baseUrl}${path}`, {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            'User-Agent': 'MeloArrowBot/1.1',
          },
          signal: AbortSignal.timeout(8_000),
        });
      } catch (error) {
        if (error.name === 'TimeoutError') throw new DonutApiError('DonutSMP took too long to respond. Please try again.');
        throw new DonutApiError('Could not reach the DonutSMP API. Please try again.');
      }

      let body = null;
      try {
        body = await response.json();
      } catch {
        throw new DonutApiError('DonutSMP returned an invalid response.', response.status);
      }
      if (!response.ok || body?.status >= 400 || !body?.result) {
        const reason = body?.message || body?.reason;
        const status = body?.status >= 400 ? body.status : response.status;
        if (response.status === 401 || body?.status === 401) {
          throw new DonutApiError('The DonutSMP API key is invalid or expired.', 401);
        }
        if ([403, 404, 500, 503].includes(response.status) || [403, 404, 500, 503].includes(body?.status)) {
          throw new DonutApiError(reason || 'That DonutSMP player was not found.', status);
        }
        throw new DonutApiError(reason || 'DonutSMP could not handle that request.', status);
      }
      return body.result;
    })();

    this.cache.set(cacheKey, { promise, expiresAt: Date.now() + this.cacheTtlMs });
    promise.catch(() => this.cache.delete(cacheKey));
    return promise;
  }

  getStats(username) {
    return this.request(`/stats/${encodeURIComponent(username)}`);
  }

  getLookup(username) {
    return this.request(`/lookup/${encodeURIComponent(username)}`);
  }

  async requestPublicPage(url, cacheKey) {
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;
    const promise = (async () => {
      const response = await this.fetch(url, {
        headers: { Accept: 'text/html', 'User-Agent': 'MeloArrowBot/1.1' },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) throw new DonutApiError('The player data service is temporarily unavailable.', response.status);
      return response.text();
    })();
    this.cache.set(cacheKey, { promise, expiresAt: Date.now() + this.cacheTtlMs });
    promise.catch(() => this.cache.delete(cacheKey));
    return promise;
  }

  async getPublicStatsFallback(username) {
    const html = await this.requestPublicPage(
      `https://www.donutstats.net/player/${encodeURIComponent(username)}`,
      `public-stats:${username.toLowerCase()}`,
    );
    const stats = {};
    const propertyPattern = /"name":"(money|shards|kills|deaths|playtime|placed_blocks|broken_blocks|mobs_killed)","value":"([^"]+)"/gi;
    for (const match of html.matchAll(propertyPattern)) stats[match[1].toLowerCase()] = match[2];

    for (const [label, key] of [['Money Spent', 'money_spent_on_shop'], ['Money Made', 'money_made_from_sell']]) {
      const card = html.match(new RegExp(`${label}[\\s\\S]{0,1800}?tabular-nums[^>]*>\\$?([^<]+)<`, 'i'));
      if (card) stats[key] = expandCompactNumber(decodeHtml(card[1]));
    }
    if (!stats.money) throw new DonutApiError('That DonutSMP player was not found.', 404);
    stats.money_spent_on_shop ||= '0';
    stats.money_made_from_sell ||= '0';
    return stats;
  }

  async getOverallRanking(username) {
    try {
      const html = await this.requestPublicPage(
        `https://www.donutstats.net/all-time-best?q=${encodeURIComponent(username)}`,
        `overall-rank:${username.toLowerCase()}`,
      );
      const titleNeedle = `title="${username}">${username}`.toLowerCase();
      const index = html.toLowerCase().indexOf(titleNeedle);
      if (index < 0) return null;
      const snippet = stripHtml(html.slice(Math.max(0, index - 1200), index + 3500));
      const player = escapeRegExp(username);
      const row = snippet.match(new RegExp(`#\\s*([\\d,]+)\\s+${player}\\s+[0-9a-f-]{32,36}\\s+([\\d.]+)\\s+Rank\\s*#\\s*([\\d,]+)`, 'i'));
      if (!row) return null;
      const totalMatch = html.slice(0, Math.min(html.length, 60_000)).match(/Search any player from ([\d,]+) users/i);
      return {
        rank: Number(row[3].replace(/,/g, '')),
        score: Number(row[2]),
        totalPlayers: totalMatch ? Number(totalMatch[1].replace(/,/g, '')) : null,
      };
    } catch {
      return null;
    }
  }

  async getProfile(username) {
    const lookupPromise = this.getLookup(username).catch(() => null);
    const rankingPromise = this.getOverallRanking(username);
    let stats;
    try {
      stats = await this.getStats(username);
    } catch (error) {
      if (error.status === 401) throw error;
      try {
        stats = await this.getPublicStatsFallback(username);
      } catch {
        throw error;
      }
    }
    const [lookup, ranking] = await Promise.all([lookupPromise, rankingPromise]);
    return { stats, lookup, ranking };
  }
}

module.exports = { DonutApi, DonutApiError };
