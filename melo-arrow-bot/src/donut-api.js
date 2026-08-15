class DonutApiError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = 'DonutApiError';
    this.status = status;
  }
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
        if (response.status === 401 || body?.status === 401) {
          throw new DonutApiError('The DonutSMP API key is invalid or expired.', 401);
        }
        if ([403, 404, 500, 503].includes(response.status) || [403, 404, 500, 503].includes(body?.status)) {
          throw new DonutApiError(reason || 'That DonutSMP player was not found.', response.status || body?.status);
        }
        throw new DonutApiError(reason || 'DonutSMP could not handle that request.', response.status || body?.status);
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

  async getProfile(username) {
    const [stats, lookup] = await Promise.all([
      this.getStats(username),
      this.getLookup(username).catch(() => null),
    ]);
    return { stats, lookup };
  }
}

module.exports = { DonutApi, DonutApiError };
