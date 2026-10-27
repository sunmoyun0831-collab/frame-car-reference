/* Public Autohome suggestions. Data only: no JSONP execution or third-party service. */
(function (root) {
  'use strict';
  const ENDPOINT = 'https://sou.api.autohome.com.cn/sug/_suggest';
  const MAX_BYTES = 512 * 1024;
  const clean = value => typeof value === 'string' ? value.normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ').trim() : '';

  function queryText(value) {
    if (typeof value !== 'string' || value.length > 320) throw new Error('搜索词无效');
    return clean(value).slice(0, 80);
  }

  function parseSuggestions(value) {
    if (!value || value.returncode !== 0 || !Array.isArray(value.result?.data)) {
      throw new Error('车型联想响应格式已变化，请使用站内搜索。');
    }
    const seen = new Set(), result = [];
    for (const row of value.result.data.slice(0, 100)) {
      // Verified public schema: wordtype 3 = series; 1 = brand; 0 = phrase.
      // IDs for articles, brands, prices or promoted rows must never become series IDs.
      if (!row || row.wordtype !== 3 || row.datatype !== 0 || row.addata) continue;
      if (!['string', 'number'].includes(typeof row.wordid)) continue;
      if (typeof row.wordid === 'number' && !Number.isSafeInteger(row.wordid)) continue;
      const id = String(row.wordid);
      const name = clean(row.match_word || row.key).slice(0, 80);
      if (!/^[1-9]\d{0,19}$/.test(id) || !name || /[<>]/.test(name) || seen.has(id)) continue;
      const base = `https://car.autohome.com.cn/pic/series/${id}`;
      result.push({
        id, name, url: `${base}.html`, thumb: '',
        links: { all: `${base}.html`, exterior: `${base}-1.html`,
          interior: `${base}-10.html`, details: `${base}-12.html` }
      });
      seen.add(id);
      if (result.length === 8) break;
    }
    return result;
  }

  async function readJSON(response) {
    if (!response.ok) throw new Error(`车型联想暂时不可用（HTTP ${response.status}），可改用站内搜索。`);
    if (response.url && new URL(response.url).origin !== new URL(ENDPOINT).origin) {
      throw new Error('车型查询被重定向，请使用站内搜索。');
    }
    const length = Number(response.headers?.get('content-length'));
    if (Number.isFinite(length) && length > MAX_BYTES) throw new Error('车型查询响应过大');
    if (!response.body?.getReader) {
      const text = await response.text();
      if (text.length > MAX_BYTES) throw new Error('车型查询响应过大');
      return JSON.parse(text);
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let bytes = 0, text = '';
    try {
      while (true) {
        const item = await reader.read();
        if (item.done) break;
        bytes += item.value.byteLength;
        if (bytes > MAX_BYTES) throw new Error('车型查询响应过大');
        text += decoder.decode(item.value, { stream: true });
      }
      return JSON.parse(text + decoder.decode());
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  function createClient(fetcher = (...args) => fetch(...args), now = () => Date.now()) {
    const cache = new Map(), pending = new Map();
    async function suggest(value) {
      const query = queryText(value), key = query.toLocaleLowerCase();
      if (!query) return [];
      const saved = cache.get(key);
      if (saved && now() - saved.at < 5 * 60 * 1000) return structuredClone(saved.items);
      if (pending.has(key)) return structuredClone(await pending.get(key));
      if (pending.size >= 8) throw new Error('车型查询较忙，请稍后再试。');
      const work = (async () => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        try {
          const params = new URLSearchParams({ plat: 'pc', uid: '', q: query });
          const response = await fetcher(`${ENDPOINT}?${params}`, {
            method: 'GET', credentials: 'omit', redirect: 'error',
            referrerPolicy: 'no-referrer', signal: controller.signal
          });
          const items = parseSuggestions(await readJSON(response));
          cache.delete(key);
          cache.set(key, { items, at: now() });
          if (cache.size > 40) cache.delete(cache.keys().next().value);
          return items;
        } catch (error) {
          if (error?.name === 'AbortError') throw new Error('车型联想超时，可重试或使用站内搜索。');
          if (error instanceof SyntaxError) throw new Error('车型联想返回了非数据页面，请使用站内搜索。');
          throw error;
        } finally {
          clearTimeout(timeout);
        }
      })();
      pending.set(key, work);
      try { return structuredClone(await work); }
      finally { pending.delete(key); }
    }
    return { suggest };
  }

  const client = createClient();
  const api = Object.freeze({ ENDPOINT, queryText, parseSuggestions, createClient, suggest: client.suggest });
  root.FrameSearch = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
