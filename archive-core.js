/* FRAME archive policy. Pure validation and relative path construction, no disk scan. */
(function (root) {
  'use strict';
  const Core = root.AHCore || (typeof require === 'function' ? require('./shared.js') : null);
  const TYPE = 'FRAME_ARCHIVE_CONFIG', VERSION = 1, ROOT = 'FRAME';
  const CATEGORY_BY_ID = Object.freeze({ 1: '外观', 10: '内饰', 3: '内饰', 12: '细节', 53: '官图', 55: '车展' });
  const CATEGORY_NAMES = new Set(Object.values(CATEGORY_BY_ID));
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const object = value => value && typeof value === 'object' && !Array.isArray(value);
  const utf8Size = text => Array.from(text).reduce((sum, char) => {
    const cp = char.codePointAt(0); return sum + (cp < 128 ? 1 : cp < 2048 ? 2 : cp < 65536 ? 3 : 4);
  }, 0);
  function fitBytes(text, max) {
    let out = '';
    for (const char of text) {
      if (utf8Size(out + char) > max) break;
      out += char;
    }
    return out.replace(/[. ]+$/g, '');
  }

  function category(value, verified) {
    // Seat photos are an interior subcategory. Retain compatibility with
    // already-verified v0.2/v0.3 metadata that used 座椅 as its main category.
    if (verified === true && value === '座椅') return '内饰';
    return verified === true && CATEGORY_NAMES.has(value) ? value : '未分类';
  }

  function modelName(value) {
    const name = Core.cleanText(value);
    if (!name || /^(?:汽车实拍|实拍|图片|汽车之家|全部图片|全部|未命名车型|未知车型|车型)$/u.test(name) ||
        Core.filenameKey(name) === 'frame' || !/[\p{L}\p{N}]/u.test(name)) {
      throw new Error('MODEL_REQUIRED：无法可靠识别车型，请打开具体车型大图后重试');
    }
    return name;
  }

  function modelFolder(value) {
    return Core.safeFilenamePart(modelName(value), '车型', 60);
  }

  function selectedTopics(value, available) {
    const requested = Core.topicList(value === undefined ? [] : value, true, Core.LIMITS.selectedTopics);
    return requested.map(name => {
      const found = available.find(topic => Core.filenameKey(topic) === Core.filenameKey(name));
      if (!found) throw new Error('TOPIC_NOT_FOUND：所选专题不存在，请重新选择');
      return found;
    });
  }

  function settingsStrict(value) {
    if (!object(value)) throw new Error('ARCHIVE_SETTINGS_INVALID：设置必须为对象');
    const result = Core.applySettings(Core.DEFAULT_SETTINGS, value);
    for (const key of Object.keys(value)) {
      // Accept genuine old backups while migrating obsolete switches. Do not
      // accept coerced booleans or arbitrary legacy theme strings.
      if (['archiveConfigured', 'smartRename', 'accentAutoContrast'].includes(key) && typeof value[key] === 'boolean') continue;
      if (key === 'theme' && ['dark', 'light', 'system'].includes(value[key])) continue;
      if (key === 'grayscale' && typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 100) continue;
      if (!own(Core.DEFAULT_SETTINGS, key) || result[key] !== value[key]) throw new Error('ARCHIVE_SETTINGS_INVALID：设置字段或范围无效：' + key);
    }
    return result;
  }

  function snapshot(settings, topics, name, seriesId, folder) {
    settings = Core.applySettings(Core.DEFAULT_SETTINGS, settings);
    topics = Core.topicList(topics || [], true, Core.LIMITS.selectedTopics);
    seriesId = Core.normalizeId(seriesId);
    name = modelName(name);
    if (settings.smartArchive && !seriesId) throw new Error('MODEL_REQUIRED：智能归档需要可靠的车型 ID');
    const target = settings.smartArchive ? modelFolder(folder || name) : '';
    if (settings.smartArchive) for (const topic of topics) Core.assertTopicConflicts(topic, [target, name]);
    return { version: VERSION, settings: { ...settings }, topics: settings.smartArchive ? [...topics] : [], name, seriesId, folder: target };
  }

  function restoreSnapshot(value) {
    if (!object(value) || value.version !== VERSION) throw new Error('ARCHIVE_SNAPSHOT_INVALID');
    const settings = settingsStrict(value.settings);
    if (!settings.smartArchive) {
      // Old ordinary-mode downloads could have a generic model name/no photo
      // ID. Keep their frozen metadata readable so a completed native filename
      // or an in-flight native ID survives upgrades. New planning is still
      // validated by snapshot() and filename(), never by this read migration.
      const topics = Core.topicList(value.topics || [], true, Core.LIMITS.selectedTopics);
      const name = Core.cleanText(value.name);
      if (topics.length || value.folder || !name) throw new Error('ARCHIVE_SNAPSHOT_INVALID');
      return { version: VERSION, settings, topics: [], name, seriesId: Core.normalizeId(value.seriesId), folder: '' };
    }
    return snapshot(settings, value.topics, value.name, value.seriesId, value.folder);
  }

  function originalStem(url) {
    let stem;
    try { stem = decodeURIComponent(new URL(url).pathname.split('/').pop()); }
    catch (_) { stem = new URL(url).pathname.split('/').pop(); }
    stem = stem.replace(/\.(?:jpe?g|png|webp|avif|bmp|gif)$/i, '');
    // Source attribution appears exactly once, always at the end.
    stem = stem.replace(/(?:_汽车之家)+$/u, '');
    return fitBytes(Core.safeFilenamePart(stem, '原图', 100), 210);
  }

  function filename(archive, photo, url) {
    const saved = restoreSnapshot(archive);
    if (!Core.isImageURL(url)) throw new Error('ARCHIVE_IMAGE_INVALID');
    const ext = Core.imageExtension(url), settings = saved.settings;
    const photoId = Core.normalizePhotoId(photo.photoId);
    const topic = photo.topic ? Core.normalizeTopic(photo.topic) : '';
    if (topic && (!settings.smartArchive || !saved.topics.includes(topic))) throw new Error('ARCHIVE_TOPIC_INVALID');
    if (!photoId) {
      throw new Error('PHOTO_ID_REQUIRED：未识别真实图片 ID，无法结构化命名；请打开图片详情页');
    }
    let model = Core.safeFilenamePart(modelName(saved.name), '车型', 60);
    const kind = category(photo.category, photo.categoryVerified);
    // macOS/Linux components have byte limits even when Chrome on Windows is
    // more permissive. Keep the real ID, topic and attribution intact.
    const ending = [topic, photoId, kind, '汽车之家'].filter(Boolean).join('_') + '.' + ext;
    model = fitBytes(model, Math.max(16, 238 - utf8Size(ending)));
    const stem = [model, ...(topic ? [topic] : []), photoId, kind].join('_');
    // Ordinary mode is intentionally flat but never drops structured naming.
    // Keep createFrameFolder only for old settings/config compatibility.
    const directory = settings.smartArchive ? `${ROOT}/${topic || saved.folder}/` : ROOT + '/';
    const result = directory + stem + '_汽车之家.' + ext;
    if (!safeRelativePath(result)) throw new Error('ARCHIVE_PATH_INVALID');
    return result;
  }

  function safeRelativePath(value) {
    return typeof value === 'string' && value.length <= 400 &&
      !/[\\<>:"|?*%\p{Cc}\p{Cf}\p{Cs}]/u.test(value) &&
      value.split('/').every(part => part && utf8Size(part) <= 255 && part !== '.' && part !== '..' && !/^[. ]|[. ]$/.test(part) &&
        !/^(con|prn|aux|nul|conin\$|conout\$|clock\$|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part));
  }

  function folderMap(value, strict = true) {
    if (!object(value) || Object.keys(value).length > 5000) {
      if (strict) throw new Error('ARCHIVE_FOLDERS_INVALID');
      value = {};
    }
    const out = Object.create(null), used = new Set();
    for (const [id, entry] of Object.entries(value)) {
      try {
        if (Core.normalizeId(id) !== id || !object(entry) || (strict && Object.keys(entry).some(key => key !== 'name'))) throw new Error('ARCHIVE_FOLDERS_INVALID');
        const name = modelFolder(entry.name);
        // Imports carry a segment, never paths or disguised URLs.
        if (strict && name !== entry.name) throw new Error('ARCHIVE_FOLDERS_INVALID');
        if (used.has(Core.filenameKey(name))) throw new Error('ARCHIVE_FOLDER_COLLISION：不同车型目录同名');
        used.add(Core.filenameKey(name)); out[id] = { name };
      } catch (error) { if (strict) throw error; }
    }
    return out;
  }

  function exportConfig(state, folders) {
    const settings = settingsStrict(state.settings), topics = Core.topicList(state.topics);
    const seriesFolders = folderMap(folders);
    for (const topic of topics) Core.assertTopicConflicts(topic, Object.values(seriesFolders).map(entry => entry.name));
    return { type: TYPE, version: VERSION, settings, topics, seriesFolders };
  }

  function importConfig(data) {
    if (typeof data === 'string') {
      if (data.length > 2 * 1024 * 1024) throw new Error('ARCHIVE_IMPORT_TOO_LARGE');
      try { data = JSON.parse(data); } catch (_) { throw new Error('ARCHIVE_IMPORT_INVALID_JSON'); }
    }
    if (!object(data) || data.type !== TYPE || data.version !== VERSION ||
        Object.keys(data).sort().join(',') !== 'seriesFolders,settings,topics,type,version') throw new Error('ARCHIVE_IMPORT_INVALID：不是受支持的 FRAME 配置备份');
    return exportConfig({ settings: data.settings, topics: data.topics }, data.seriesFolders);
  }

  const api = Object.freeze({ TYPE, VERSION, ROOT, CATEGORY_BY_ID, category, modelName, modelFolder,
    selectedTopics, settingsStrict, snapshot, restoreSnapshot, filename, originalStem, safeRelativePath,
    folderMap, exportConfig, importConfig });
  root.AHArchiveCore = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(globalThis);
