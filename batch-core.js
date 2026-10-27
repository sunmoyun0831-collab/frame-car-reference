/* Full-viewer-only batch validation. Works in MV3 workers and Node: no DOM,
 * page-script execution, inferred CDN size replacements, or remote dependencies. */
(function (root) {
  'use strict';
  const Core = root.AHCore || (typeof require === 'function' ? require('./shared.js') : null);
  const Archive = root.AHArchiveCore || (typeof require === 'function' ? require('./archive-core.js') : null);
  const MAX_ITEMS = 80, MAX_HTML_BYTES = 3 * 1024 * 1024, FETCH_TIMEOUT_MS = 20000;
  const ITEM_STATES = new Set(['queued', 'resolving', 'downloading', 'complete', 'failed', 'cancelled']);
  const BATCH_STATES = new Set(['running', 'stopping', 'complete', 'stopped']);
  const requestId = value => typeof value === 'string' && /^[\w.:-]{1,64}$/.test(value);

  function viewerURL(value, expectedSeriesId) {
    const url = Core.parseHttpURL(value);
    if (!url || url.protocol !== 'https:' || !Core.hasDomain(url.hostname, 'autohome.com.cn') ||
        /[\\%]/.test(value)) throw new Error('BATCH_INVALID_VIEWER_URL');
    // Only the genuine observed viewer route. /0.html is a category's default
    // selection, NOT a particular photo. Galleries/legacy routes fail closed.
    const match = url.pathname.match(/^\/cars\/imgs-(\d{1,20})-(\d{1,20}|x)-(\d{1,20}|x)-(\d{1,20}|x)\/((?:1_)?\d{1,20})\.html$/);
    if (!match) throw new Error('BATCH_INVALID_VIEWER_URL');
    const seriesId = Core.normalizeId(match[1]), photoId = Core.normalizePhotoId(match[5]);
    if (!seriesId || !photoId) throw new Error('BATCH_INVALID_PHOTO_ID');
    if (expectedSeriesId != null && seriesId !== Core.normalizeId(expectedSeriesId)) {
      throw new Error('BATCH_SERIES_MISMATCH');
    }
    // Tracking parameters cannot change the identity or introduce redirect URLs.
    url.search = ''; url.hash = '';
    return { url: url.href, seriesId, photoId, typeId: match[3] };
  }

  function normalizeStart(message) {
    if (!message || !requestId(message.batchId)) throw new Error('BATCH_INVALID_ID');
    const seriesId = Core.normalizeId(message.seriesId), name = Core.cleanText(message.name);
    if (!seriesId || !name) throw new Error('BATCH_INVALID_SERIES');
    if (!Array.isArray(message.items) || !message.items.length || message.items.length > MAX_ITEMS) {
      throw new Error('BATCH_REQUIRES_1_TO_80_ITEMS');
    }
    const seen = new Set(), items = [];
    for (const item of message.items) {
      const page = viewerURL(item && item.url, seriesId);
      if (seen.has(page.photoId)) continue;
      seen.add(page.photoId);
      items.push({ id: page.photoId, url: page.url, status: 'queued' });
    }
    return { id: message.batchId, name, seriesId, status: 'running', items,
      topics: Core.topicList(message.topics === undefined ? [] : message.topics, true, Core.LIMITS.selectedTopics) };
  }

  function expandBatch(batch, archive) {
    return { ...batch, archive: Archive.restoreSnapshot(archive), items: batch.items.flatMap(item =>
      ['', ...archive.topics].map((topic, index) => ({
        ...item, id: index ? item.id + '.t' + index : item.id,
        photoId: item.photoId || Core.normalizePhotoId(item.id), topic
      }))) };
  }

  function snapshot(batch) {
    if (!batch) return null;
    const count = status => batch.items.filter(item => item.status === status).length;
    return {
      id: batch.id, status: batch.status, total: batch.items.length,
      photoTotal: new Set(batch.items.map(item => item.photoId || item.id)).size,
      fileTotal: batch.items.length, fileCompleted: count('complete'),
      latestDownloadId: batch.latestDownloadId ?? null,
      completed: count('complete'), failed: count('failed'), cancelled: count('cancelled'),
      remaining: count('queued') + count('resolving') + count('downloading'),
      active: count('resolving') + count('downloading'),
      name: batch.name, seriesId: batch.seriesId,
      items: batch.items.map(item => ({
        id: item.id, photoId: item.photoId || Core.normalizePhotoId(item.id), topic: item.topic || '',
        url: item.url, status: item.status,
        category: item.category || '未分类', categoryVerified: item.categoryVerified === true,
        ...(item.warning ? { warning: item.warning } : {}),
        ...(item.error ? { error: Core.cleanText(item.error, 240) } : {}),
        ...(Number.isSafeInteger(item.downloadId) && item.downloadId >= 0 ? { downloadId: item.downloadId } : {}),
        ...(item.filename ? { filename: item.filename } : {})
      })),
      ...(batch.requestId ? { requestId: batch.requestId } : {}),
      ...(batch.archive ? { topics: [...batch.archive.topics], smartArchive: batch.archive.settings.smartArchive } : {})
    };
  }

  function restoreBatch(raw) {
    try {
      if (!raw || !Number.isInteger(raw.tabId) || raw.tabId < 0 || !BATCH_STATES.has(raw.status)) return null;
      let batch;
      if (raw.archive) {
        const archive = Archive.restoreSnapshot(raw.archive);
        if (!requestId(raw.id) || !Array.isArray(raw.items) || !raw.items.length || raw.items.length > MAX_ITEMS * 9) return null;
        let base;
        if (raw.singleDownload) {
          const direct = Core.normalizeDownload(raw.singleDownload);
          if (raw.requestId !== direct.requestId || raw.items.length !== archive.topics.length + 1) return null;
          base = { id: raw.id, name: archive.name, seriesId: archive.seriesId, status: 'running',
            requestId: direct.requestId, singleDownload: direct, fingerprint: raw.fingerprint,
            items: [{ id: direct.photoId || 'original', photoId: direct.photoId || null, url: direct.sourcePage || '', status: 'queued' }] };
        } else {
          const selected = raw.items.filter(item => !item.topic);
          base = normalizeStart({ batchId: raw.id, seriesId: archive.seriesId, name: archive.name,
            topics: archive.topics, items: selected });
        }
        batch = expandBatch(base, archive);
      } else batch = normalizeStart({ ...raw, batchId: raw.id });
      if (batch.items.length !== raw.items.length) return null;
      batch.tabId = raw.tabId; batch.status = raw.status;
      batch.items = batch.items.map((item, index) => {
        const saved = raw.items[index];
        if (saved.id !== item.id || !ITEM_STATES.has(saved.status) ||
            (raw.archive && (saved.topic !== item.topic || saved.photoId !== item.photoId))) throw new Error('Invalid item');
        let metadata = {};
        if (saved.candidates) {
          const valid = Core.normalizeDownload({ requestId: 'restore', candidates: saved.candidates,
            photoId: item.photoId || undefined, category: saved.category, categoryVerified: saved.categoryVerified });
          metadata = { candidates: valid.candidates, category: Archive.category(valid.category, valid.categoryVerified),
            categoryVerified: valid.categoryVerified };
        }
        return {
          ...item, ...metadata, status: saved.status, error: Core.cleanText(saved.error, 240),
          ...(saved.warning ? { warning: Core.cleanText(saved.warning, 240) } : {}),
          ...(Number.isSafeInteger(saved.downloadId) && saved.downloadId >= 0 ? { downloadId: saved.downloadId } : {}),
          ...(typeof saved.filename === 'string' ? { filename: Core.cleanText(saved.filename, 1000) } : {}),
          ...(typeof saved.requestId === 'string' && /^[\w.:-]{1,128}$/.test(saved.requestId) ? { requestId: saved.requestId } : {}),
          // Validated separately with normalizeDownload during native recovery.
          ...(saved.job && typeof saved.job === 'object' ? { job: saved.job } : {})
        };
      });
      if (Number.isSafeInteger(raw.latestDownloadId) && batch.items.some(item => item.downloadId === raw.latestDownloadId)) batch.latestDownloadId = raw.latestDownloadId;
      return batch;
    } catch (_) { return null; }
  }

  function entities(value) {
    return String(value).replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (all, key) => {
      const names = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
      if (names[key.toLowerCase()]) return names[key.toLowerCase()];
      const number = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
      return number > 0 && number <= 0x10ffff && !(number >= 0xd800 && number <= 0xdfff) ?
        String.fromCodePoint(number) : '\ufffd';
    });
  }

  function attrs(tag) {
    const result = Object.create(null);
    const re = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
    // Skip tag name; duplicate attributes are ambiguous, so reject them.
    re.lastIndex = (tag.match(/^<\s*[a-z][\w:-]*/i) || [''])[0].length;
    let m;
    while ((m = re.exec(tag))) {
      const key = m[1].toLowerCase();
      if (Object.prototype.hasOwnProperty.call(result, key)) throw new Error('BATCH_AMBIGUOUS_HTML');
      result[key] = entities(m[2] ?? m[3] ?? m[4] ?? '');
    }
    return result;
  }

  // Small inert tokenizer rather than regexing attributes across arbitrary script
  // strings. Script/style/comment/template bodies can never supply an image.
  function inspectHTML(html) {
    const scripts = [], images = [], anchors = [], canonicals = [];
    const tagRE = /<!--[\s\S]*?-->|<![^>]*>|<\/?[a-z][\w:-]*(?:[^<>"']|"[^"]*"|'[^']*')*>/gi;
    let m, anchor = null;
    while ((m = tagRE.exec(html))) {
      const tag = m[0], named = tag.match(/^<(\/?)([a-z][\w:-]*)/i);
      if (!named) continue;
      const closing = !!named[1], name = named[2].toLowerCase();
      if (closing) {
        if (name === 'a' && anchor) {
          anchor.text = entities(html.slice(anchor.start, m.index).replace(/<[^>]*>/g, ' '));
          anchors.push(anchor); anchor = null;
        }
        continue;
      }
      if (['script', 'style', 'textarea', 'title', 'template', 'noscript'].includes(name)) {
        const close = new RegExp('</' + name + '\\s*>', 'ig');
        close.lastIndex = tagRE.lastIndex;
        const end = close.exec(html);
        if (!end) throw new Error('BATCH_INCOMPLETE_HTML');
        if (name === 'script') {
          const attributes = attrs(tag);
          if (attributes.id === '__NEXT_DATA__') scripts.push(html.slice(tagRE.lastIndex, end.index));
        }
        tagRE.lastIndex = close.lastIndex;
        continue;
      }
      if (name === 'img') {
        const attributes = attrs(tag);
        if (attributes.id === 'big-img-show') images.push(attributes);
      } else if (name === 'a') {
        anchor = { ...attrs(tag), start: tagRE.lastIndex };
      } else if (name === 'link') {
        const attributes = attrs(tag);
        if ((attributes.rel || '').toLowerCase() === 'canonical') canonicals.push(attributes.href);
      }
    }
    return { scripts, images, anchors, canonicals };
  }

  function highResolutionURL(value) {
    if (typeof value !== 'string' || /\\/.test(value)) return null;
    // The captured originalpic is HTTP; upgrade scheme only (same observed asset).
    const absolute = value.startsWith('//') ? 'https:' + value : value;
    const url = Core.parseHttpURL(absolute);
    if (!url || !Core.isImageURL(absolute) ||
        !/\.(?:jpe?g|png|webp|avif|gif|bmp)$/i.test(url.pathname)) return null;
    const sized = url.pathname.match(/(?:^|\/)(\d+)x(\d+)[_-]/);
    if (sized && (+sized[1] < 600 || (+sized[2] > 0 && +sized[2] < 400))) return null;
    // Explicitly small resize parameters are not full-viewer images either.
    for (const key of ['w', 'width', 'h', 'height']) {
      if (url.searchParams.has(key) && /^\d+$/.test(url.searchParams.get(key)) &&
          +url.searchParams.get(key) > 0 && +url.searchParams.get(key) < (key[0] === 'w' ? 600 : 400)) return null;
    }
    url.protocol = 'https:';
    return url.href;
  }

  function sameAsset(a, b) {
    if (a === b) return true;
    try {
      const aa = new URL(a), bb = new URL(b);
      if (aa.hostname !== bb.hostname) return false;
      const ai = aa.pathname.match(/autohomecar__[^/]+$/), bi = bb.pathname.match(/autohomecar__[^/]+$/);
      // Compare observed identifiers only. Never construct an asset URL from them.
      return !!ai && !!bi && aa.pathname.slice(0, aa.pathname.lastIndexOf('/')) ===
        bb.pathname.slice(0, bb.pathname.lastIndexOf('/')) &&
        ai[0].replace(/\.webp$/i, '') === bi[0].replace(/\.webp$/i, '');
    } catch (_) { return false; }
  }

  function parseViewerHTML(html, pageURL, expectedSeriesId) {
    const selected = viewerURL(pageURL, expectedSeriesId);
    if (typeof html !== 'string' || new TextEncoder().encode(html).length > MAX_HTML_BYTES) {
      throw new Error('BATCH_HTML_TOO_LARGE');
    }
    const dom = inspectHTML(html);
    if (dom.scripts.length > 1 || dom.images.length > 1 || dom.canonicals.length > 1) {
      throw new Error('BATCH_AMBIGUOUS_HTML');
    }
    for (const value of dom.canonicals) {
      let canonical;
      try { canonical = viewerURL(new URL(value, selected.url).href, selected.seriesId); }
      catch (_) { throw new Error('BATCH_PAGE_IDENTITY_MISMATCH'); }
      if (canonical.photoId !== selected.photoId) throw new Error('BATCH_PAGE_IDENTITY_MISMATCH');
    }
    const shown = dom.images.length ? highResolutionURL(dom.images[0].src) : null;
    const candidates = [];
    const add = (url, label) => {
      if (url && !candidates.some(item => item.url === url)) candidates.push({ url, label });
    };
    let name = '', category = '未分类', categoryVerified = false;
    if (dom.scripts.length) {
      let data;
      try { data = JSON.parse(dom.scripts[0]); }
      catch (_) { throw new Error('BATCH_INVALID_NEXT_DATA'); }
      const props = data && data.props && data.props.pageProps, info = props && props.imgInfo;
      const hq = selected.photoId.startsWith('1_');
      if (!props || !info || Core.normalizeId(props.seriesId) !== selected.seriesId ||
          Core.normalizePhotoId(props.idx) !== selected.photoId ||
          Core.normalizeId(info.id) !== (hq ? selected.photoId.slice(2) : selected.photoId) ||
          (hq && (Core.normalizePhotoId(info.mixid) !== selected.photoId || ![1, '1'].includes(info.ishqpic))) ||
          (!hq && info.mixid != null && Core.normalizePhotoId(info.mixid) !== selected.photoId) ||
          (props.breadInfo && props.breadInfo.seriesid != null && Core.normalizeId(props.breadInfo.seriesid) !== selected.seriesId) ||
          (data.query && data.query.seriesId != null && Core.normalizeId(data.query.seriesId) !== selected.seriesId) ||
          (data.query && data.query.idx != null && Core.normalizePhotoId(data.query.idx) !== selected.photoId)) {
        throw new Error('BATCH_PAGE_IDENTITY_MISMATCH');
      }
      const original = highResolutionURL(info.originalpic), full = highResolutionURL(info.nowebppic);
      // A present SSR viewer must agree with JSON. Stale state must never be
      // rescued by an unrelated original anchor elsewhere on the page.
      if (dom.images.length && (!shown || !full || shown !== full)) throw new Error('BATCH_SSR_IMAGE_MISMATCH');
      if (original && full && !sameAsset(original, full)) throw new Error('BATCH_IMAGE_IDENTITY_MISMATCH');
      add(original, '页面原图数据');
      add(full, '页面完整大图');
      name = Core.cleanText(props.breadInfo && props.breadInfo.seriesname);
      // imgInfo is tied to this exact photo above. props.typeId / the route may
      // describe the gallery selection (including "all"), not the current image.
      const photoType = Core.normalizeId(info.typeid ?? info.typeId);
      if (photoType && Archive.CATEGORY_BY_ID[photoType]) {
        category = Archive.CATEGORY_BY_ID[photoType]; categoryVerified = true;
      }
    } else {
      // No JSON: require both a selected-page canonical identity and a real
      // big-img-show. This deliberately rejects ambiguous older viewer layouts.
      if (!shown || dom.canonicals.length !== 1 || selected.photoId.startsWith('1_')) throw new Error('BATCH_NO_VERIFIED_FULL_IMAGE');
      for (const anchor of dom.anchors) {
        if (!/查看高清|查看原图|高清大图|原始图片/.test((anchor.text || '') + ' ' + (anchor.title || ''))) continue;
        const original = highResolutionURL(anchor.href);
        if (original && sameAsset(original, shown)) add(original, '页面高清地址');
      }
      add(shown, '当前完整大图');
    }
    if (!candidates.length) throw new Error('BATCH_NO_VERIFIED_FULL_IMAGE');
    return { ...selected, name, category, categoryVerified, candidates,
      ...(!categoryVerified ? { warning: 'CATEGORY_UNVERIFIED：该图片类别未验证，将标注“未分类”' } : {}) };
  }

  async function fetchViewer(pageURL, seriesId, options = {}) {
    const page = viewerURL(pageURL, seriesId);
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (options.signal && options.signal.aborted) throw new Error('BATCH_CANCELLED');
    if (options.signal) options.signal.addEventListener('abort', abort, { once: true });
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); },
      Math.min(FETCH_TIMEOUT_MS, Math.max(1, options.timeoutMs || FETCH_TIMEOUT_MS)));
    let reader;
    try {
      const response = await (options.fetchImpl || root.fetch)(page.url, {
        method: 'GET', credentials: 'omit', referrerPolicy: 'no-referrer',
        redirect: 'error', cache: 'no-store', signal: controller.signal
      });
      // Redirects are deliberately NOT followed, even to another allowed host.
      // Chrome's manual redirect response is opaque; rejecting is safer than
      // discovering an external redirect only after a request has already left.
      if (!response.ok || response.redirected || response.type === 'opaqueredirect') {
        throw new Error('BATCH_FETCH_HTTP_' + response.status);
      }
      const actual = viewerURL(response.url || page.url, seriesId);
      if (actual.photoId !== page.photoId) throw new Error('BATCH_PAGE_IDENTITY_MISMATCH');
      const type = (response.headers.get('content-type') || '').toLowerCase();
      if (!/^(text\/html|application\/xhtml\+xml)(?:;|$)/.test(type)) throw new Error('BATCH_NOT_HTML');
      const size = Number(response.headers.get('content-length'));
      if (size > MAX_HTML_BYTES) throw new Error('BATCH_HTML_TOO_LARGE');
      if (!response.body || !response.body.getReader) throw new Error('BATCH_NO_RESPONSE_BODY');
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let bytes = 0, html = '';
      while (true) {
        const { done, value } = await reader.read();
        if (controller.signal.aborted) throw new Error('BATCH_CANCELLED');
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_HTML_BYTES) throw new Error('BATCH_HTML_TOO_LARGE');
        html += decoder.decode(value, { stream: true });
      }
      html += decoder.decode();
      return parseViewerHTML(html, page.url, seriesId);
    } catch (error) {
      if (timedOut) throw new Error('BATCH_FETCH_TIMEOUT');
      if (controller.signal.aborted) throw new Error('BATCH_CANCELLED');
      throw error;
    } finally {
      clearTimeout(timeout);
      if (options.signal) options.signal.removeEventListener('abort', abort);
      controller.abort();
      if (reader) { try { void reader.cancel().catch(() => {}); } catch (_) {} }
    }
  }

  const api = Object.freeze({
    MAX_ITEMS, MAX_HTML_BYTES, FETCH_TIMEOUT_MS, requestId, viewerURL, normalizeStart,
    snapshot, restoreBatch, expandBatch, highResolutionURL, sameAsset, parseViewerHTML, fetchViewer
  });
  root.AHBatchCore = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
