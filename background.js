/* MV3 service worker. Host permissions suffice; no tabs/webNavigation permission. */
'use strict';
importScripts('shared.js', 'archive-core.js', 'batch-core.js', 'search-core.js');

(function () {
  const Core = globalThis.AHCore;
  const Batch = globalThis.AHBatchCore;
  const Archive = globalThis.AHArchiveCore;
  const STATE_KEY = 'ahstudioState';
  const PENDING_KEY = 'ahstudioPendingDownloads';
  const BATCH_KEY = 'ahstudioBatchQueue';
  const FOLDERS_KEY = 'ahstudioSeriesFolders';
  const OWNED_KEY = 'ahstudioOwnedDownloads';
  const HISTORY_LIMIT = 10;
  const HOSTS = ['*://*.autohome.com.cn/*'];
  const MUTATIONS = new Set([
    'SETTINGS', 'VISIT', 'FAVORITE', 'REMOVE_RECENT', 'REMOVE_FAVORITE',
    'SEARCH', 'REMOVE_SEARCH', 'RESTORE_RECENT', 'TOPIC_ADD', 'TOPIC_REMOVE'
  ]);
  let statePromise;
  let stateQueue = Promise.resolve();
  let downloadQueue = Promise.resolve();
  const pending = new Map();
  let currentBatch = null, batchHistory = [], resolving = null, pumpScheduled = false;
  let folderCache;
  const owned = new Map();
  const ownedReady = (async () => {
    const data = await chrome.storage.local.get(OWNED_KEY);
    for (const item of (Array.isArray(data[OWNED_KEY]) ? data[OWNED_KEY] : []).slice(-5000)) {
      if (item && downloadId(item.id) && Core.isImageURL(item.url) && ['submitted', 'complete', 'interrupted'].includes(item.status)) {
        owned.set(item.id, { id: item.id, url: item.url, status: item.status,
          key: Core.cleanText(item.key, 180), filename: Core.cleanText(item.filename, 1000) });
      }
    }
  })();
  ownedReady.catch(() => {});

  const batchesReady = (async () => {
    const data = await chrome.storage.local.get(BATCH_KEY);
    const saved = data[BATCH_KEY];
    if (!saved || saved.version !== 1) return;
    currentBatch = restoreStoredBatch(saved.current);
    const seen = new Set(currentBatch ? [currentBatch.id] : []);
    batchHistory = (Array.isArray(saved.history) ? saved.history : []).slice(0, 20)
      .map(restoreStoredBatch).filter(batch => {
        if (!batch || seen.has(batch.id) || !['complete', 'stopped'].includes(batch.status)) return false;
        seen.add(batch.id); return true;
      }).slice(0, HISTORY_LIMIT - (currentBatch ? 1 : 0));
  })();
  batchesReady.catch(() => {});

  function serialState(work) {
    const result = stateQueue.then(work);
    stateQueue = result.catch(() => {});
    return result;
  }

  function serialDownload(work) {
    const result = downloadQueue.then(work);
    downloadQueue = result.catch(() => {});
    return result;
  }

  function getState() {
    if (!statePromise) {
      statePromise = chrome.storage.local.get(STATE_KEY)
        .then(data => Core.normalizeState(data[STATE_KEY]))
        .catch(error => { statePromise = undefined; throw error; });
    }
    return statePromise;
  }

  async function sendToTab(tabId, message) {
    try { await chrome.tabs.sendMessage(tabId, message); }
    catch (_) { /* A closed/navigated tab is normal; never create or close one. */ }
  }

  async function broadcast(state) {
    try {
      const tabs = await chrome.tabs.query({ url: HOSTS });
      await Promise.all(tabs.filter(tab => Number.isInteger(tab.id))
        .map(tab => sendToTab(tab.id, { type: 'STATE_CHANGED', state })));
    } catch (_) { /* Persistence still succeeded if no page can receive a message. */ }
  }

  async function mutate(message) {
    if (message.type === 'TOPIC_ADD') {
      await loadFolders();
      Core.assertTopicConflicts(Core.normalizeTopic(message.name), Object.values(folderCache).map(entry => entry.name));
    }
    const next = Core.reduceState(await getState(), message);
    // Commit storage first. A rejected write must never advance the cached state.
    await chrome.storage.local.set({ [STATE_KEY]: next });
    statePromise = Promise.resolve(next);
    await broadcast(next);
    return { ok: true, state: next };
  }

  function jobKey(tabId, requestId) { return `${tabId}:${requestId}`; }

  function batchRunning() {
    return currentBatch && ['running', 'stopping'].includes(currentBatch.status);
  }

  function batchItemFor(job) {
    return job.batchId && currentBatch && currentBatch.id === job.batchId && currentBatch.tabId === job.tabId ?
      currentBatch.items.find(item => item.id === job.batchItemId && item.requestId === job.requestId) : null;
  }

  function restoreStoredBatch(saved) {
    if (!saved || typeof saved !== 'object' || !Array.isArray(saved.items) || saved.items.length > Batch.MAX_ITEMS * 9) return null;
    // v0.4 stores photo metadata once, rather than 9 identical candidate lists.
    // Older uncompressed records remain readable by the same validator.
    const raw = saved.photoMetadata && Array.isArray(saved.items) ? {
      ...saved, items: saved.items.map(item => item && typeof item === 'object' ? {
        ...(saved.photoMetadata[item.photoId || item.id] || {}), ...item
      } : item)
    } : saved;
    const batch = Batch.restoreBatch(raw);
    if (batch) {
      if (Number.isFinite(saved.submittedAt) && saved.submittedAt >= 0) batch.submittedAt = saved.submittedAt;
      // Legacy queues had item IDs but no explicit photoId. Do not group every
      // unresolved legacy entry together as the same undefined photo.
      for (const item of batch.items) {
        if (!item.photoId) item.photoId = Core.normalizePhotoId(item.id);
        if (item.status === 'failed' && /CANCEL/i.test(item.error || '')) item.status = 'cancelled';
      }
    }
    return batch;
  }

  function storedBatch(batch) {
    if (!batch) return null;
    const photoMetadata = Object.create(null);
    const items = batch.items.map(item => {
      const { candidates, category, categoryVerified, warning, ...rest } = item;
      if (candidates) photoMetadata[item.photoId || item.id] = { candidates, category, categoryVerified, ...(warning ? { warning } : {}) };
      return rest;
    });
    return { ...batch, items, photoMetadata };
  }

  async function persistBatches(current = currentBatch, history = batchHistory) {
    await chrome.storage.local.set({ [BATCH_KEY]: {
      version: 1, current: storedBatch(current), history: history.map(storedBatch)
    } });
  }

  async function notifyBatch(batch = currentBatch) {
    if (batch) await sendToTab(batch.tabId, { type: 'BATCH_PROGRESS', batch: Batch.snapshot(batch) });
  }

  function finishBatchIfExhausted() {
    if (!currentBatch) return;
    if (!currentBatch.items.some(item => ['queued', 'resolving', 'downloading'].includes(item.status))) {
      currentBatch.status = currentBatch.status === 'stopping' || currentBatch.status === 'stopped' ? 'stopped' : 'complete';
    }
  }

  function synchronizeBatchJob(job, terminal = false) {
    const item = batchItemFor(job);
    if (!item) return;
    item.filename = job.filename;
    if (downloadId(job.currentId)) {
      item.downloadId = job.currentId;
      currentBatch.latestDownloadId = job.currentId;
    }
    else delete item.downloadId;
    if (terminal) {
      item.status = job.status === 'complete' ? 'complete' : /CANCEL/i.test(job.reason || '') ? 'cancelled' : 'failed';
      if (job.reason) item.error = job.reason;
      else delete item.error;
      delete item.job;
      finishBatchIfExhausted();
    } else {
      item.status = 'downloading';
      // Local shadow of the same native job also covers a full browser restart,
      // when Chrome clears storage.session but retains download history.
      item.job = { ...job };
    }
  }

  async function persistPending() {
    for (const job of pending.values()) synchronizeBatchJob(job);
    // Persist the local batch shadow BEFORE the session record and native call.
    // This order is important: there must never be an unrecorded submitted item.
    if (currentBatch) await persistBatches();
    await chrome.storage.session.set({ [PENDING_KEY]: Array.from(pending.values()) });
  }

  async function finish(job, status, reason, actualFilename) {
    if (!pending.has(job.key)) return;
    job.status = status;
    job.reason = reason || '';
    if (typeof actualFilename === 'string' && actualFilename) job.filename = actualFilename;
    synchronizeBatchJob(job, true);
    if (job.batchId && reason && !Core.shouldRetryDownload(reason)) {
      // Never recreate a cancelled/blocked photo through one of its topic copies.
      for (const item of currentBatch?.items || []) {
        if (item.photoId === job.photoId && item.status === 'queued') {
          item.status = 'cancelled'; item.error = 'PHOTO_COPY_CANCELLED：同图下载已取消或被阻止';
        }
      }
      finishBatchIfExhausted();
    }
    try { await recordOwned(job, status); } catch (_) {}
    pending.delete(job.key);
    // A storage outage must not suppress Chrome's authoritative terminal result.
    // If cleanup failed, a later worker may harmlessly re-notify this requestId.
    try { await persistPending(); } catch (_) {}
    if (job.batchId) await notifyBatch();
    if (!job.batchId || currentBatch?.requestId) await sendToTab(job.tabId, {
        type: 'DOWNLOAD_STATUS', requestId: currentBatch?.requestId || job.requestId, status,
        downloadId: job.currentId, filename: job.filename,
        ...(reason ? { reason, error: reason } : {})
      });
    scheduleBatch();
  }

  function downloadId(value) {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  }

  function newToken() {
    if (globalThis.crypto && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
    }
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function errorReason(error) {
    return Core.cleanText(error && error.message ? error.message : String(error || 'DOWNLOAD_FAILED'), 240);
  }

  function filenameFor(job) {
    if (job.archive) return Archive.filename(job.archive, job, job.candidates[job.index].url);
    // Legacy in-flight jobs keep their original identity through an upgrade.
    const build = job.asciiFilename ? Core.asciiDownloadFilename : Core.downloadFilename;
    return build(job.name, job.category, job.candidates[job.index].url, job.token, job.createdAt);
  }

  async function loadFolders() {
    if (!folderCache) {
      const data = await chrome.storage.local.get(FOLDERS_KEY), saved = data[FOLDERS_KEY];
      folderCache = Object.create(null);
      for (const [id, value] of Object.entries(saved && typeof saved === 'object' ? saved : {}).slice(0, 5000)) {
        if (Core.normalizeId(id) === id && value && Core.cleanText(value.name)) {
          try {
            let name = Archive.modelFolder(value.name);
            if (Object.values(folderCache).some(entry => Core.filenameKey(entry.name) === Core.filenameKey(name))) {
              name = Core.safeFilenamePart(name, '车型', 36) + '_' + id;
            }
            // v0.2 ASCII mode is deliberately not reused: preserve Chinese identity.
            folderCache[id] = { name };
          } catch (_) { /* Unknown generic model names cannot become FRAME folders. */ }
        }
      }
    }
    return folderCache;
  }

  async function canonicalFolder(name, seriesId, topics = []) {
    await loadFolders();
    const existing = folderCache[seriesId];
    let target = existing ? existing.name : Archive.modelFolder(name);
    for (const topic of topics) Core.assertTopicConflicts(topic, [target, name]);
    if (existing) return existing;
    // Never evict a saved folder: an old series must keep its existing directory.
    if (!existing && Object.keys(folderCache).length >= 5000) throw new Error('SERIES_FOLDER_LIMIT');
    if (Object.values(folderCache).some(entry => Core.filenameKey(entry.name) === Core.filenameKey(target))) {
      target = Core.safeFilenamePart(target, '车型', 36) + '_' + seriesId;
      for (const topic of topics) Core.assertTopicConflicts(topic, [target]);
    }
    if (Object.values(folderCache).some(entry => Core.filenameKey(entry.name) === Core.filenameKey(target))) throw new Error('MODEL_FOLDER_COLLISION：车型目录冲突，请更换可识别的车型名称');
    const next = { ...folderCache, [seriesId]: { name: target } };
    await chrome.storage.local.set({ [FOLDERS_KEY]: next });
    folderCache = next;
    return folderCache[seriesId];
  }

  async function recordOwned(job, status = 'submitted') {
    if (!downloadId(job.currentId)) return;
    await ownedReady;
    owned.set(job.currentId, { id: job.currentId, url: job.candidates[job.index].url,
      key: job.key, filename: job.filename, status });
    while (owned.size > 5000) owned.delete(owned.keys().next().value);
    await chrome.storage.local.set({ [OWNED_KEY]: Array.from(owned.values()) });
  }

  async function showDownload(message) {
    await downloadsReady; await ownedReady;
    if (!downloadId(message.downloadId)) throw new Error('SHOW_DOWNLOAD_INVALID_ID');
    const record = knownDownloadRecord(message.downloadId);
    if (!record) throw new Error('SHOW_DOWNLOAD_NOT_OWNED：只能定位本扩展记录的下载');
    const items = await chrome.downloads.search({ id: message.downloadId });
    const item = items.find(item => item.id === message.downloadId);
    if (!item || (item.byExtensionId && item.byExtensionId !== chrome.runtime.id) ||
        !record.urls.some(url => item.url === url || item.finalUrl === url)) throw new Error('SHOW_DOWNLOAD_NOT_OWNED');
    if (item.state !== 'complete') throw new Error('SHOW_DOWNLOAD_NOT_COMPLETE：文件尚未下载完成');
    if (item.exists !== true) throw new Error('SHOW_DOWNLOAD_MISSING：文件已移动或删除，无法定位');
    if (item.danger && !['safe', 'accepted', 'allowlistedByPolicy'].includes(item.danger)) throw new Error('FILE_SECURITY_CHECK_FAILED');
    await chrome.downloads.show(item.id);
    return { ok: true, downloadId: item.id, filename: item.filename };
  }

  function knownDownloadRecord(id) {
    const native = owned.get(id);
    if (native) return { ...native, urls: [native.url] };
    // Large 10-submission histories can exceed the auxiliary 5,000-ID cache.
    // Only IDs from fully validated retained physical outputs may fall back;
    // never query Chrome for an arbitrary caller-supplied ID.
    for (const batch of [currentBatch, ...batchHistory]) {
      const item = batch?.items.find(item => item.downloadId === id);
      if (!item) continue;
      const urls = (item.candidates || []).map(candidate => candidate.url).filter(Core.isImageURL);
      if (urls.length) return { id, urls, filename: item.filename };
    }
    return null;
  }

  function mayRetry(job) {
    return !job.batchId || (batchItemFor(job) && currentBatch.status === 'running');
  }

  async function announceRetry(job, reason) {
    if (job.batchId) {
      await notifyBatch();
      if (!currentBatch?.requestId) return;
    }
    await sendToTab(job.tabId, {
      type: 'DOWNLOAD_STATUS', requestId: currentBatch?.requestId || job.requestId, status: 'retrying',
      reason, attempt: job.index + 1, total: job.candidates.length,
      downloadId: job.currentId, filename: filenameFor(job)
    });
  }

  async function startAttempt(job) {
    let lastError = 'DOWNLOAD_FAILED';
    while (job.index < job.candidates.length) {
      const candidate = job.candidates[job.index];
      job.currentId = null;
      job.phase = 'starting';
      job.attemptStartedAt = Date.now();
      job.filename = filenameFor(job);
      // Persist the unique filename before asking Chrome to start the actual URL.
      // A fetch probe is intentionally not used: Chrome owns cookies and download state.
      await persistPending();
      let id;
      try {
        const invoke = () => chrome.downloads.download({
          url: candidate.url, filename: job.filename, saveAs: job.saveAs, conflictAction: 'uniquify'
        });
        id = await invoke();
        if (!downloadId(id)) throw new Error('Chrome 未返回有效的下载 ID');
      } catch (error) {
        lastError = /Invalid filename/i.test(errorReason(error)) ?
          'FILENAME_UNSUPPORTED：当前 Chrome 或系统拒绝中文文件名；已停止，未降级英文或合并目录。请检查系统语言与下载目录设置。' : errorReason(error);
        if (!mayRetry(job) || !Core.shouldRetryDownload(lastError) || job.index + 1 >= job.candidates.length) {
          await finish(job, 'interrupted', lastError);
          throw new Error(lastError);
        }
        job.index += 1;
        await announceRetry(job, lastError);
        continue;
      }
      job.currentId = id;
      job.phase = 'active';
      // The pre-start record already exists. If this second write fails, track
      // in memory and let startup recover the unique filename, never start twice.
      try { await persistPending(); } catch (_) {}
      try { await recordOwned(job); } catch (_) {}
      if (job.batchId) await notifyBatch();
      return { ok: true, requestId: job.requestId, downloadId: id, filename: job.filename };
    }
    await finish(job, 'interrupted', lastError);
    throw new Error(lastError);
  }

  async function applyItem(job, item, delta) {
    if (!pending.has(job.key) || !item || item.id !== job.currentId) return;
    const state = item.state || (delta && delta.state && delta.state.current);
    const danger = item.danger || job.danger;
    // Chrome may uniquify the basename or the user may choose a Save As path
    // before completion. Keep that actual native filename, not just our plan.
    const actualFilename = delta?.filename?.current || item.filename;
    if (typeof actualFilename === 'string' && actualFilename && actualFilename !== job.filename) {
      job.filename = actualFilename;
      synchronizeBatchJob(job);
      try { await persistPending(); } catch (_) {}
      try { await recordOwned(job); } catch (_) {}
    }
    if (state === 'complete') {
      // Chrome does not normally complete a dangerous file before acceptance.
      // Do not label it safe or bypass a warning if a platform reports otherwise.
      if (danger && !['safe', 'accepted', 'allowlistedByPolicy'].includes(danger)) {
        await finish(job, 'interrupted', 'FILE_SECURITY_CHECK_FAILED');
      } else {
        await finish(job, 'complete', undefined, actualFilename);
      }
    } else if (state === 'interrupted') {
      const unsafe = danger && !['safe', 'accepted', 'allowlistedByPolicy'].includes(danger);
      const reason = unsafe ? 'FILE_SECURITY_CHECK_FAILED' :
        item.error || (delta && delta.error && delta.error.current) || 'DOWNLOAD_INTERRUPTED';
      if (mayRetry(job) && Core.shouldRetryDownload(reason) && job.index + 1 < job.candidates.length) {
        try { await recordOwned(job, 'interrupted'); } catch (_) {}
        job.index += 1;
        await announceRetry(job, reason);
        try {
          await startAttempt(job);
          await reconcile(job);
        } catch (error) {
          // Also covers an inability to persist the next attempt before starting.
          await finish(job, 'interrupted', errorReason(error));
        }
      } else await finish(job, 'interrupted', reason);
    }
  }

  async function reconcile(job, delta) {
    if (!pending.has(job.key) || !downloadId(job.currentId)) return;
    if (delta?.danger?.current) job.danger = Core.cleanText(delta.danger.current, 80);
    let items;
    try { items = await chrome.downloads.search({ id: job.currentId }); }
    catch (_) {
      // onChanged carries authoritative terminal state even if history lookup fails.
      if (delta) await applyItem(job, { id: job.currentId, state: delta.state?.current }, delta);
      return;
    }
    if (items.length) await applyItem(job, items[0], delta);
    else if (delta) await applyItem(job, { id: job.currentId, state: delta.state?.current }, delta);
    else await finish(job, 'interrupted', 'DOWNLOAD_NOT_FOUND');
  }

  const downloadsReady = (async () => {
    await batchesReady; await ownedReady;
    const data = await chrome.storage.session.get(PENDING_KEY);
    const records = Array.isArray(data[PENDING_KEY]) ? data[PENDING_KEY] : [];
    if (currentBatch) {
      for (const item of currentBatch.items) {
        if (item.status === 'downloading' && item.job &&
            !records.some(job => job.tabId === currentBatch.tabId && job.requestId === item.requestId)) records.push(item.job);
      }
    }
    for (const saved of records) {
      if (pending.size >= 20) break;
      try {
        const valid = Core.normalizeDownload(saved);
        if (!Number.isInteger(saved.tabId) || saved.tabId < 0 ||
            !Number.isInteger(saved.index) || saved.index < 0 || saved.index >= valid.candidates.length ||
            typeof saved.createdAt !== 'number' || !Number.isFinite(saved.createdAt) ||
            saved.createdAt < 0 || saved.createdAt > Date.now() + 60000 ||
            typeof saved.token !== 'string' || !/^[a-zA-Z0-9]{1,40}$/.test(saved.token)) continue;
        const key = jobKey(saved.tabId, valid.requestId);
        const batchItem = saved.batchId && currentBatch && currentBatch.id === saved.batchId &&
          currentBatch.tabId === saved.tabId && currentBatch.items.find(item =>
            item.id === saved.batchItemId && item.requestId === valid.requestId && item.status === 'downloading');
        if (saved.batchId && !batchItem) continue;
        const job = {
          ...valid, key, tabId: saved.tabId, index: saved.index,
          currentId: downloadId(saved.currentId) ? saved.currentId : null,
          phase: downloadId(saved.currentId) ? 'active' : 'starting',
          createdAt: saved.createdAt, token: saved.token, saveAs: saved.saveAs === true,
          asciiFilename: saved.asciiFilename === true,
          ...(saved.danger ? { danger: Core.cleanText(saved.danger, 80) } : {}),
          ...(saved.archive && batchItem && currentBatch.archive ? {
            archive: Archive.restoreSnapshot(currentBatch.archive), topic: batchItem.topic || '',
            photoId: batchItem.photoId, category: valid.category, categoryVerified: valid.categoryVerified,
            attemptStartedAt: Number.isFinite(saved.attemptStartedAt) ? saved.attemptStartedAt : saved.createdAt
          } : {}),
          ...(batchItem ? { batchId: currentBatch.id, batchItemId: batchItem.id } : {})
        };
        job.filename = typeof saved.filename === 'string' && saved.filename ? saved.filename : filenameFor(job);
        pending.set(key, job);
        if (downloadId(job.currentId)) await recordOwned(job);
      } catch (_) { /* Discard malformed metadata, never download its contents. */ }
    }
  })();
  // Mark the initialization rejection handled, but let request handlers expose it.
  downloadsReady.catch(() => {});

  async function recoverDownloads() {
    await downloadsReady;
    for (const job of Array.from(pending.values())) {
      if (downloadId(job.currentId)) {
        await reconcile(job);
        continue;
      }
      // Rare suspend/crash gap: legacy tokens / exact extension identity isolate
      // our submission. Deterministic archive names are NOT unique request tokens.
      // If identification is uncertain, do NOT repeat a potentially active download.
      let items = [];
      try {
        items = await chrome.downloads.search({
          startedAfter: new Date(Math.max(0, (job.attemptStartedAt || job.createdAt) - 1000)).toISOString(),
          orderBy: ['-startTime'], limit: 100
        });
      } catch (_) { /* Uncertain recovery is reported instead of duplicated. */ }
      const suffix = '/' + job.filename;
      const basename = '/' + job.filename.split('/').pop();
      const matches = items.filter(item => downloadId(item.id) &&
        (!job.archive || (item.byExtensionId === chrome.runtime.id &&
          Number.isFinite(Date.parse(item.startTime)) && Date.parse(item.startTime) >= job.attemptStartedAt &&
          (!owned.has(item.id) || (owned.get(item.id).key === job.key && owned.get(item.id).status === 'submitted')))) &&
        typeof item.filename === 'string' &&
        (('/' + item.filename.replace(/\\/g, '/')).endsWith(suffix) ||
          ('/' + item.filename.replace(/\\/g, '/')).endsWith(basename)) &&
        (item.url === job.candidates[job.index].url || item.finalUrl === job.candidates[job.index].url));
      if (matches.length === 1) {
        job.currentId = matches[0].id;
        job.phase = 'active';
        await persistPending();
        try { await recordOwned(job); } catch (_) {}
        await applyItem(job, matches[0]);
      } else await finish(job, 'interrupted', 'RECOVERY_UNCERTAIN');
    }
  }

  async function beginDownload(message, sender, batchItem = null) {
    await downloadsReady;
    if (!sender.tab || !Number.isInteger(sender.tab.id) || sender.tab.id < 0) throw new Error('下载需要来自汽车之家标签页');
    const valid = Core.normalizeDownload(message);
    const key = jobKey(sender.tab.id, valid.requestId);
    const existing = pending.get(key);
    if (existing) {
      // Idempotency while active, but never reuse an ID for different URLs.
      if (JSON.stringify(existing.candidates.map(c => c.url)) !== JSON.stringify(valid.candidates.map(c => c.url))) {
        throw new Error('下载请求 ID 已被使用');
      }
      if (downloadId(existing.currentId)) {
        return { ok: true, requestId: existing.requestId, downloadId: existing.currentId, filename: existing.filename };
      }
      throw new Error('该下载请求正在处理中');
    }
    // A single global native operation keeps long batches gentle on the host.
    if (pending.size || (!batchItem && batchRunning())) throw new Error('DOWNLOAD_BUSY：请等待当前下载或批量任务完成');
    if (!batchItem) throw new Error('BATCH_ITEM_REQUIRED');
    const archive = currentBatch.archive ? Archive.restoreSnapshot(currentBatch.archive) : null;
    const settings = archive ? archive.settings : (await serialState(getState)).settings;
    const job = {
      ...valid, name: archive ? archive.name : valid.name, key, tabId: sender.tab.id, index: 0, currentId: null, phase: 'starting',
      createdAt: Date.now(), token: newToken(), saveAs: settings.saveAs,
      ...(archive ? { archive } : {}), photoId: batchItem.photoId, topic: batchItem.topic || '', filename: '',
      ...(batchItem ? { batchId: currentBatch.id, batchItemId: batchItem.id } : {})
    };
    pending.set(key, job);
    try { await startAttempt(job); }
    catch (error) {
      // Covers session-storage failures before start, without guessing download success.
      if (pending.has(key) && !downloadId(job.currentId)) {
        pending.delete(key);
        try { await persistPending(); } catch (_) {}
      }
      throw error;
    }
    // Covers downloads that completed before their onChanged event found a mapping.
    // A DOWNLOAD_STATUS may precede the initial response; correlate by requestId.
    await reconcile(job);
    if (job.status === 'interrupted') throw new Error(job.reason);
    return { ok: true, requestId: job.requestId, downloadId: job.currentId, filename: job.filename };
  }

  function batchTab(sender) {
    if (!sender.tab || !Number.isInteger(sender.tab.id) || sender.tab.id < 0) throw new Error('BATCH_REQUIRES_TAB');
    return sender.tab.id;
  }

  function findOwnedBatch(message, sender) {
    const tabId = batchTab(sender);
    if (message.batchId != null && !Batch.requestId(message.batchId)) throw new Error('BATCH_INVALID_ID');
    return [currentBatch, ...batchHistory].find(batch =>
      batch && batch.tabId === tabId && (message.batchId == null || batch.id === message.batchId)) || null;
  }

  function archivedFor(next) {
    const seen = new Set([next.id]);
    return [currentBatch, ...batchHistory].filter(batch => {
      // Submission history, not "last task per tab". Never truncate a physical
      // copy list or evict a recent submission because it contains many photos.
      if (!batch || seen.has(batch.id)) return false;
      seen.add(batch.id);
      return true;
    }).slice(0, HISTORY_LIMIT - 1);
  }

  async function beginBatch(message, sender) {
    await downloadsReady;
    const state = await serialState(getState);
    const tabId = batchTab(sender), valid = Batch.normalizeStart(message);
    const existing = [currentBatch, ...batchHistory].find(batch => batch && batch.id === valid.id);
    if (existing) {
      if (existing.tabId !== tabId) throw new Error('BATCH_BUSY_OTHER_TAB');
      if (existing.seriesId !== valid.seriesId ||
          JSON.stringify(existing.items.filter(item => !item.topic).map(item => item.url)) !== JSON.stringify(valid.items.map(item => item.url)) ||
          JSON.stringify(existing.topics || []) !== JSON.stringify(valid.topics)) {
        throw new Error('BATCH_ID_ALREADY_USED');
      }
      return { ok: true, batch: Batch.snapshot(existing) };
    }
    if (batchRunning()) throw new Error(currentBatch.tabId === tabId ? 'BATCH_BUSY' : 'BATCH_BUSY_OTHER_TAB');
    if (pending.size) throw new Error('DOWNLOAD_BUSY：请等待单张下载完成');
    const topics = Archive.selectedTopics(valid.topics, state.topics);
    if (state.settings.smartArchive || state.settings.smartRename) Archive.modelName(valid.name);
    const folder = state.settings.smartArchive ? await canonicalFolder(valid.name, valid.seriesId, state.topics) : null;
    const archive = Archive.snapshot(state.settings, topics, folder ? folder.name : valid.name, valid.seriesId, folder?.name);
    const next = { ...Batch.expandBatch(valid, archive), name: archive.name, tabId, submittedAt: Date.now() };
    const history = archivedFor(next);
    // Commit before exposing an accepted queue or starting any network request.
    await persistBatches(next, history);
    currentBatch = next; batchHistory = history;
    await notifyBatch();
    scheduleBatch();
    return { ok: true, batch: Batch.snapshot(currentBatch) };
  }

  async function beginSingle(message, sender) {
    await downloadsReady;
    const tabId = batchTab(sender), state = await serialState(getState);
    const valid = Core.normalizeDownload(message);
    let viewer = null;
    if (valid.sourcePage) {
      try { viewer = Batch.viewerURL(valid.sourcePage, valid.seriesId); }
      catch (error) {
        if (/BATCH_SERIES_MISMATCH/.test(error.message)) throw error;
      }
    }
    if (viewer) {
      // A supplied request token never substitutes for the real viewer ID.
      valid.photoId = viewer.photoId; valid.seriesId = viewer.seriesId; valid.sourcePage = viewer.url;
    }
    if ((state.settings.smartArchive || state.settings.smartRename) && !valid.photoId) {
      throw new Error('PHOTO_ID_REQUIRED：未识别真实图片 ID，请打开图片详情页后重试');
    }
    const fingerprint = JSON.stringify(valid);
    const existing = [currentBatch, ...batchHistory].find(batch => batch && batch.tabId === tabId && batch.requestId === valid.requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error('DOWNLOAD_ID_ALREADY_USED：该请求 ID 已被使用');
      return { ok: true, batch: Batch.snapshot(existing) };
    }
    if (batchRunning()) throw new Error(currentBatch.tabId === tabId ? 'BATCH_BUSY' : 'BATCH_BUSY_OTHER_TAB');
    if (pending.size) throw new Error('DOWNLOAD_BUSY：请等待当前下载完成');
    const topics = Archive.selectedTopics(valid.topics, state.topics);
    // Reject unreliable model metadata before writing a folder mapping.
    if (state.settings.smartArchive || state.settings.smartRename) Archive.modelName(valid.name);
    if (state.settings.smartArchive && !valid.seriesId) throw new Error('MODEL_REQUIRED：智能归档需要可靠的车型 ID');
    const folder = state.settings.smartArchive ? await canonicalFolder(valid.name, valid.seriesId, state.topics) : null;
    const archive = Archive.snapshot(state.settings, topics, folder ? folder.name : valid.name, valid.seriesId, folder?.name);
    const base = { id: 'single.' + newToken(), name: archive.name, seriesId: archive.seriesId, status: 'running',
      topics: valid.topics, requestId: valid.requestId, fingerprint, singleDownload: valid,
      items: [{ id: valid.photoId || 'original', photoId: valid.photoId || null, url: valid.sourcePage || '', status: 'queued',
        ...(!viewer ? { candidates: valid.candidates, category: Archive.category(valid.category, valid.categoryVerified),
          categoryVerified: valid.categoryVerified, ...(!valid.categoryVerified ? {
            warning: 'CATEGORY_UNVERIFIED：该图片类别未验证，将标注“未分类”' } : {}) } : {}) }] };
    const next = { ...Batch.expandBatch(base, archive), tabId, submittedAt: Date.now() };
    // Validate every planned relative path before accepting any native side effect.
    for (const item of next.items) Archive.filename(archive, item, valid.candidates[0].url);
    const history = archivedFor(next);
    await persistBatches(next, history);
    currentBatch = next; batchHistory = history;
    await notifyBatch(); scheduleBatch();
    return { ok: true, batch: Batch.snapshot(next) };
  }

  async function exportArchive() {
    await loadFolders();
    return { ok: true, data: Archive.exportConfig(await getState(), folderCache) };
  }

  async function importArchive(message) {
    await downloadsReady;
    if (batchRunning() || pending.size) throw new Error('ARCHIVE_IMPORT_BUSY：请等待当前任务完成后导入');
    const data = Archive.importConfig(message.data), current = await getState();
    // Never read/write native files or import URL/history/download ownership.
    const next = { ...current, settings: data.settings, topics: data.topics };
    for (const topic of next.topics) Core.assertTopicConflicts(topic, [...current.cars, ...current.favorites].map(car => car.name));
    await chrome.storage.local.set({ [STATE_KEY]: next, [FOLDERS_KEY]: data.seriesFolders });
    folderCache = data.seriesFolders; statePromise = Promise.resolve(next);
    await broadcast(next);
    return { ok: true, state: next };
  }

  async function stopBatch(message, sender) {
    await downloadsReady;
    if (!Batch.requestId(message.batchId)) throw new Error('BATCH_INVALID_ID');
    const batch = findOwnedBatch(message, sender);
    if (!batch) throw new Error('BATCH_NOT_FOUND');
    if (!['running', 'stopping'].includes(batch.status)) return { ok: true, batch: Batch.snapshot(batch) };
    batch.status = 'stopping';
    for (const item of batch.items) {
      if (item.status === 'queued' || item.status === 'resolving') {
        item.status = 'cancelled'; delete item.error;
      }
    }
    if (resolving && resolving.batch === batch) {
      resolving.controller.abort();
      resolving = null; // Late fetch results cannot launch a native operation.
    }
    finishBatchIfExhausted();
    await persistBatches();
    await notifyBatch();
    return { ok: true, batch: Batch.snapshot(batch) };
  }

  async function retryBatch(message, sender) {
    await downloadsReady;
    if (!Batch.requestId(message.batchId)) throw new Error('BATCH_INVALID_ID');
    const previous = findOwnedBatch(message, sender);
    if (!previous) throw new Error('BATCH_NOT_FOUND');
    if (batchRunning() || pending.size) throw new Error('BATCH_BUSY');
    if (!previous.items.some(item => item.status === 'failed')) return { ok: true, batch: Batch.snapshot(previous) };
    const next = {
      ...previous, status: 'running',
      items: previous.items.map(item => {
        if (item.status !== 'failed') return { ...item };
        const { downloadId, requestId, filename, error, job, ...rest } = item;
        return { ...rest, status: 'queued' };
      })
    };
    const history = archivedFor(next);
    await persistBatches(next, history);
    currentBatch = next; batchHistory = history;
    await notifyBatch(); scheduleBatch();
    return { ok: true, batch: Batch.snapshot(next) };
  }

  function scheduleBatch() {
    if (pumpScheduled || !currentBatch || currentBatch.status !== 'running') return;
    pumpScheduled = true;
    // One page resolve per native terminal event, with a small inter-item pause.
    // Active downloads wake the MV3 worker through onChanged, not an in-page timer.
    setTimeout(() => {
      pumpScheduled = false;
      serialDownload(runBatchStep).catch(error => serialDownload(() => haltBatch(error)).catch(() => {}));
    }, 350);
  }

  async function haltBatch(error) {
    if (!batchRunning()) return;
    if (resolving) { resolving.controller.abort(); resolving = null; }
    currentBatch.status = 'stopping';
    for (const item of currentBatch.items) {
      if (item.status === 'resolving') { item.status = 'failed'; item.error = errorReason(error); }
      else if (item.status === 'queued') item.status = 'cancelled';
    }
    finishBatchIfExhausted();
    // A persistence outage is explicit and fail-closed, never an automatic loop.
    try { await persistBatches(); } catch (_) {}
    await notifyBatch();
  }

  async function runBatchStep() {
    await downloadsReady;
    if (!currentBatch || currentBatch.status !== 'running' || resolving || pending.size) return;
    const batch = currentBatch, item = batch.items.find(entry => entry.status === 'queued');
    if (!item) {
      finishBatchIfExhausted();
      await persistBatches(); await notifyBatch();
      return;
    }
    // Never let inconsistent saved state start alongside an unidentified download.
    if (batch.items.some(entry => entry.status === 'downloading')) return;
    item.status = 'resolving';
    const token = { batch, item, controller: new AbortController() };
    resolving = token;
    await persistBatches(); await notifyBatch();
    if (item.candidates) {
      await resolvedBatchItem(token, { photoId: item.photoId, category: item.category,
        categoryVerified: item.categoryVerified, candidates: item.candidates, warning: item.warning });
      return;
    }
    // Fetch outside the serialized native-state lock, so BATCH_STOP can abort
    // immediately while an HTTP response or body read is still in progress.
    void Batch.fetchViewer(item.url, batch.seriesId, {
      signal: token.controller.signal, fetchImpl: globalThis.fetch
    }).then(
      result => serialDownload(() => resolvedBatchItem(token, result)),
      error => serialDownload(() => resolvedBatchItem(token, null, error))
    ).catch(error => serialDownload(() => haltBatch(error)).catch(() => {}));
  }

  async function resolvedBatchItem(token, result, error) {
    if (resolving !== token || currentBatch !== token.batch) return;
    resolving = null;
    const { batch, item } = token;
    if (batch.status !== 'running' || item.status !== 'resolving') return;
    if (error) {
      item.status = 'failed'; item.error = errorReason(error);
      for (const sibling of batch.items.filter(entry => entry.photoId === item.photoId && entry.status === 'queued')) {
        sibling.status = 'failed'; sibling.error = item.error;
      }
    } else {
      // Resolve once per photo; every sibling copy uses identical verified data.
      for (const sibling of batch.items.filter(entry => entry.photoId === item.photoId)) {
        sibling.candidates = result.candidates;
        sibling.category = Archive.category(result.category, result.categoryVerified);
        sibling.categoryVerified = result.categoryVerified === true;
        if (result.warning) sibling.warning = result.warning;
      }
      item.status = 'downloading';
      item.requestId = 'batch.' + newToken() + '.' + item.id;
      try {
        await beginDownload({
          requestId: item.requestId, name: batch.name, seriesId: batch.seriesId,
          photoId: item.photoId || undefined, sourcePage: item.url || undefined,
          category: item.category, categoryVerified: item.categoryVerified, candidates: result.candidates
        }, { tab: { id: batch.tabId } }, item);
      } catch (failure) {
        // finish() usually already recorded the native terminal failure. This
        // also covers a storage/API rejection before there was a download ID.
        if (!pending.has(jobKey(batch.tabId, item.requestId)) && !['complete', 'failed', 'cancelled'].includes(item.status)) {
          item.status = 'failed'; item.error = errorReason(failure); delete item.job;
        }
      }
    }
    finishBatchIfExhausted();
    await persistBatches(); await notifyBatch();
    scheduleBatch();
  }

  async function recoverBatch() {
    await downloadsReady;
    if (!currentBatch) return;
    // Pre-archive tasks keep their original destination policy; setup is no
    // longer a gate, and an upgrade never rewrites an already archived file.
    // A page fetch has no native side effect and may safely resume after sleep.
    // A native submission is NEVER requeued without an authoritative result.
    for (const item of currentBatch.items) {
      const job = item.requestId && pending.get(jobKey(currentBatch.tabId, item.requestId));
      if (item.status === 'resolving') item.status = currentBatch.status === 'running' ? 'queued' : 'cancelled';
      else if (item.status === 'downloading') {
        if (job && batchItemFor(job) === item) synchronizeBatchJob(job);
        else { item.status = 'failed'; item.error = 'RECOVERY_UNCERTAIN'; delete item.job; }
      } else if (item.status === 'queued' && currentBatch.status !== 'running') item.status = 'cancelled';
    }
    finishBatchIfExhausted();
    await persistBatches(); await notifyBatch();
    scheduleBatch();
  }

  function validSender(sender) {
    return !!sender && sender.id === chrome.runtime.id && Core.isAutohomeURL(sender.url);
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!validSender(sender)) {
      sendResponse({ ok: false, error: '只接受本扩展在汽车之家页面发出的请求' });
      return false;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      sendResponse({ ok: false, error: '无效请求' });
      return false;
    }
    let work;
    if (message.type === 'GET_STATE') work = serialState(async () => ({ ok: true, state: await getState() }));
    else if (message.type === 'SEARCH_SUGGEST') work = Promise.resolve().then(async () => ({
      ok: true, items: await globalThis.FrameSearch.suggest(message.query)
    }));
    else if (MUTATIONS.has(message.type)) work = message.type.startsWith('TOPIC_') ?
      serialDownload(() => serialState(() => mutate(message))) : serialState(() => mutate(message));
    else if (message.type === 'DOWNLOAD') work = serialDownload(() => beginSingle(message, sender));
    else if (message.type === 'BATCH_START') work = serialDownload(() => beginBatch(message, sender));
    else if (message.type === 'BATCH_STATUS') work = serialDownload(async () => {
      await downloadsReady;
      return { ok: true, batch: Batch.snapshot(findOwnedBatch(message, sender)) };
    });
    else if (message.type === 'DOWNLOAD_HISTORY') work = serialDownload(async () => {
      await downloadsReady;
      return { ok: true, history: [currentBatch, ...batchHistory].filter(Boolean).slice(0, HISTORY_LIMIT).map(batch => ({
        ...Batch.snapshot(batch), ...(Number.isFinite(batch.submittedAt) ? { submittedAt: batch.submittedAt } : {})
      })) };
    });
    else if (message.type === 'BATCH_STOP') work = serialDownload(() => stopBatch(message, sender));
    else if (message.type === 'BATCH_RETRY_FAILED') work = serialDownload(() => retryBatch(message, sender));
    else if (message.type === 'SHOW_DOWNLOAD') work = serialDownload(() => showDownload(message));
    else if (message.type === 'ARCHIVE_EXPORT') work = serialDownload(() => serialState(exportArchive));
    else if (message.type === 'ARCHIVE_IMPORT') work = serialDownload(() => serialState(() => importArchive(message)));
    else {
      sendResponse({ ok: false, error: '未知操作' });
      return false;
    }
    work.then(sendResponse, error => {
      const reason = errorReason(error);
      sendResponse({ ok: false, error: reason, code: reason.split(/[：:]/)[0] });
    });
    return true; // Keep Chrome's response channel open; do not make this listener async.
  });

  chrome.downloads.onChanged.addListener(delta => {
    if (!delta || !downloadId(delta.id) || (!delta.state && !delta.error && !delta.danger && !delta.filename)) return;
    serialDownload(async () => {
      await downloadsReady;
      const job = Array.from(pending.values()).find(item => item.currentId === delta.id);
      if (job) await reconcile(job, delta);
      else if (typeof delta.filename?.current === 'string' && knownDownloadRecord(delta.id)) {
        // A late filename event can arrive after terminal completion.
        for (const batch of [currentBatch, ...batchHistory]) {
          for (const item of batch?.items || []) if (item.downloadId === delta.id) item.filename = delta.filename.current;
        }
        const record = owned.get(delta.id);
        if (record) {
          record.filename = delta.filename.current;
          await chrome.storage.local.set({ [OWNED_KEY]: Array.from(owned.values()) });
        }
        await persistBatches();
      }
    }).catch(() => {});
  });

  chrome.action.onClicked.addListener(tab => {
    if (tab && Number.isInteger(tab.id) && Core.isAutohomeURL(tab.url)) {
      void sendToTab(tab.id, { type: 'TOGGLE_PANEL' });
    }
  });

  // A browser restart must wake a locally persisted queued batch even if the
  // origin tab is gone and there is no active download left to emit onChanged.
  if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(() => {
    serialDownload(async () => { await downloadsReady; scheduleBatch(); }).catch(() => {});
  });

  // Register every event listener synchronously, then reconcile persisted jobs.
  serialDownload(async () => { await recoverDownloads(); await recoverBatch(); }).catch(() => {});
})();
