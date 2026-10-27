/* Autohome Studio: dependency-free validation and state helpers. */
(function (root) {
  'use strict';

  const LIMITS = Object.freeze({ cars: 60, favorites: 200, searches: 20, candidates: 8, topics: 50, selectedTopics: 8 });
  const DEFAULT_TOPICS = Object.freeze(['灯', '轮毂', '翼子板']);
  const DEFAULT_SETTINGS = Object.freeze({
    sameTab: true, opacity: 92, collapsed: false, theme: 'dark', grayscale: 0, lastMainView: 'home',
    x: null, y: null, saveAs: false, historyOpen: false,
    width: 320, height: 260, radius: 24, accent: '#6ad2cb', accentTransparency: 0,
    blur: 24, findSplit: 50,
    archiveConfigured: true, smartArchive: true, createFrameFolder: true, smartRename: true
  });
  const LINK_KEYS = ['all', 'exterior', 'interior', 'details'];

  function cleanText(value, limit = 100) {
    if (typeof value !== 'string') return '';
    return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '')
      .replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function parseHttpURL(value) {
    if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value)) return null;
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
      return url;
    } catch (_) { return null; }
  }

  function hasDomain(host, domain) {
    return host === domain || host.endsWith('.' + domain);
  }

  function isAutohomeURL(value) {
    const url = parseHttpURL(value);
    return !!url && hasDomain(url.hostname, 'autohome.com.cn');
  }

  function isImageURL(value) {
    const url = parseHttpURL(value);
    return !!url && (hasDomain(url.hostname, 'autoimg.cn') || hasDomain(url.hostname, 'autohome.com.cn'));
  }

  function normalizeId(value) {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0)) return null;
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    const id = String(value);
    if (!/^\d{1,20}$/.test(id) || !/[1-9]/.test(id)) return null;
    return id.replace(/^0+/, '');
  }

  function normalizePhotoId(value) {
    if (typeof value === 'string' && /^1_\d{1,20}$/.test(value)) {
      const number = normalizeId(value.slice(2));
      return number ? '1_' + number : null;
    }
    return normalizeId(value);
  }

  function normalizeCar(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const id = normalizeId(value.id);
    const name = cleanText(value.name);
    if (!id || !name || !isAutohomeURL(value.url)) return null;
    const links = {};
    for (const key of LINK_KEYS) {
      if (isAutohomeURL(value.links && value.links[key])) links[key] = new URL(value.links[key]).href;
    }
    return {
      id, name, url: new URL(value.url).href, links,
      thumb: isImageURL(value.thumb) ? new URL(value.thumb).href : ''
    };
  }

  function normalizeSearch(value) {
    if (!value || typeof value !== 'object') return null;
    const query = cleanText(value.query, 120);
    if (!query || !isAutohomeURL(value.url)) return null;
    return {
      query, url: new URL(value.url).href,
      at: typeof value.at === 'number' && Number.isFinite(value.at) && value.at >= 0 ? value.at : 0
    };
  }

  function applySettings(current, patch) {
    const out = { ...DEFAULT_SETTINGS };
    // Do not allow unknown keys or invalid persisted values to leak into state.
    const apply = patch => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out;
    for (const key of ['sameTab', 'collapsed', 'saveAs', 'smartArchive', 'createFrameFolder', 'historyOpen']) {
      if (typeof patch[key] === 'boolean') out[key] = patch[key];
    }
    for (const [key, min, max] of [['width', 320, 760], ['height', 260, 650], ['radius', 0, 24], ['accentTransparency', 0, 100]]) {
      if (Number.isInteger(patch[key]) && patch[key] >= min && patch[key] <= max) out[key] = patch[key];
    }
    if (typeof patch.accent === 'string' && /^#[0-9a-f]{6}$/i.test(patch.accent)) out.accent = patch.accent.toLowerCase();
    if (typeof patch.opacity === 'number' && Number.isFinite(patch.opacity)) {
      out.opacity = Math.max(40, Math.min(100, Math.round(patch.opacity)));
    }
    // v0.4.1 restores explicit themes. Keep grayscale only as a migration
    // endpoint so old backups and queued jobs remain readable.
    if (['dark', 'light'].includes(patch.theme)) out.theme = patch.theme;
    else if (typeof patch.grayscale === 'number' && Number.isFinite(patch.grayscale)) {
      out.theme = patch.grayscale >= 50 ? 'light' : 'dark';
    }
    if (['home', 'download'].includes(patch.lastMainView)) out.lastMainView = patch.lastMainView;
    for (const [key, min, max] of [['blur', 0, 40], ['findSplit', 30, 70]]) {
      if (typeof patch[key] === 'number' && Number.isFinite(patch[key])) {
        out[key] = Math.max(min, Math.min(max, patch[key]));
      }
    }
    for (const key of ['x', 'y']) {
      if (patch[key] === null) out[key] = null;
      else if (typeof patch[key] === 'number' && Number.isFinite(patch[key])) {
        out[key] = Math.max(0, Math.min(100000, Math.round(patch[key])));
      }
    }
    };
    apply(current); apply(patch);
    // Compatibility fields are invariants, not user choices. Enforce this
    // across persisted state, mutations, imports and immutable job snapshots.
    out.archiveConfigured = true;
    out.smartRename = true;
    out.grayscale = out.theme === 'light' ? 100 : 0;
    return out;
  }

  const filenameKey = value => String(value || '').normalize('NFKC').toLowerCase();

  function normalizeTopic(value) {
    if (typeof value !== 'string' || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) throw new Error('TOPIC_INVALID：专题不能含控制字符或隐藏字符');
    const name = value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
    if (!name || Array.from(name).length > 40 || !/^[\p{L}\p{N}\p{M} _()（）·\-]+$/u.test(name) ||
        !/[\p{L}\p{N}]/u.test(name) || /[. ]$/.test(name) ||
        /^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) {
      throw new Error('TOPIC_INVALID：专题须为 1–40 字的文字或数字，不能含路径、保留名或不安全符号');
    }
    if (filenameKey(name) === 'frame') throw new Error('TOPIC_ROOT_CONFLICT：专题不能命名为 FRAME');
    return name;
  }

  function topicList(values, strict = true, limit = LIMITS.topics) {
    if (!Array.isArray(values) || values.length > limit) {
      if (strict) throw new Error(`TOPIC_LIMIT：最多 ${limit} 个专题`);
      values = Array.isArray(values) ? values.slice(0, limit) : [];
    }
    const names = [], seen = new Set();
    for (const value of values) {
      try {
        const name = normalizeTopic(value), key = filenameKey(name);
        if (seen.has(key)) { if (strict) throw new Error('TOPIC_DUPLICATE：专题名称重复（不区分大小写）'); else continue; }
        seen.add(key); names.push(name);
      } catch (error) { if (strict) throw error; }
    }
    return names;
  }

  function assertTopicConflicts(name, modelNames) {
    const key = filenameKey(name);
    if ((modelNames || []).some(model => filenameKey(safeFilenamePart(model, '未命名车型', 60)) === key)) {
      throw new Error('TOPIC_MODEL_CONFLICT：专题与车型文件夹同名，请使用不同名称');
    }
  }

  function uniqueList(values, normalize, keyOf, limit) {
    const out = [], seen = new Set();
    for (const value of Array.isArray(values) ? values : []) {
      const item = normalize(value);
      if (!item || seen.has(keyOf(item))) continue;
      seen.add(keyOf(item));
      out.push(item);
      if (out.length === limit) break;
    }
    return out;
  }

  function normalizeState(value) {
    const data = value && typeof value === 'object' ? value : {};
    return {
      cars: uniqueList(data.cars, normalizeCar, car => car.id, LIMITS.cars),
      favorites: uniqueList(data.favorites, normalizeCar, car => car.id, LIMITS.favorites),
      searches: uniqueList(data.searches, normalizeSearch, s => s.query.toLocaleLowerCase(), LIMITS.searches),
      settings: applySettings(DEFAULT_SETTINGS, data.settings),
      topics: data.topics === undefined ? [...DEFAULT_TOPICS] : topicList(data.topics, false)
    };
  }

  function reduceState(previous, message, now = Date.now()) {
    const state = normalizeState(previous);
    if (!message || typeof message !== 'object') throw new Error('无效请求');
    switch (message.type) {
      case 'SETTINGS':
        state.settings = applySettings(state.settings, message.patch);
        break;
      case 'TOPIC_ADD': {
        const name = normalizeTopic(message.name);
        if (state.topics.some(topic => filenameKey(topic) === filenameKey(name))) throw new Error('TOPIC_DUPLICATE：专题名称重复（不区分大小写）');
        if (state.topics.length >= LIMITS.topics) throw new Error('TOPIC_LIMIT：最多 50 个专题，请先移除一项');
        assertTopicConflicts(name, [...state.cars, ...state.favorites].map(car => car.name));
        state.topics.push(name);
        break;
      }
      case 'TOPIC_REMOVE': {
        const name = normalizeTopic(message.name);
        state.topics = state.topics.filter(topic => filenameKey(topic) !== filenameKey(name));
        break;
      }
      case 'VISIT':
      case 'RESTORE_RECENT': {
        const car = normalizeCar(message.car);
        if (!car) throw new Error('车型信息无效：需要数字 ID、名称和汽车之家链接');
        state.cars = [car, ...state.cars.filter(item => item.id !== car.id)].slice(0, LIMITS.cars);
        state.favorites = state.favorites.map(item => item.id === car.id ? { ...item, ...car } : item);
        break;
      }
      case 'FAVORITE':
      case 'REMOVE_RECENT':
      case 'REMOVE_FAVORITE': {
        const id = normalizeId(message.id);
        if (!id) throw new Error('车型 ID 必须为正整数');
        if (message.type === 'REMOVE_RECENT') state.cars = state.cars.filter(car => car.id !== id);
        else if (message.type === 'REMOVE_FAVORITE') state.favorites = state.favorites.filter(car => car.id !== id);
        else if (state.favorites.some(car => car.id === id)) state.favorites = state.favorites.filter(car => car.id !== id);
        else {
          const car = state.cars.find(item => item.id === id);
          if (!car) throw new Error('未找到车型，请先访问该车型');
          if (state.favorites.length >= LIMITS.favorites) throw new Error('收藏已达 200 项，请先移除一项');
          state.favorites.unshift({ ...car, links: { ...car.links } });
        }
        break;
      }
      case 'SEARCH': {
        const search = normalizeSearch({ query: message.query, url: message.url, at: now });
        if (!search) throw new Error('搜索词或汽车之家搜索链接无效');
        const key = search.query.toLocaleLowerCase();
        state.searches = [search, ...state.searches.filter(s => s.query.toLocaleLowerCase() !== key)].slice(0, LIMITS.searches);
        break;
      }
      case 'REMOVE_SEARCH': {
        const query = cleanText(message.query, 120).toLocaleLowerCase();
        if (!query) throw new Error('搜索词不能为空');
        state.searches = state.searches.filter(s => s.query.toLocaleLowerCase() !== query);
        break;
      }
      default: throw new Error('未知操作');
    }
    return state;
  }

  function safeFilenamePart(value, fallback = '图片', limit = 70) {
    let text = cleanText(typeof value === 'string' ? value.normalize('NFKC') : '', limit * 2)
      .replace(/[<>:"/\\|?*%\p{Cc}\p{Cf}\p{Cs}]/gu, '_')
      .replace(/^[. ]+|[. ]+$/g, '');
    text = Array.from(text).slice(0, limit).join('').replace(/[. ]+$/g, '');
    if (!text) text = fallback;
    if (/^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9]|lpt[0-9])(?:\.|$)/i.test(text)) text = '_' + text;
    return text;
  }

  function imageExtension(value) {
    const url = parseHttpURL(value);
    if (!url) return 'jpg';
    const normalize = ext => {
      ext = String(ext || '').toLowerCase().replace(/^image\//, '');
      return /^(jpe?g|png|webp|gif|avif|bmp)$/.test(ext) ? (ext === 'jpeg' ? 'jpg' : ext) : null;
    };
    for (const key of ['format', 'fm', 'f', 'ext', 'wx_fmt']) {
      const ext = normalize(url.searchParams.get(key));
      if (ext) return ext;
    }
    let query;
    try { query = decodeURIComponent(url.search); } catch (_) { query = url.search; }
    const converted = query.match(/(?:format[/,=]|output=)(jpe?g|png|webp|gif|avif|bmp)(?:[\/&,;]|$)/i);
    if (converted) return normalize(converted[1]);
    const pathExt = url.pathname.match(/\.(jpe?g|png|webp|gif|avif|bmp)$/i);
    return pathExt ? normalize(pathExt[1]) : 'jpg';
  }

  function downloadFilename(name, category, value, id, at = Date.now()) {
    const date = new Date(at).toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
    return `Autohome Studio/${safeFilenamePart(name, '未命名车型')}/` +
      `${safeFilenamePart(category, '图片', 35)}_${date}_${safeFilenamePart(id, 'image', 40)}.${imageExtension(value)}`;
  }

  function asciiDownloadFilename(name, category, value, id, at = Date.now()) {
    const asciiPart = (text, fallback) => {
      const ascii = cleanText(text).normalize('NFKC').replace(/[^\x20-\x7e]+/g, '_')
        .replace(/^[_ ]+|[_ ]+$/g, '');
      return safeFilenamePart(ascii, fallback, 55);
    };
    let asciiCategory = asciiPart(category, 'image');
    if (/外观/.test(category)) asciiCategory = 'exterior';
    else if (/内饰/.test(category)) asciiCategory = 'interior';
    else if (/细节/.test(category)) asciiCategory = 'details';
    else if (/全部/.test(category)) asciiCategory = 'all';
    // Keep useful model codes (ES9/L9/911) while avoiding platform locale issues.
    return downloadFilename(asciiPart(name, 'vehicle'), asciiCategory, value, asciiPart(id, 'image'), at);
  }

  function normalizeDownload(message) {
    if (!message || typeof message !== 'object') throw new Error('下载请求无效');
    if (typeof message.requestId !== 'string' || !/^[\w.:-]{1,128}$/.test(message.requestId)) {
      throw new Error('下载请求 ID 无效');
    }
    if (!Array.isArray(message.candidates) || !message.candidates.length || message.candidates.length > LIMITS.candidates) {
      throw new Error('每次下载需要 1–8 个候选图片地址');
    }
    const candidates = [], seen = new Set();
    for (const item of message.candidates) {
      if (!item || !isImageURL(item.url)) throw new Error('只允许汽车之家或 autoimg.cn 的 HTTP(S) 图片地址');
      const url = new URL(item.url).href;
      if (seen.has(url)) continue;
      seen.add(url);
      candidates.push({ url, label: cleanText(item.label, 80) });
    }
    const seriesId = message.seriesId == null ? null : normalizeId(message.seriesId);
    if (message.seriesId != null && !seriesId) throw new Error('车型 ID 无效');
    const photoId = message.photoId == null ? null : normalizePhotoId(message.photoId);
    if (message.photoId != null && !photoId) throw new Error('PHOTO_ID_INVALID：图片 ID 须为真实数字 ID 或已验证的 1_数字 HQ ID');
    if (message.sourcePage != null && message.sourcePage !== '' && !isAutohomeURL(message.sourcePage)) throw new Error('SOURCE_PAGE_INVALID：来源页须为汽车之家链接');
    return {
      requestId: message.requestId, candidates,
      name: cleanText(message.name) || '未命名车型',
      category: cleanText(message.category, 50) || '图片',
      categoryVerified: message.categoryVerified === true,
      topics: topicList(message.topics === undefined ? [] : message.topics, true, LIMITS.selectedTopics),
      ...(photoId ? { photoId } : {}),
      ...(message.sourcePage ? { sourcePage: new URL(message.sourcePage).href } : {}),
      ...(seriesId ? { seriesId } : {})
    };
  }

  function shouldRetryDownload(reason) {
    const error = String(reason || '').toUpperCase();
    if (/CANCEL|DANGEROUS|SECURITY|VIRUS|BLOCKED|CERT|ACCESS_DENIED|FILE_|PERMISSION|NOT ALLOWED/.test(error)) return false;
    return /^(NETWORK_|SERVER_)/.test(error) || /NETWORK|SERVER RETURNED|DOWNLOAD FAILED|NET::ERR_/.test(error);
  }

  const api = Object.freeze({
    DEFAULT_SETTINGS, DEFAULT_TOPICS, LIMITS, cleanText, parseHttpURL, hasDomain, isAutohomeURL,
    isImageURL, normalizeId, normalizePhotoId, normalizeCar, normalizeSearch, applySettings,
    normalizeState, reduceState, safeFilenamePart, imageExtension,
    downloadFilename, asciiDownloadFilename, normalizeDownload, shouldRetryDownload,
    filenameKey, normalizeTopic, topicList, assertTopicConflicts
  });
  root.AHCore = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
