/* FRAME floating panel. Persistence, verified search and downloads are supplied by onAction. */
(() => {
  'use strict';
  const icons = globalThis.FRAME_ICONS || {};
  const icon = name => (icons[name] || '').replace('<svg', '<svg aria-hidden="true" focusable="false"');
  const logo = '<svg class="mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false"><path d="M7 25V7h18M13 25V13h12M19 25v-6h6" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square"/></svg>';
  const escape = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const clamp = (value, min, max) => Math.max(min, Math.min(value, Math.max(min, max)));
  const windowHeight = Object.freeze({min:260,max:650,default:260});
  const version = () => {
    try {return globalThis.chrome?.runtime?.getManifest?.().version || globalThis.FRAME_VERSION || '版本未知';}
    catch {return globalThis.FRAME_VERSION || '版本未知';}
  };
  const defaults = Object.freeze({
    opacity:92, collapsed:false, theme:'dark', grayscale:0, blur:24, findSplit:50, lastMainView:'home', historyOpen:false,
    sameTab:true, saveAs:false,
    width:320, height:windowHeight.default, radius:24, accent:'#6ad2cb', accentTransparency:0, x:null, y:null,
    archiveConfigured:true, smartArchive:true, createFrameFolder:true, smartRename:true
  });
  const rootLabel = 'Chrome 默认下载位置（通常为“下载”）';
  const errorText = value => {
    const text = String(value || '操作未完成');
    if (/BATCH_BUSY_OTHER_TAB/.test(text)) return '另一个汽车之家标签页正在下载，请返回原标签查看进度或停止队列。';
    if (/BATCH_BUSY|DOWNLOAD_BUSY/.test(text)) return '已有下载正在进行，请完成或停止当前队列后再试。';
    if (/Failed to fetch|NETWORK_|BATCH_FETCH_HTTP_|BATCH_FETCH_TIMEOUT/.test(text)) return '网络读取失败，请检查连接后重试；不会使用猜测的车型或缩略图。';
    if (/BATCH_.*(?:MISMATCH|INVALID|NOT_HTML|VERIFIED|AMBIGUOUS|INCOMPLETE|RESPONSE_BODY|HTML_TOO_LARGE)/.test(text)) return '无法确认这张照片的大图地址，可能遇到验证或页面已变化；未保存缩略图。';
    if (/USER_CANCELED|BATCH_CANCELLED/.test(text)) return '已取消。';
    if (/RECOVERY_UNCERTAIN/.test(text)) return '恢复时无法确认之前的下载是否完成；为避免重复保存，请先检查 Chrome 下载记录。';
    return text;
  };
  const button = (action, title, name, extra = '') => `<button type="button" class="icon ${extra}" data-action="${action}" aria-label="${escape(title)}" title="${escape(title)}">${icon(name)}</button>`;
  const topicKey = name => String(name || '').normalize('NFKC').toLocaleLowerCase();
  const validDownloadId = id => Number.isSafeInteger(id) && id >= 0;
  const isRunning = batch => ['running','stopping','resolving','downloading','retrying'].includes(batch?.status);
  const themeOf = settings => ['dark','light'].includes(settings?.theme) ? settings.theme : typeof settings?.grayscale === 'number' && Number.isFinite(settings.grayscale) ? settings.grayscale >= 50 ? 'light' : 'dark' : defaults.theme;
  const transparencyOf = value => Number.isInteger(value) && value >= 0 && value <= 100 ? value : defaults.accentTransparency;

  globalThis.FramePanel = class {
    constructor({container = document.documentElement, embedded = false, onAction = () => {}, onAppearance = () => {}} = {}) {
      this.onAction = onAction; this.onAppearance = onAppearance; this.embedded = embedded; this.tab = 'recents'; this.view = 'home'; this.lastMainView = 'home'; this.mainViewInitialized = false;
      this.state = {cars:[], favorites:[], searches:[], topics:['灯','轮毂','翼子板'], settings:{...defaults}};
      this.page = {}; this.statusInfo = null; this.selectedTopics = new Set();
      this.search = {query:'',items:[],loading:false,error:'',open:false,active:-1};
      this.downloadHistory = []; this.historyExpanded = new Set(); this.lastDownloadTrigger = -Infinity;
      this.host = document.createElement('frame-design-assistant');
      this.host.id = 'frame-autohome-studio'; this.root = this.host.attachShadow({mode:'open'});
      this.root.innerHTML = `<style>${globalThis.FRAME_CSS || ''}</style>
        <section class="frame ${embedded ? 'embedded' : ''}" aria-label="FRAME 汽车设计参考助手" data-theme="light">
          <div class="expanded glass">
            <div class="panel-background">
              <header class="top" tabindex="0" aria-label="FRAME · 拖动空白处移动窗口，方向键也可移动" title="拖动空白处移动">
                ${button('settings','面板设置','sliders-horizontal','settings-control')}
                <span class="brand-mark" aria-hidden="true">${logo}</span>
                ${button('collapse','收起面板','minus')}
                ${button('expand','展开面板','arrow-up-right')}
              </header>
              <div class="control-rail" aria-label="搜索与下载">
                <div class="search-zone">
                  <form class="searchbox" aria-label="搜索汽车之家">
                    ${button('find','搜索车型','search','search-switch')}
                    <input id="frame-car-search" type="search" role="combobox" aria-label="搜索品牌或车型" aria-autocomplete="list" aria-controls="frame-search-list" aria-expanded="false" autocomplete="off" placeholder="搜索品牌或车型" maxlength="80">
                    <button type="submit" data-action="search-submit" title="在汽车之家搜索网页">搜索</button>
                  </form>
                  <div class="search-popover" hidden><div class="suggestion-heading">车型候选 · 直达图库</div><div id="frame-search-list" role="listbox" aria-label="车型候选"></div><p class="search-key-hint">↑ ↓ 浏览 · Enter 搜索 · 点击车型直达图库</p></div>
                </div>
                <button class="download-pill" data-action="download-control" type="button" aria-label="切换到下载">${icon('download')}<span>下载</span></button>
              </div>
              <section class="home-view">
                <nav class="library-tabs" aria-label="车型资料列表">
                  <button type="button" data-action="recents" aria-pressed="true">最近</button>
                  <button type="button" data-action="favorites" aria-pressed="false">收藏</button>
                </nav>
                <div class="home-scroll"><div class="body">
                  <section class="main list-pane" aria-label="最近浏览车型"><div class="section-head"><h2>最近</h2><span class="count"></span></div><div class="recents"></div></section>
                  <div class="find-divider" role="separator" tabindex="0" aria-label="调整最近浏览与收藏的宽度" aria-orientation="vertical" aria-valuemin="30" aria-valuemax="70" aria-valuenow="50"></div>
                  <section class="side list-pane" aria-label="收藏车型"><div class="section-head"><h2>收藏</h2><span class="favorite-count count"></span></div><div class="library-favorites"></div></section>
                </div></div>
              </section>
              <section class="download-view" aria-label="图片下载" hidden>
                  <section class="gallery-tools" aria-label="图库多选">
                    <div class="gallery-heading"><span class="gallery-count"></span><button class="selection-button" type="button" data-action="gallery-mode" aria-pressed="false">${icon('check')}<span>多选</span></button></div>
                    <div class="gallery-actions" hidden><button type="button" class="text-button" data-action="gallery-all">全选本页</button><button type="button" class="text-button" data-action="gallery-clear">清空选择</button></div>
                    <p class="download-context hint"></p>
                  </section>
                <div class="download-content">
                  <section class="destinations" aria-label="下载到">
                    <div class="destination-head"><span>下载到</span><button type="button" class="text-button" data-action="topic-edit" aria-pressed="false">编辑专题</button></div>
                    <div class="topic-chips"></div>
                    <form class="topic-form" aria-label="新建专题" hidden>
                      <label class="sr-only" for="frame-topic-name">专题名称</label>
                      <input id="frame-topic-name" data-action="topic-name" placeholder="输入专题名称" maxlength="40" autocomplete="off">
                      <button type="submit" class="soft" data-action="topic-confirm">添加</button>
                      ${button('topic-cancel','取消添加专题','x')}
                    </form>
                    <div class="topic-removal" role="group" aria-label="确认移除专题标签" hidden>
                      <p class="topic-removal-message"></p>
                      <p class="hint">只移除标签，已有文件和文件夹都会保留。重新添加相同名称，会继续使用原文件夹。</p>
                      <div><button type="button" class="text-button" data-action="topic-remove-cancel">取消</button><button type="button" class="soft" data-action="topic-remove-confirm">确认移除标签</button></div>
                    </div>
                    <p class="topic-error inline-error" role="alert" hidden></p>
                    <p class="destination-note hint"></p>
                  </section>
                  <section class="batch-progress" hidden aria-label="当前下载进度">
                    <div class="batch-head"><strong></strong><span></span></div>
                    <progress value="0" max="1" aria-label="文件下载完成进度"></progress>
                    <p class="batch-note"></p>
                    <div class="batch-bottom">
                      <button type="button" class="text-button" data-action="show-download" disabled>${icon('folder-open')}查看下载</button>
                      <button type="button" class="text-button" data-action="batch-stop">停止剩余</button>
                    </div>
                  </section>
                  <section class="download-history" aria-label="最近下载">
                    <button type="button" class="history-toggle" data-action="history-toggle" aria-expanded="false" aria-controls="frame-history-list"><span>最近下载</span>${icon('chevron-down')}</button>
                    <div id="frame-history-list" class="history-list" role="region" aria-label="下载记录" tabindex="0" hidden></div>
                  </section>
                </div>
              </section>
              <section class="settings" hidden aria-label="面板设置">
                <div class="settings-intro"><h2>设置</h2><span>保存在此浏览器</span></div>
                <section class="settings-section">
                  <div class="section-head"><h3>外观</h3><button type="button" class="text-button" data-action="reset-appearance">恢复外观</button></div>
                  <div class="setting-row"><span id="frame-theme-label">主题</span><div class="segmented" role="group" aria-labelledby="frame-theme-label"><button type="button" data-action="theme-dark" aria-pressed="false">深色</button><button type="button" data-action="theme-light" aria-pressed="true">浅色</button></div></div>
                  <label class="setting-row range-row">背景模糊<div><input data-setting="blur" data-action="blur" aria-label="背景模糊" type="range" min="0" max="40" value="24"><output data-output="blur">24 px</output></div></label>
                  <label class="setting-row range-row">不透明度<div><input data-setting="opacity" data-action="opacity" aria-label="面板不透明度" type="range" min="40" max="100" value="92"><output data-output="opacity">92%</output></div></label>
                  <label class="setting-row range-row">圆角<div><input data-setting="radius" data-action="radius" aria-label="面板圆角" type="range" min="0" max="24" value="24"><output data-output="radius">24 px</output></div></label>
                  <div class="setting-row"><label for="frame-accent">强调色</label><div class="accent-controls"><input type="color" data-setting="accent-picker" data-action="accent-picker" value="#6ad2cb" aria-label="选择强调色"><input id="frame-accent" data-setting="accent" data-action="accent" value="#6ad2cb" maxlength="7" placeholder="#6ad2cb" spellcheck="false" aria-label="强调色 HEX"></div></div>
                  <p class="accent-error inline-error" role="alert" hidden>请输入完整的十六进制颜色，例如 #6ad2cb。</p>
                  <label class="setting-row range-row">主题色不透明度<div><input data-setting="accentOpacity" data-action="accentOpacity" aria-label="主题色不透明度" type="range" min="0" max="100" step="1" value="100"><output data-output="accentOpacity">100%</output></div></label>
                </section>
                <section class="settings-section">
                  <div class="section-head"><h3>窗口</h3><button type="button" class="text-button" data-action="reset-window">恢复窗口</button></div>
                  <label class="setting-row range-row">宽度<div><input data-setting="width" data-action="width" aria-label="面板宽度" type="range" min="320" max="760" step="1" value="320"><output data-output="width">320 px</output></div></label>
                  <label class="setting-row range-row">高度<div><input data-setting="height" data-action="height" aria-label="面板高度" type="range" min="${windowHeight.min}" max="${windowHeight.max}" step="1" value="${windowHeight.default}"><output data-output="height">${windowHeight.default} px</output></div></label>
                  <p class="hint">拖动顶部空白处移动，拖动右下角调整尺寸。搜索与下载共用窗口大小；宽窗可拖动列表间的分隔线，窄窗可切换最近浏览和收藏。</p>
                </section>
                <section class="settings-section">
                  <div class="section-head"><h3>下载与资料库</h3></div>
                  <div class="setting-row"><span>智能归档</span><button type="button" class="toggle" data-action="smartArchive" role="switch" aria-label="智能归档" aria-checked="true"><span class="track"></span></button></div>
                  <p class="archive-warning inline-error">强烈不建议关闭</p>
                  <div class="setting-row"><span>下载时另存为</span><button type="button" class="toggle" data-action="saveAs" role="switch" aria-label="下载时另存为" aria-checked="false"><span class="track"></span></button></div>
                  <p class="archive-summary"></p><p class="hint download-root">${rootLabel}</p><p class="hint">“另存为”或 Chrome 的“下载前询问保存位置”会覆盖建议路径；FRAME 不会更改浏览器下载目录。</p>
                </section>
                <section class="settings-section">
                  <div class="setting-row"><span>同页浏览</span><button type="button" class="toggle" data-action="sameTab" role="switch" aria-label="同页浏览" aria-checked="true"><span class="track"></span></button></div>
                </section>
                <details class="maintenance">
                  <summary>${icon('wrench')}帮助与维护<span class="chevron">${icon('chevron-down')}</span></summary>
                  <div class="maintenance-body">
                    <p>下载使用 Chrome 默认下载位置下的相对路径。智能归档会保存到 FRAME / 车型，并为所选专题另存一份；文件使用智能命名，不把缩略图当成大图。</p>
                    <p>已有 FRAME 目录会自动复用：Chrome 会在现有目录下创建文件，不需要也不会扫描磁盘。重名文件按浏览器规则处理。</p>
                    <p>设置、专题、浏览与收藏保存在本机扩展存储，卸载会清除。导出的资料库配置仅包含设置、专题与车型目录映射，不包含照片、收藏和浏览搜索记录；导入不移动照片，也不会找回未导出的配置。</p>
                    <div class="maintenance-actions"><button type="button" class="soft" data-action="archive-export">${icon('file-down')}导出资料库配置</button><button type="button" class="soft" data-action="archive-import">${icon('folder-open')}接入已有资料库</button><button type="button" class="soft" data-action="diagnostic">${icon('wrench')}复制诊断</button></div>
                    <input class="archive-file" data-action="archive-file" type="file" accept=".json,application/json" aria-label="导入之前导出的资料库配置 JSON" hidden>
                    <p class="archive-feedback" role="status" hidden></p>
                    <p>Ctrl / Command / 鼠标中键可开新标签。下载失败时，可复制当前页面诊断信息排查。</p>
                  </div>
                </details>
                <details class="maintenance about">
                  <summary>关于<span class="chevron">${icon('chevron-down')}</span></summary>
                  <div class="maintenance-body">
                    <p class="about-version">FRAME ${escape(version())}</p>
                    <p>非汽车之家官方产品。图片权利归原权利人，仅下载你有权使用的内容。</p>
                    <p>图标使用 Lucide（ISC 许可，部分 Feather 衍生图标采用 MIT 许可）；字体使用 Manrope（SIL Open Font License 1.1）。第三方许可全文随扩展附带。</p>
                  </div>
                </details>
              </section>
              <div class="status" role="status" aria-live="polite" hidden></div>
              <button type="button" class="resize-corner" data-action="resize" aria-label="调整窗口尺寸；方向键也可调整" title="拖动调整尺寸"><span></span></button>
            </div>
          </div>
        </section>`;
      container.append(this.host);
      this.el = this.$('.frame');
      this.root.addEventListener('click', event => {
        Promise.resolve(this.click(event)).catch(error => this.status(errorText(error.message), true));
      });
      this.root.addEventListener('auxclick', event => {
        if (event.button !== 1) return;
        const target = event.target.closest('[data-action]');
        if (!['open','category','repeat-search','select-car'].includes(target?.dataset.action)) return;
        event.preventDefault();
        Promise.resolve(this.click(event)).catch(error => this.status(errorText(error.message), true));
      });
      this.root.addEventListener('keydown', event => this.keydown(event));
      this.$('.topic-form').addEventListener('submit', event => {event.preventDefault(); this.addTopic();});
      this.bindSearch(); this.bindSettings(); this.bindDrag(); this.bindDivider();
      this.$('.history-list').addEventListener('toggle', event => {
        const record = event.target.closest('[data-record]');
        if (!record) return;
        if (record.open) this.historyExpanded.add(record.dataset.record);
        else this.historyExpanded.delete(record.dataset.record);
      }, true);
      this.$('.archive-file').addEventListener('change', event => this.importArchive(event.target));
      this.resize = () => this.position();
      this.blur = () => {this.finishPointer(); this.finishDivider();};
      window.addEventListener('resize', this.resize);
      window.addEventListener('blur', this.blur);
      window.visualViewport?.addEventListener('resize', this.resize);
      window.visualViewport?.addEventListener('scroll', this.resize);
      this.outsidePointer = event => {
        if (this.search.open && !event.composedPath().includes(this.$('.search-zone'))) this.closeSearch();
      };
      document.addEventListener('pointerdown', this.outsidePointer, true);
      this.render();
    }
    $(selector) {return this.root.querySelector(selector);}
    $$(selector) {return [...this.root.querySelectorAll(selector)];}
    async dispatch(action) {
      const result = await this.onAction(action);
      if (result === false || result?.ok === false) throw new Error(errorText(result?.error || '操作未保存，请重试。'));
      return result;
    }
    async saveSettings(patch) {
      patch = {...patch};
      delete patch.accentAutoContrast;
      if (!Object.keys(patch).length) return;
      const result = await this.dispatch({type:'settings',patch});
      // Parent normally calls setState before resolving. Also support hosts returning state.
      if (result?.state) this.setState(result.state);
      else {
        const settings = {...this.state.settings,...patch};
        delete settings.accentAutoContrast;
        settings.theme = themeOf(settings); settings.grayscale = settings.theme === 'light' ? 100 : 0;
        this.state = {...this.state,settings}; this.render();
      }
      return result;
    }
    async click(event) {
      const target = event.target.closest('[data-action]');
      if (!target || target.disabled || target.closest('[inert]')) return;
      const type = target.dataset.action;
      if (type === 'search-submit') {this.searchSubmitModified = !!(event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1); return;}
      if (['drag','resize','topic-confirm','topic-name','archive-file','opacity','radius','width','height','blur','accent','accent-picker','accentOpacity'].includes(type)) return;
      if (type === 'find' || type === 'home') return this.activateView('home');
      if (type === 'download-control' || type === 'download' || type === 'batch-start') return this.triggerDownload(event);
      if (type === 'settings') {
        const expansion = this.state.settings.collapsed ? this.setCollapsed(false,false) : null;
        this.switchView(this.view === 'settings' && !expansion ? this.lastMainView : 'settings');
        return expansion;
      }
      if (type === 'status-dismiss') {this.status(''); return;}
      if (type === 'history-toggle') return this.setHistoryOpen(!(this.historyOpenPreview ?? this.state.settings.historyOpen));
      if (type === 'undo') {
        const previous = this.statusInfo;
        await this.dispatch({type});
        if (this.statusInfo === previous) this.status('');
        return;
      }
      if (type === 'recents' || type === 'favorites') {
        this.tab = type; this.renderView(); return;
      }
      if (type === 'collapse' || type === 'expand') return this.setCollapsed(type === 'collapse');
      if (['sameTab','smartArchive','saveAs'].includes(type)) {
        const patch = {[type]:!this.state.settings[type]};
        if (type === 'smartArchive') patch.smartRename = true;
        return this.saveSettings(patch);
      }
      if (type === 'theme' || type === 'theme-dark' || type === 'theme-light') {
        return this.saveSettings({theme:type === 'theme' ? themeOf(this.state.settings) === 'dark' ? 'light' : 'dark' : type === 'theme-dark' ? 'dark' : 'light'});
      }
      if (type === 'reset-appearance') return this.saveSettings({theme:defaults.theme,blur:24,opacity:92,radius:24,accent:defaults.accent,accentTransparency:defaults.accentTransparency});
      if (type === 'reset-window' || type === 'resetPosition') {
        this.finishPointer();
        return this.saveSettings({x:null,y:null,width:defaults.width,height:windowHeight.default,findSplit:50});
      }
      if (type === 'topic-edit') {
        this.editingTopics = !this.editingTopics;
        this.removingTopic = null; this.renderDestinations();
        this.$('[data-action="topic-edit"]').focus({preventScroll:true}); return;
      }
      if (type === 'topic-remove-request') {
        this.removingTopic = target.dataset.topic; this.setTopicError(''); this.renderTopicRemoval();
        this.$('[data-action="topic-remove-cancel"]').focus({preventScroll:true}); return;
      }
      if (type === 'topic-remove-cancel') {
        this.removingTopic = null; this.renderTopicRemoval();
        this.$('[data-action="topic-edit"]').focus({preventScroll:true}); return;
      }
      if (type === 'topic-remove-confirm') return this.removeTopic();
      if (type === 'topic-toggle') {
        const name = target.dataset.topic;
        if (this.selectedTopics.has(name)) this.selectedTopics.delete(name);
        else if (this.getDestinations().length < 8) this.selectedTopics.add(name);
        else {this.setTopicError('每次下载最多选择 8 个专题，请先取消一个。'); return;}
        this.setTopicError('');
        this.renderDestinations(); this.renderToolbar(); this.focusTopic(name); return;
      }
      if (type === 'topic-add') {
        this.$('.topic-form').hidden = false; this.setTopicError('');
        this.$('#frame-topic-name').focus({preventScroll:true}); this.position(); return;
      }
      if (type === 'topic-cancel') {
        this.$('.topic-form').hidden = true; this.setTopicError(''); this.position(); return;
      }
      if (type === 'select-car') return this.selectSuggestion(Number(target.dataset.index), event);
      if (type === 'show-download') {
        const downloadId = target.hasAttribute('data-download-id') ? Number(target.dataset.downloadId) : this.resultDownloadId();
        if (validDownloadId(downloadId)) return this.dispatch({type,downloadId});
        return;
      }
      if (type === 'batch-retry' || type === 'batch-stop') {
        if (this.queueActionPending || (type === 'batch-retry' && (isRunning(this.batch) || this.busy || this.submitting))) return;
        const record = type === 'batch-retry' ? this.downloadHistory.find(record => String(record.id) === target.dataset.batchId) : null;
        if (type === 'batch-retry' && !this.canRetryRecord(record)) return;
        if (type === 'batch-stop' && (!isRunning(this.batch) || this.batch?.single)) return;
        const restoreFocus = this.root.activeElement === target;
        this.queueActionPending = true;
        this.renderBatch(); this.renderHistory();
        try {return await this.dispatch(type === 'batch-retry' ? {type,batchId:record.id} : {type});}
        finally {
          this.queueActionPending = false; this.renderBatch(); this.renderHistory();
          if (restoreFocus) {
            const retry = this.$$('[data-action="batch-retry"]').find(button => button.dataset.batchId === target.dataset.batchId);
            (type === 'batch-retry' ? retry || this.$('[data-action="download-control"]') : this.$('[data-action="batch-stop"]'))?.focus({preventScroll:true});
          }
        }
      }
      if (type === 'archive-import') {this.$('.archive-file').click(); return;}
      if (type === 'archive-export') {
        target.disabled = true; this.archiveFeedback('正在导出资料库配置…');
        try {await this.dispatch({type}); this.archiveFeedback('资料库配置已交给 Chrome 下载。请保留这份 JSON，照片不会打包进配置。');}
        catch (error) {this.archiveFeedback(errorText(error.message),true);}
        finally {target.disabled = false;}
        return;
      }
      await this.dispatch({type,id:target.closest('[data-id]')?.dataset.id,category:target.dataset.category,query:target.dataset.query,modified:!!(event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1)});
    }
    async setCollapsed(collapsed, focus = true) {
      this.closeSearch();
      const anchor = this.el.getBoundingClientRect(), previous = this.state.settings;
      this.state = {...this.state,settings:{...previous,collapsed}}; this.render();
      const next = this.el.getBoundingClientRect(), v = this.viewport();
      const x = Math.round(clamp(anchor.right - next.width,v.x + 8,v.x + v.width - next.width - 8));
      const y = Math.round(clamp(anchor.bottom - next.height,v.y + 8,v.y + v.height - next.height - 8));
      // Update geometry synchronously so a click can focus the search field without
      // awaiting storage, an animation frame, or a transition.
      this.state.settings = {...this.state.settings,x,y}; this.position();
      if (focus) this.$(collapsed ? '[data-action="expand"]' : this.view === 'home' ? '.searchbox input' : '[data-action="download-control"]')?.focus({preventScroll:true});
      try {await this.saveSettings({collapsed,x,y});}
      catch (error) {this.state = {...this.state,settings:previous}; this.render(); throw error;}
    }
    activateView(view) {
      if (view === 'download') this.downloadArmedAt = Date.now() + 500;
      const expansion = this.state.settings.collapsed ? this.setCollapsed(false,false) : null;
      this.switchView(view);
      return expansion;
    }
    async triggerDownload(event = {}) {
      // The compact control is navigation, never submission. Consume the first
      // click (including while collapsed/gray), then reject rapid second clicks.
      if (this.state.settings.collapsed || this.view !== 'download') return this.activateView('download');
      const now = Date.now();
      if (event.detail > 1 || now < (this.downloadArmedAt || 0) || now - this.lastDownloadTrigger < 900 ||
          this.submitting || this.busy || isRunning(this.batch) || !this.photoCount()) return;
      this.lastDownloadTrigger = now; this.submitting = true; this.renderToolbar();
      try {return await this.dispatch({type:this.page.image ? 'download' : 'batch-start'});}
      finally {this.submitting = false; this.renderToolbar();}
    }
    setState(state) {
      if (!state) return;
      const incoming = state.settings || {};
      const settings = {...defaults,...this.state.settings,...incoming};
      settings.accentTransparency = transparencyOf(settings.accentTransparency);
      delete settings.accentAutoContrast;
      // Migrate legacy hosts before defaults can mask a saved grayscale value.
      settings.theme = themeOf(Object.hasOwn(incoming,'theme') || Object.hasOwn(incoming,'grayscale') ? incoming : settings);
      settings.grayscale = settings.theme === 'light' ? 100 : 0;
      this.state = {...this.state,...state,settings};
      if (!this.mainViewInitialized) {
        this.mainViewInitialized = true;
        this.lastMainView = settings.lastMainView === 'download' ? 'download' : 'home';
        this.view = this.lastMainView;
        if (this.view === 'download') this.downloadArmedAt = Date.now() + 500;
      }
      this.state.settings.smartRename = true;
      this.state.settings.createFrameFolder = true;
      if (!Array.isArray(this.state.topics)) this.state.topics = [];
      const available = new Set(this.state.topics);
      this.selectedTopics = new Set([...this.selectedTopics].filter(name => available.has(name)));
      if (!this.state.settings.smartArchive) this.selectedTopics.clear();
      this.render();
    }
    setPage(page) {
      const next = page || {};
      const key = `${next.car?.id || ''}|${next.categoryKey || next.category || ''}`;
      if (key !== this.pageKey) {this.pageKey = key; this.$('.topic-form').hidden = true; this.removingTopic = null; this.setTopicError('');}
      this.page = next;
      this.syncTopicSelection(next.car?.id || this.gallery?.seriesId);
      this.renderCars(); this.renderLibrary(); this.renderToolbar(); this.position();
    }
    setBusy(busy) {this.busy = !!busy; this.renderToolbar(); this.renderHistory(); this.position();}
    setGallery(gallery) {
      this.gallery = gallery;
      this.syncTopicSelection(gallery?.seriesId || this.page.car?.id);
      this.renderToolbar(); this.position();
    }
    syncTopicSelection(seriesId) {
      const id = String(seriesId || '');
      if (!/^\d+$/.test(id) || id === this.topicSelectionSeries) return;
      this.topicSelectionSeries = id; this.selectedTopics.clear();
      // Synchronous, tab-scoped storage survives immediate page navigation.
      // Keep one active series only; never carry destinations to another car.
      try {
        const saved = !this.embedded && JSON.parse(globalThis.sessionStorage?.getItem('frame-topic-selection-v1') || 'null');
        if (saved?.seriesId === id && Array.isArray(saved.topics) && this.state.settings.smartArchive) {
          this.selectedTopics = new Set(saved.topics.filter(name => this.state.topics.includes(name)).slice(0,8));
        }
      } catch {}
      this.persistTopicSelection();
    }
    persistTopicSelection() {
      if (this.embedded || !this.topicSelectionSeries) return;
      const record = JSON.stringify({seriesId:this.topicSelectionSeries,topics:this.getDestinations()});
      if (record === this.savedTopicSelection) return;
      try {
        globalThis.sessionStorage?.setItem('frame-topic-selection-v1',record);
        this.savedTopicSelection = record;
      } catch {}
    }
    currentCar() {
      return this.page.car || [...(this.state.cars || []),...(this.state.favorites || [])].find(car => String(car.id) === String(this.gallery?.seriesId));
    }
    photoCount() {
      return this.page.image ? 1 : this.gallery?.enabled ? Number(this.gallery.selectedCount ?? this.gallery.selected) || 0 : 0;
    }
    getDestinations() {
      if (!this.state.settings.smartArchive) return [];
      const carKey = topicKey(this.currentCar()?.name);
      return this.state.topics.filter(name => this.selectedTopics.has(name) && topicKey(name) !== carKey).slice(0,8);
    }
    renderToolbar() {
      const single = !!this.page.image, count = this.photoCount();
      const busy = !!(this.busy || this.submitting || isRunning(this.batch)), eligible = count > 0 && !busy;
      const active = this.view === 'download' && !this.state.settings.collapsed;
      const download = this.$('.download-pill');
      download.classList.toggle('eligible',eligible); download.classList.toggle('active',active);
      // Inactive controls must remain clickable even when there is no target.
      download.disabled = active && !eligible;
      download.setAttribute('aria-disabled',String(active && !eligible));
      download.setAttribute('aria-label',!active ? '切换到下载' : busy ? '正在下载' : !count ? '暂无可下载的图片' : single ? '下载此图' : `下载 ${count} 张图片`);
      download.title = !active ? '切换到下载，不会立即下载' : busy ? '请等待当前队列完成，或停止剩余任务' : !count ? '打开一张实拍大图，或在图库开启多选' : '按所选目的地保存';
      download.querySelector('span').textContent = busy ? '正在下载' : single ? '下载此图' : count ? `下载 ${count} 张` : '下载';
      const gallery = this.$('.gallery-tools');
      const available = !single && !!this.gallery?.available;
      gallery.querySelector('.gallery-count').textContent = single ? '1 张 · 当前大图' : available ? `${this.gallery?.selectedCount ?? this.gallery?.selected ?? 0} / ${this.gallery?.count || 0} 张` : '0 张 · 暂无可下载图片';
      const mode = gallery.querySelector('[data-action="gallery-mode"]');
      mode.hidden = !available;
      mode.querySelector('span').textContent = this.gallery?.enabled ? '退出多选' : '多选';
      mode.setAttribute('aria-pressed', String(!!this.gallery?.enabled));
      gallery.querySelector('.gallery-actions').hidden = !available || !this.gallery?.enabled;
      gallery.querySelector('[data-action="gallery-clear"]').disabled = !this.photoCount();
      this.$('.download-context').textContent = single || available ? this.currentCar()?.name || '当前图库' : '打开实拍大图可下载单张；在图库中使用多选可批量下载。';
      this.renderDestinations();
    }
    renderDestinations() {
      const area = this.$('.destinations'), smart = !!this.state.settings.smartArchive;
      area.hidden = false;
      const photos = this.photoCount(), destinations = this.getDestinations();
      const car = this.currentCar();
      const chips = this.$('.topic-chips');
      const edit = this.$('[data-action="topic-edit"]'); edit.hidden = !smart;
      edit.textContent = this.editingTopics ? '完成编辑' : '编辑专题';
      edit.setAttribute('aria-pressed',String(!!this.editingTopics));
      if (smart) {
        const html = `<span class="topic-chip required" aria-label="${escape(car?.name || '当前车型')}，必选">${icon('check')}<span>${escape(car?.name || '当前车型')}<small>必选</small></span></span>` +
          this.state.topics.map(name => `<span class="topic-entry"><button type="button" class="topic-chip" data-action="topic-toggle" data-topic="${escape(name)}" aria-pressed="${destinations.includes(name)}" ${topicKey(name) === topicKey(car?.name) ? 'disabled title="专题名称与当前车型冲突"' : ''}>${escape(name)}</button>${this.editingTopics ? `<button type="button" class="topic-remove" data-action="topic-remove-request" data-topic="${escape(name)}" aria-label="移除专题标签 ${escape(name)}" title="移除专题标签，不删除文件" ${this.topicRemoving ? 'disabled' : ''}>${icon('x')}</button>` : ''}</span>`).join('') +
          `<button type="button" class="topic-chip topic-add" data-action="topic-add" aria-label="添加专题" title="${this.state.topics.length >= 50 ? '资料库最多保留 50 个专题' : '添加专题'}" ${this.state.topics.length >= 50 ? 'disabled' : ''}>${icon('plus')}</button>`;
        const focused = this.root.activeElement, focusTopic = focused?.dataset?.topic, focusAction = focused?.dataset?.action;
        this.updateMarkup(chips,html);
        if (focusTopic) [...chips.querySelectorAll('[data-topic]')].find(el => el.dataset.topic === focusTopic && el.dataset.action === focusAction)?.focus({preventScroll:true});
        this.$('.destination-note').textContent = `车型和专题文件夹各存一份 · ${photos} 张 / ${photos * (1 + destinations.length)} 份`;
      } else {
        this.selectedTopics.clear(); this.updateMarkup(chips,''); this.$('.topic-form').hidden = true; this.removingTopic = null; this.setTopicError('');
        this.$('.destination-note').textContent = `${rootLabel} / FRAME · 普通下载，不生成专题副本`;
      }
      chips.hidden = !smart;
      this.persistTopicSelection();
      this.renderTopicRemoval();
    }
    renderTopicRemoval() {
      const area = this.$('.topic-removal'); area.hidden = !this.removingTopic;
      this.$('.topic-removal-message').textContent = this.removingTopic ? `移除“${this.removingTopic}”专题标签？` : '';
      area.querySelectorAll('button').forEach(el => {el.disabled = !!this.topicRemoving;});
    }
    async removeTopic() {
      const name = this.removingTopic;
      if (!name || this.topicRemoving) return;
      this.topicRemoving = true; this.setTopicError(''); this.renderTopicRemoval();
      try {
        const result = await this.dispatch({type:'topic-remove',name});
        if (result?.state) this.setState(result.state);
        if (this.state.topics.some(topic => topicKey(topic) === topicKey(name))) throw new Error('未收到专题移除确认，请重试。');
        this.selectedTopics.delete(name); this.removingTopic = null; this.renderToolbar();
        this.status('已移除专题标签，文件和文件夹保持不变。');
        this.$('[data-action="topic-edit"]').focus({preventScroll:true});
      } catch (error) {this.setTopicError(errorText(error.message));}
      finally {this.topicRemoving = false; this.renderDestinations();}
    }
    setTopicError(text) {const el = this.$('.topic-error'); el.hidden = !text; el.textContent = text;}
    validateTopic(raw) {
      const name = String(raw).normalize('NFKC').trim().replace(/\s+/gu,' ');
      if (!name) return '请输入专题名称。';
      if (Array.from(name).length > 40) return '专题名称最多 40 个字符。';
      if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(raw) || !/^[\p{L}\p{N}\p{M} _()（）·\-]+$/u.test(name) || !/[\p{L}\p{N}]/u.test(name)) return '请使用中文、英文或数字；名称不能包含路径、隐藏字符或不安全符号。';
      if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(name)) return '该名称是系统保留名称，请换一个。';
      if (topicKey(name) === 'frame') return 'FRAME 是资料库根目录，不能用作专题名称。';
      if (topicKey(name) === topicKey(this.currentCar()?.name)) return '专题名称不能与当前车型相同。';
      if (this.state.topics.some(item => topicKey(item) === topicKey(name))) return '这个专题已经存在，请直接选择。';
      if (this.state.topics.length >= 50) return '资料库最多保留 50 个专题。';
      return '';
    }
    async addTopic() {
      if (this.topicSaving) return;
      const input = this.$('#frame-topic-name'), error = this.validateTopic(input.value);
      const name = input.value.normalize('NFKC').trim().replace(/\s+/gu,' ');
      this.setTopicError(error); if (error) return;
      this.topicSaving = true; const submit = this.$('[data-action="topic-confirm"]'); submit.disabled = true;
      const contextKey = this.pageKey;
      try {
        const result = await this.dispatch({type:'topic-add',name});
        if (result?.state) this.setState(result.state);
        if (!this.state.topics.includes(name)) throw new Error('未收到专题保存确认，请重试。');
        if (contextKey === this.pageKey && this.state.settings.smartArchive && this.getDestinations().length < 8) this.selectedTopics.add(name);
        else if (this.getDestinations().length >= 8) this.setTopicError('专题已添加；每次最多选择 8 个，请先取消一个再选它。');
        input.value = ''; this.$('.topic-form').hidden = true; this.renderToolbar(); this.focusTopic(name);
      } catch (error) {this.setTopicError(errorText(error.message));}
      finally {this.topicSaving = false; submit.disabled = false; this.position();}
    }
    focusTopic(name) {this.$$('[data-action="topic-toggle"]').find(el => el.dataset.topic === name)?.focus({preventScroll:true});}

    bindSearch() {
      const input = this.$('.searchbox input'), form = this.$('.searchbox');
      input.addEventListener('input', event => {
        this.search.query = input.value;
        if (!this.composing && !event.isComposing) this.queueSuggestions();
      });
      input.addEventListener('compositionstart', () => {this.composing = true; clearTimeout(this.searchTimer); this.closeSearch();});
      input.addEventListener('compositionend', () => {this.composing = false; this.search.query = input.value; this.queueSuggestions();});
      // Focus is intentionally silent. Candidates appear only after input or an
      // explicit ArrowDown, never from a view switch or a previous query.
      input.addEventListener('keydown', event => {
        if (event.isComposing || this.composing || event.keyCode === 229) return;
        if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); this.closeSearch(); return;}
        if (['ArrowDown','ArrowUp'].includes(event.key)) {
          if (!this.search.open && event.key === 'ArrowUp') return;
          event.preventDefault(); event.stopPropagation(); this.search.open = !!input.value.trim();
          this.search.query = input.value;
          if (this.search.items.length) this.search.active = (this.search.active + (event.key === 'ArrowDown' ? 1 : this.search.active < 0 ? 0 : -1) + this.search.items.length) % this.search.items.length;
          else if (!this.search.loading) this.queueSuggestions();
          this.renderSuggestions();
          this.$('[role="option"][aria-selected="true"]')?.scrollIntoView({block:'nearest'}); return;
        }
        if (event.key === 'Enter') this.searchSubmitModified = !!(event.ctrlKey || event.metaKey || event.shiftKey);
        if (event.key === 'Tab') this.closeSearch();
      });
      form.addEventListener('submit', event => {
        event.preventDefault(); if (this.composing) return;
        const query = input.value.trim(); if (!query) return;
        this.closeSearch();
        const modified = this.searchSubmitModified || !!(event.ctrlKey || event.metaKey || event.shiftKey);
        this.searchSubmitModified = false;
        this.dispatch({type:'search',query,modified}).catch(error => this.status(errorText(error.message),true));
      });
      this.$('.search-popover').addEventListener('pointerdown', event => {
        if (event.target.closest('[data-action="select-car"]')) event.preventDefault();
      });
    }
    queueSuggestions() {
      clearTimeout(this.searchTimer);
      const query = this.search.query.trim();
      this.search = {...this.search,items:[],active:-1,error:'',loading:!!query,open:!!query};
      this.renderSuggestions();
      if (!query) return;
      this.searchTimer = setTimeout(async () => {
        this.searchTimer = null;
        try {await this.dispatch({type:'suggest',query});}
        catch (error) {this.setSearchSuggestions({query,items:[],loading:false,error:errorText(error.message)});}
      }, 240);
    }
    setSearchSuggestions({query = '',items = [],loading = false,error = ''} = {}) {
      if (String(query).trim() !== this.$('.searchbox input').value.trim()) return false;
      // Cars arrive already verified by the integration layer. Never invent IDs or fallback records.
      const verified = Array.isArray(items) ? items.filter(car => car && car.id != null && car.name && car.url && car.links) : [];
      const previousId = this.search.items[this.search.active]?.id;
      this.search = {...this.search,query:String(query),items:verified,loading:!!loading,error:error ? errorText(error.message || error) : ''};
      this.search.active = verified.findIndex(car => car.id === previousId);
      this.renderSuggestions();
      return true;
    }
    renderSuggestions() {
      const input = this.$('.searchbox input'), popover = this.$('.search-popover'), search = this.search;
      const open = search.open && !!input.value.trim() && this.view === 'home' && !this.state.settings.collapsed;
      popover.hidden = !open; input.setAttribute('aria-expanded',String(open));
      const list = this.$('#frame-search-list'); list.setAttribute('aria-busy',String(search.loading));
      if (!open) {input.removeAttribute('aria-activedescendant'); return;}
      if (search.loading) list.innerHTML = '<p class="search-message" role="status">正在联网查找车型…</p>';
      else if (search.error) list.innerHTML = `<p class="search-message inline-error" role="status">${escape(search.error)}<br>未获得可靠候选。可重试，或使用“搜索”打开搜索网页。</p>`;
      else if (!search.items.length) list.innerHTML = '<p class="search-message" role="status">暂无匹配车型。可换个品牌或车型关键词，或使用“搜索”打开搜索网页。</p>';
      else list.innerHTML = search.items.map((car,index) => `<button type="button" class="candidate" role="option" id="frame-candidate-${index}" data-action="select-car" data-index="${index}" tabindex="-1" aria-selected="${index === search.active}"><div><strong>${escape(car.name)}</strong><span>打开汽车之家图库</span></div>${icon('arrow-up-right')}</button>`).join('');
      if (search.active >= 0 && !search.loading && !search.error) input.setAttribute('aria-activedescendant',`frame-candidate-${search.active}`);
      else input.removeAttribute('aria-activedescendant');
    }
    closeSearch() {
      if (this.searchTimer) {clearTimeout(this.searchTimer); this.searchTimer = null; this.search.loading = false;}
      this.search.open = false; this.renderSuggestions();
    }
    async selectSuggestion(index,event = {}) {
      const car = this.search.items[index]; if (!car || this.search.loading || this.search.error) return;
      const query = this.$('.searchbox input').value.trim();
      this.closeSearch();
      await this.dispatch({type:'select-car',car,query,modified:!!(event.ctrlKey || event.metaKey || event.shiftKey || event.button === 1)});
    }

    setBatch(batch) {
      this.batch = batch || null;
      if (batch?.id) {
        const index = this.downloadHistory.findIndex(record => record.id === batch.id);
        if (index >= 0) this.downloadHistory[index] = batch;
        else this.downloadHistory.unshift(batch);
        this.downloadHistory = this.downloadHistory.slice(0,10);
      }
      this.renderBatch(); this.renderHistory(); this.renderToolbar(); this.position();
    }
    setDownloadHistory(records) {
      if (!Array.isArray(records)) return;
      const seen = new Set();
      this.downloadHistory = records.filter(record => {
        if (!record || record.id == null || seen.has(String(record.id))) return false;
        seen.add(String(record.id)); return true;
      }).slice(0,10);
      // The current queue may be newer than the last persistence read.
      if (this.batch && isRunning(this.batch)) {
        const index = this.downloadHistory.findIndex(record => record.id === this.batch.id);
        if (index >= 0) this.downloadHistory[index] = this.batch;
        else this.downloadHistory = [this.batch,...this.downloadHistory].slice(0,10);
      }
      this.renderHistory();
    }
    setDownload(result) {return this.setDownloadResult(result);}
    setDownloadResult(result) {
      if (!result) {if (this.batch?.single) this.setBatch(null); return;}
      const status = result.status || 'complete';
      const items = Array.isArray(result.items) ? result.items : [{
        photoId:result.photoId,topic:result.topic,filename:result.filename,downloadId:result.downloadId,
        status:status === 'complete' ? 'complete' : ['error','failed','interrupted'].includes(status) ? 'failed' : 'downloading',error:result.error || result.reason
      }];
      const done = result.fileCompleted ?? result.completed ?? items.filter(item => item.status === 'complete').length;
      this.setBatch({
        ...result,single:true,id:result.id || result.requestId || `single-${result.downloadId ?? Date.now()}`,
        status:['error','interrupted'].includes(status) ? 'failed' : status,
        items,photoTotal:result.photoTotal ?? 1,fileTotal:result.fileTotal ?? result.total ?? items.length,
        total:result.fileTotal ?? result.total ?? items.length,fileCompleted:done,completed:done,
        failed:result.failed ?? items.filter(item => item.status === 'failed').length,
        latestDownloadId:result.latestDownloadId ?? (status === 'complete' ? result.downloadId : null)
      });
    }
    resultDownloadId() {
      const batch = this.batch; if (!batch) return null;
      const completeItems = (batch.items || []).filter(item => item.status === 'complete' && validDownloadId(item.downloadId));
      const done = batch.fileCompleted ?? batch.completed ?? completeItems.length;
      if (done < 1 && !completeItems.length) return null;
      if (validDownloadId(batch.latestDownloadId)) {
        const known = (batch.items || []).find(item => item.downloadId === batch.latestDownloadId);
        if (!known || known.status === 'complete') return batch.latestDownloadId;
      }
      return completeItems.length ? completeItems[completeItems.length - 1].downloadId : null;
    }
    renderBatch() {
      const batch = this.batch, area = this.$('.batch-progress');
      // Terminal results belong only to their history record, not a second
      // filled progress bar that remains above the same file details.
      area.hidden = !isRunning(batch);
      if (area.hidden) return;
      const items = batch.items || [];
      const done = batch.fileCompleted ?? batch.completed ?? 0, total = batch.fileTotal ?? batch.total ?? items.length;
      const photoIds = new Set(items.map(item => item.photoId || item.url || item.id).filter(Boolean));
      const photos = batch.photoTotal ?? (photoIds.size || total), failed = batch.failed ?? items.filter(item => item.status === 'failed').length;
      area.querySelector('.batch-head strong').textContent = '大图下载队列';
      area.querySelector('.batch-head > span').textContent = `${photos} 张图片 · ${total} 份文件`;
      const progress = area.querySelector('progress'); progress.max = total || 1; progress.value = done;
      progress.setAttribute('aria-valuetext',`${done} / ${total} 份文件完成`);
      const active = items.find(item => ['resolving','downloading'].includes(item.status));
      area.querySelector('.batch-note').textContent = batch.status === 'stopping' ? '正在停止剩余任务，等待当前文件完成。'
        : active?.status === 'resolving' ? `正在读取大图地址 · ${done} / ${total} 份文件完成`
        : `${done} / ${total} 份文件完成 · ${failed} 份失败 · 正在保存`;
      const stop = area.querySelector('[data-action="batch-stop"]'); stop.hidden = !!batch.single;
      area.querySelector('[data-action="show-download"]').disabled = this.resultDownloadId() === null;
      stop.disabled = batch.status === 'stopping' || !!this.queueActionPending;
    }
    canRetryRecord(record) {
      // The host's existing retry action targets its current owned batch.
      // Do not offer a misleading retry on older/global history records.
      return !!record && !!this.batch && String(record.id) === String(this.batch.id) &&
        !record.single && !this.batch.single && !isRunning(record) && !isRunning(this.batch) &&
        (this.batch.items || []).some(item => item.status === 'failed');
    }
    fileStatus(status) {
      return {complete:'已完成',failed:'失败',interrupted:'中断',downloading:'正在保存',resolving:'读取大图',pending:'等待中',queued:'等待中',cancelled:'已停止',stopped:'已停止'}[status] || '等待确认';
    }
    fileMarkup(item) {
      const confirmed = item.status === 'complete';
      // snapshot.filename is Chrome-confirmed only when complete. While the
      // queue runs it can still be the requested path, not the resulting name.
      const actualPath = String(item.filename || '');
      const basename = actualPath.replace(/\\/g,'/').split('/').pop();
      const filename = basename ? `${confirmed ? '' : '待确认文件名 · '}${basename}`
        : confirmed ? 'Chrome 未回传文件名，可在下载记录中确认。' : '等待下载确认文件名';
      const reveal = confirmed && validDownloadId(item.downloadId)
        ? `<button type="button" class="text-button reveal-file" data-action="show-download" data-download-id="${item.downloadId}" aria-label="在文件夹中显示 ${escape(item.filename || '已下载文件')}">${icon('folder-open')}打开文件夹</button>` : '';
      return `<div class="result-file"><div class="file-meta"><span class="${item.status === 'failed' ? 'inline-error' : ''}">${escape(this.fileStatus(item.status))} · ${escape(item.topic || '车型文件')}</span>${item.photoId ? `<span>照片 ${escape(item.photoId)}</span>` : ''}</div><p class="file-name" title="${escape(actualPath)}">${escape(filename)}</p>${item.error ? `<p class="inline-error">${escape(errorText(item.error))}</p>` : ''}${item.warning ? `<p class="hint">${escape(item.warning)}</p>` : ''}${reveal}</div>`;
    }
    renderHistory() {
      this.renderHistoryVisibility();
      const container = this.$('.history-list');
      const records = this.downloadHistory;
      const html = records.length ? records.map(record => {
        const items = Array.isArray(record.items) ? record.items : [];
        const total = record.fileTotal ?? record.total ?? items.length;
        const done = record.fileCompleted ?? record.completed ?? items.filter(item => item.status === 'complete').length;
        const failed = record.failed ?? items.filter(item => item.status === 'failed').length;
        const cancelled = record.cancelled ?? items.filter(item => item.status === 'cancelled').length;
        const heading = record.name || '下载提交';
        const state = isRunning(record) ? '进行中' : record.status === 'stopped' ? '已停止' : failed ? '含失败文件' : done === total && total ? '已完成' : '等待确认';
        const summary = `${state} · ${done} / ${total} 份${failed ? ` · ${failed} 份失败` : ''}${cancelled ? ` · ${cancelled} 份停止` : ''}`;
        const retry = this.canRetryRecord(record) ? `<div class="record-actions"><button type="button" class="text-button" data-action="batch-retry" data-batch-id="${escape(record.id)}" aria-label="重试 ${escape(heading)} 的失败文件" ${this.queueActionPending || this.busy || this.submitting ? 'disabled' : ''}>重试失败</button></div>` : '';
        const files = items.length ? items.map(item => this.fileMarkup(item)).join('') : '<p class="hint">尚未收到文件明细，未推测保存路径。</p>';
        if (items.length <= 1) return `<article class="history-record"><div class="record-heading"><strong>${escape(heading)}</strong><span>${escape(summary)}</span></div>${retry}${files}</article>`;
        return `<details class="history-record" data-record="${escape(record.id)}" ${this.historyExpanded.has(String(record.id)) ? 'open' : ''}><summary><span class="record-heading"><strong>${escape(heading)}</strong><span>${escape(summary)}</span></span><span class="record-expand">${items.length} 份文件${icon('chevron-down')}</span></summary><div class="record-files">${retry}${files}</div></details>`;
      }).join('') : '<p class="history-empty hint">下载后，这里会保留最近 10 次提交，以及每一份文件的真实状态与保存路径。</p>';
      // Avoid recreating focused reveal buttons or resetting details on polls.
      if (container._renderedHTML !== html) {
        const focused = this.root.activeElement, id = focused?.dataset?.downloadId, batchId = focused?.dataset?.batchId;
        const scroll = this.$('.download-content').scrollTop;
        const historyScroll = container.scrollTop;
        container.innerHTML = html; container._renderedHTML = html;
        if (id) container.querySelector(`[data-download-id="${Number(id)}"]`)?.focus({preventScroll:true});
        if (batchId) [...container.querySelectorAll('[data-action="batch-retry"]')].find(button => button.dataset.batchId === batchId && !button.disabled)?.focus({preventScroll:true});
        this.$('.download-content').scrollTop = scroll;
        container.scrollTop = historyScroll;
      }
    }
    renderHistoryVisibility() {
      const open = (this.historyOpenPreview ?? this.state.settings.historyOpen) === true;
      this.$('[data-action="history-toggle"]').setAttribute('aria-expanded',String(open));
      this.$('.history-list').hidden = !open;
    }
    setHistoryOpen(open) {
      this.historyOpenPreview = !!open;
      const revision = this.historyRevision = (this.historyRevision || 0) + 1;
      this.renderHistoryVisibility();
      // Keep the disclosure responsive during storage writes. Data refreshes,
      // failures and view changes never decide whether this quiet section opens.
      this.historySave = (this.historySave || Promise.resolve())
        .then(() => this.saveSettings({historyOpen:!!open}))
        .catch(error => this.status(errorText(error.message),true))
        .finally(() => {
          if (revision !== this.historyRevision) return;
          this.historyOpenPreview = null; this.renderHistoryVisibility();
        });
      return this.historySave;
    }
    status(text,error = false,undo = false) {
      // Ordinary success/progress messages are intentionally silent. Background
      // completion must not erase an outstanding error or an available undo.
      if (text && !error && !undo && (this.statusInfo?.error || this.statusInfo?.undo || this.$('.status').querySelector('textarea'))) return;
      const visible = !!text && (!!error || !!undo);
      this.statusInfo = visible ? {text,error:!!error,undo:!!undo} : null;
      const status = this.$('.status');
      status.hidden = !visible || !!this.state.settings.collapsed;
      status.classList.toggle('error',visible && !!error);
      status.setAttribute('role',error && visible ? 'alert' : 'status');
      status.setAttribute('aria-live',error && visible ? 'assertive' : 'polite');
      status.innerHTML = visible ? `<span>${escape(text)}</span>${undo ? '<button type="button" class="text-button" data-action="undo">撤销</button>' : ''}${button('status-dismiss','关闭提示','x')}` : '';
      this.position();
    }

    // Compatibility for an older content script: there is no setup UI.
    async ensureDownloadSetup() {return true;}
    keydown(event) {
      if (event.key !== 'Escape') return;
      if (this.removingTopic && !this.topicRemoving) {this.removingTopic = null; this.renderTopicRemoval(); event.stopPropagation();}
      else if (!this.$('.topic-form').hidden) {this.$('.topic-form').hidden = true; event.stopPropagation();}
      else if (this.view === 'settings') {this.switchView(this.lastMainView); event.stopPropagation();}
    }
    archiveFeedback(text,error = false) {const el = this.$('.archive-feedback'); el.hidden = !text; el.textContent = text; el.classList.toggle('inline-error',error);}
    async importArchive(input) {
      const file = input.files?.[0]; if (!file) return;
      const trigger = this.$('[data-action="archive-import"]'); trigger.disabled = true;
      this.archiveFeedback('正在验证资料库配置…');
      try {
        if (file.size > 2 * 1024 * 1024) throw new Error('配置文件过大，请选择 FRAME 导出的 JSON 配置。');
        let data;
        try {data = JSON.parse(await file.text());} catch (_) {throw new Error('无法读取 JSON，请选择之前导出的资料库配置。');}
        const result = await this.dispatch({type:'archive-import',data});
        if (result?.state) this.setState(result.state);
        this.selectedTopics.clear(); this.renderToolbar();
        this.archiveFeedback('资料库配置已导入。之后的下载会复用同名目录；已有照片不移动。');
      } catch (error) {this.archiveFeedback(errorText(error.message),true);}
      finally {input.value = ''; trigger.disabled = false;}
    }

    switchView(view, {persist = true, focus = true} = {}) {
      const next = view === 'find' || view === 'search' ? 'home' : view;
      if (!['home','download','settings'].includes(next)) return;
      const mainChanged = next !== 'settings' && next !== this.lastMainView;
      if (next === 'download' && this.view !== 'download') this.downloadArmedAt = Date.now() + 500;
      if (next !== 'settings') this.lastMainView = next;
      this.view = next; this.closeSearch(); this.renderView(); this.renderToolbar(); this.position();
      if (focus && !this.state.settings.collapsed) this.$(next === 'home' ? '.searchbox input' : next === 'download' ? '[data-action="download-control"]' : '[data-action="settings"]')?.focus({preventScroll:true});
      if (persist && mainChanged) {
        // Keep focus/navigation synchronous, but serialize writes so a slower
        // earlier save cannot replace the latest main view. Always catch errors.
        this.viewSave = (this.viewSave || Promise.resolve())
          .then(() => this.saveSettings({lastMainView:next}))
          .catch(error => this.status(errorText(error.message),true));
      }
    }
    renderView() {
      const collapsed = !!this.state.settings.collapsed;
      this.el.dataset.view = this.view; this.el.dataset.list = this.tab;
      this.$('.home-view').hidden = collapsed || this.view !== 'home';
      this.$('.download-view').hidden = collapsed || this.view !== 'download';
      this.$('.settings').hidden = collapsed || this.view !== 'settings';
      this.$('.control-rail').hidden = !collapsed && this.view === 'settings';
      this.$('.resize-corner').hidden = collapsed;
      const status = this.$('.status');
      const diagnostic = !!status.querySelector('textarea');
      if (this.statusInfo && !this.statusInfo.error && !this.statusInfo.undo) {
        this.statusInfo = null;
        if (!diagnostic) status.innerHTML = '';
      }
      status.hidden = collapsed || !(this.statusInfo?.text || diagnostic);
      this.$('[data-action="collapse"]').hidden = collapsed;
      this.$('[data-action="expand"]').hidden = !collapsed;
      const searchActive = !collapsed && this.view === 'home';
      this.$('.search-zone').classList.toggle('active',searchActive);
      this.$('.searchbox input').hidden = !searchActive;
      this.$('[data-action="search-submit"]').hidden = !searchActive;
      const settings = this.$('[data-action="settings"]');
      settings.classList.toggle('on',this.view === 'settings');
      settings.title = this.view === 'settings' && !collapsed ? this.lastMainView === 'download' ? '返回下载' : '返回搜索' : '面板设置';
      settings.setAttribute('aria-label',settings.title);
      settings.setAttribute('aria-pressed',String(this.view === 'settings' && !collapsed));
      for (const type of ['recents','favorites']) this.$(`[data-action="${type}"]`).setAttribute('aria-pressed',String(this.tab === type));
      if (!searchActive) this.closeSearch();
      else this.renderSuggestions();
      this.applySplit();
    }
    render() {
      const s = this.state.settings, collapsed = !!s.collapsed;
      this.el.classList.toggle('collapsed',collapsed);
      for (const key of ['sameTab','smartArchive','saveAs']) {
        this.$(`[data-action="${key}"]`).setAttribute('aria-checked',String(!!s[key]));
      }
      for (const theme of ['dark','light']) this.$(`[data-action="theme-${theme}"]`).setAttribute('aria-pressed',String(themeOf(s) === theme));
      this.applyAppearance(); this.syncSettingInputs(); this.renderView();
      this.$('.archive-summary').textContent = s.smartArchive ? '默认智能归档 · FRAME / 车型 · 始终智能命名' : '普通下载 · FRAME 文件夹 · 始终智能命名，不生成专题副本';
      this.renderCars(); this.renderLibrary(); this.renderToolbar(); this.renderBatch(); this.renderHistory(); this.position();
    }
    carMarkup(car, favorites = false) {
      const saved = (this.state.favorites || []).some(item => String(item.id) === String(car.id));
      return `<article class="car ${String(car.id) === String(this.page.car?.id) ? 'current' : ''}" data-id="${escape(car.id)}">
        <div class="car-top"><button type="button" class="car-title" data-action="open" title="${escape(car.name)}">${escape(car.name)}</button>
          ${button(favorites ? 'unfavorite' : 'favorite',saved ? '取消收藏 '+car.name : '收藏 '+car.name,favorites ? 'bookmark-minus' : 'bookmark',saved ? 'on' : '')}
          ${favorites ? '' : button('remove','从最近浏览移除 '+car.name,'x')}</div>
        <div class="car-actions">${[['all','全部'],['exterior','外观'],['interior','内饰'],['details','细节']].map(([key,name]) => `<button type="button" class="category" data-action="category" data-category="${key}" ${car.links?.[key] ? '' : `disabled title="此页面尚未识别到${name}入口，请先打开车型"`}>${name}</button>`).join('')}</div>
      </article>`;
    }
    updateMarkup(element, html) {
      if (element._renderedHTML === html) return;
      element.innerHTML = html; element._renderedHTML = html;
    }
    renderCars() {
      const cars = this.state.cars || [];
      this.$('.main .count').textContent = `${cars.length} 辆`;
      this.updateMarkup(this.$('.recents'),cars.length ? cars.map(car => this.carMarkup(car)).join('') : '<div class="empty"><strong>从一辆车开始</strong>搜索品牌或车型，或打开实拍图库。最近浏览会出现在这里。</div>');
    }
    renderLibrary() {
      const favorites = this.state.favorites || [];
      this.$('.favorite-count').textContent = favorites.length;
      this.updateMarkup(this.$('.library-favorites'),favorites.length ? favorites.map(car => this.carMarkup(car,true)).join('') : '<div class="empty"><strong>留住想再看的车</strong>点一下车型旁的书签，收藏会一直在这里。</div>');
    }
    bindSettings() {
      this.$$('[data-setting]').forEach(input => {
        input.addEventListener('input', () => {
          this.syncRangeFill(input);
          const key = input.dataset.setting;
          const patch = this.settingValue(key,input.value);
          if (!patch) return;
          this.appearancePreview = {...this.appearancePreview,...patch};
          this.applyAppearance(); this.position(); this.syncSettingOutputs({...this.state.settings,...this.appearancePreview});
          if (key === 'accent-picker') this.$('[data-setting="accent"]').value = patch.accent;
          if (key === 'accent') this.$('[data-setting="accent-picker"]').value = patch.accent;
        });
        input.addEventListener('change', async () => {
          const patch = this.settingValue(input.dataset.setting,input.value);
          if (!patch) return;
          try {await this.saveSettings(patch);}
          catch (error) {this.status(errorText(error.message),true);}
          finally {this.appearancePreview = null; this.applyAppearance(); this.syncSettingInputs(); this.position();}
        });
      });
    }
    settingValue(key,value) {
      if (key === 'accent' || key === 'accent-picker') {
        const valid = /^#[\da-f]{6}$/i.test(value);
        this.$('.accent-error').hidden = valid; this.$('[data-setting="accent"]').setAttribute('aria-invalid',String(!valid));
        return valid ? {accent:value.toLowerCase()} : null;
      }
      // Keep the stored transparency value for lossless upgrades; invert only
      // at the UI boundary so the slider now means opacity.
      if (key === 'accentOpacity') return value !== '' && Number.isFinite(Number(value)) ? {accentTransparency:100-Math.round(clamp(Number(value),0,100))} : null;
      const limits = {opacity:[40,100],radius:[0,24],width:[320,760],height:[windowHeight.min,windowHeight.max],blur:[0,40]};
      return limits[key] && value !== '' && Number.isFinite(Number(value)) ? {[key]:Math.round(clamp(Number(value),...limits[key]))} : null;
    }
    syncSettingOutputs(s) {
      this.$$('[data-output]').forEach(output => {const key = output.dataset.output,value = key === 'accentOpacity' ? 100-transparencyOf(s.accentTransparency) : s[key]; output.textContent = `${value}${['opacity','accentOpacity'].includes(key) ? '%' : ' px'}`;});
    }
    syncRangeFill(input) {
      if (input.type !== 'range') return;
      const min = Number(input.min || 0), max = Number(input.max || 100), value = Number(input.value);
      const fill = max > min && Number.isFinite(value) ? clamp((value - min) / (max - min) * 100,0,100) : 0;
      input.style.setProperty('--range-fill',`${fill}%`);
    }
    syncSettingInputs() {
      const s = {...this.state.settings,...this.appearancePreview};
      this.$$('[data-setting]').forEach(input => {
        if (this.root.activeElement !== input) input.value = input.dataset.setting === 'accentOpacity' ? 100-transparencyOf(s.accentTransparency) : s[input.dataset.setting === 'accent-picker' ? 'accent' : input.dataset.setting];
        this.syncRangeFill(input);
      });
      this.syncSettingOutputs(s);
    }
    applyOpacity(value) {this.el.style.setProperty('--alpha',clamp(Number(value) || 92,40,100) / 100); this.$('[data-output="opacity"]').textContent = `${value}%`;}
    applyAppearance() {
      const s = {...this.state.settings,...this.appearancePreview};
      const lightInk = themeOf(s) === 'dark', base = lightInk ? 24 : 249;
      const luminance = color => color.map(channel => channel / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4).reduce((sum,c,index) => sum + c * [.2126,.7152,.0722][index],0);
      const contrast = (a,b) => (Math.max(a,b) + .05) / (Math.min(a,b) + .05);
      const ink = lightInk ? '#ffffff' : '#111111';
      this.el.dataset.theme = lightInk ? 'dark' : 'light'; this.applyOpacity(s.opacity);
      this.el.style.setProperty('--base',`${base},${base},${base}`);
      this.el.style.setProperty('--solid',`rgb(${base},${base},${base})`);
      this.el.style.setProperty('--ink',ink);
      const muted = lightInk ? 200 : 78;
      this.el.style.setProperty('--muted',`rgb(${muted},${muted},${muted})`);
      this.el.style.setProperty('--line',lightInk ? '#ffffff1a' : '#00000014');
      this.el.style.setProperty('--raised',lightInk ? '#ffffff0c' : '#00000008');
      this.el.style.setProperty('--control-track',lightInk ? '#363636' : '#dedede');
      this.el.style.setProperty('--control-edge',lightInk ? '#ffffff14' : '#00000014');
      this.el.style.setProperty('--control-thumb','#ffffff');
      this.el.style.setProperty('--thumb-edge','#00000014');
      this.el.style.setProperty('--error',lightInk ? 'rgb(255,212,203)' : 'rgb(122,32,26)');
      this.el.style.setProperty('--blur',`${clamp(Number(s.blur) || 0,0,40)}px`);
      this.el.style.setProperty('--radius',`${clamp(Number(s.radius) || 0,0,24)}px`);
      this.el.style.setProperty('--inner-radius',`${clamp(Number(s.radius) || 0,0,24) / 2}px`);
      this.el.style.setProperty('--small-radius',`${clamp(Number(s.radius) || 0,0,24) / 3}px`);
      const hex = /^#[\da-f]{6}$/i.test(s.accent) ? s.accent : defaults.accent;
      const rgb = [1,3,5].map(index => parseInt(hex.slice(index,index + 2),16));
      const accentTransparency = transparencyOf(s.accentTransparency), alpha = 1 - accentTransparency / 100;
      const fill = `rgba(${rgb.join(',')},${alpha})`;
      const painted = rgb.map(channel => channel * alpha + base * (1 - alpha));
      const onAccent = contrast(luminance(painted),0) >= contrast(luminance(painted),1) ? '#000000' : '#ffffff';
      this.el.style.setProperty('--accent',fill);
      this.el.style.setProperty('--accent-fill',fill);
      this.el.style.setProperty('--accent-ink',onAccent);
      this.el.style.setProperty('--on-accent',onAccent);
      // Light small accents keep one fixed mild shade (69% color, 31% black).
      // Manual transparency changes alpha only, never the fill's RGB channels.
      const accentText = lightInk ? fill : `rgba(${rgb.map(channel => Math.round(channel * .69)).join(',')},${alpha})`;
      this.el.style.setProperty('--accent-text',accentText);
      this.el.style.setProperty('--focus',ink);
      // Explicit host callback crosses our own Shadow DOM boundaries only.
      this.onAppearance?.({accent:hex,accentTransparency,theme:lightInk ? 'dark' : 'light',fill,onAccent,accentText});
    }
    viewport() {
      const v = window.visualViewport;
      return {x:v?.offsetLeft || 0,y:v?.offsetTop || 0,width:v?.width || window.innerWidth,height:v?.height || window.innerHeight};
    }
    position() {
      if (!this.el || this.positioning) return;
      this.positioning = true;
      try {
        const s = {...this.state.settings,...this.appearancePreview,...this.geometry}, v = this.viewport(), margin = 8;
        const collapsed = !!s.collapsed;
        const width = Math.min(collapsed ? 144 : clamp(Number(s.width) || defaults.width,320,760),Math.max(0,v.width - margin * 2));
        this.el.style.width = `${this.embedded ? Math.min(width,this.host?.parentElement?.clientWidth || width) : width}px`;
        const actualWidth = this.embedded ? this.el.getBoundingClientRect().width || width : width;
        this.el.dataset.layout = actualWidth <= 540 ? 'narrow' : 'wide';
        const maximum = Math.min(650,Math.max(96,v.height - margin * 2));
        const height = clamp(Number(s.height) || windowHeight.default,Math.min(windowHeight.min,maximum),maximum);
        this.$('.expanded').style.height = collapsed ? '88px' : `${height}px`;
        this.el.style.setProperty('--actual-height',`${height}px`);
        if (this.embedded) return;
        const rect = this.el.getBoundingClientRect(), offset = v.width < 581 ? 12 : 24;
        const x = clamp(s.x == null ? v.x + v.width - rect.width - offset : Number(s.x),v.x + margin,v.x + v.width - rect.width - margin);
        const y = clamp(s.y == null ? v.y + v.height - rect.height - offset : Number(s.y),v.y + margin,v.y + v.height - rect.height - margin);
        this.el.style.left = `${x}px`; this.el.style.top = `${y}px`; this.el.style.right = 'auto'; this.el.style.bottom = 'auto';
      } finally {this.positioning = false;}
    }
    bindDrag() {
      const handles = [[this.$('.top'),'drag'],[this.$('.resize-corner'),'resize']];
      handles.forEach(([handle,kind]) => {
        handle.addEventListener('pointerdown', event => this.beginPointer(event,kind,handle));
        handle.addEventListener('pointermove', event => this.movePointer(event));
        handle.addEventListener('pointerup', event => this.finishPointer(event));
        handle.addEventListener('pointercancel', event => this.finishPointer(event));
        handle.addEventListener('lostpointercapture', event => this.finishPointer(event));
        handle.addEventListener('keydown', event => {
          if (event.target !== handle || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)) return;
          event.preventDefault(); event.stopPropagation();
          const rect = this.el.getBoundingClientRect(), step = event.shiftKey ? 24 : 8;
          const dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0;
          const dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
          this.geometry = kind === 'drag' ? {x:rect.left + dx,y:rect.top + dy}
            : {x:rect.left,y:rect.top,width:clamp(rect.width + dx,320,760),height:clamp(this.$('.expanded').getBoundingClientRect().height + dy,windowHeight.min,windowHeight.max)};
          this.position(); this.persistGeometry(kind);
        });
      });
    }
    beginPointer(event,kind,handle) {
      if (this.embedded || event.button !== 0 || event.isPrimary === false || this.operation) return;
      if (handle.classList.contains('top') && event.target.closest('button,input,a,textarea')) return;
      const rect = this.el.getBoundingClientRect();
      this.operation = {kind,handle,pointerId:event.pointerId,startX:event.clientX,startY:event.clientY,x:rect.left,y:rect.top,width:rect.width,height:this.$('.expanded').getBoundingClientRect().height,moved:false};
      try {handle.setPointerCapture(event.pointerId);} catch (_) {this.operation = null; return;}
      event.preventDefault(); event.stopPropagation();
      this.el.classList.add(kind === 'drag' ? 'is-dragging' : 'is-resizing');
    }
    movePointer(event) {
      const op = this.operation;
      if (!op || op.pointerId !== event.pointerId) return;
      event.preventDefault();
      const dx = event.clientX - op.startX, dy = event.clientY - op.startY;
      if (Math.abs(dx) + Math.abs(dy) < 3 && !op.moved) return;
      op.moved = true;
      if (op.kind === 'drag') this.geometry = {x:op.x + dx,y:op.y + dy};
      else {
        const v = this.viewport();
        this.geometry = {x:op.x,y:op.y,width:clamp(op.width + dx,320,Math.min(760,v.x + v.width - op.x - 8)),height:clamp(op.height + dy,windowHeight.min,Math.min(windowHeight.max,v.y + v.height - op.y - 8))};
      }
      this.position();
    }
    finishPointer(event) {
      const op = this.operation;
      if (!op || (event && op.pointerId !== event.pointerId)) return;
      this.operation = null; this.el.classList.remove('is-dragging','is-resizing');
      try {if (op.handle.hasPointerCapture(op.pointerId)) op.handle.releasePointerCapture(op.pointerId);} catch (_) { /* Browser may release capture on cancellation. */ }
      if (op.moved) this.persistGeometry(op.kind);
    }
    persistGeometry(kind) {
      const rect = this.el.getBoundingClientRect();
      const patch = {x:Math.round(rect.left),y:Math.round(rect.top)};
      if (kind === 'resize') {patch.width = Math.round(clamp(this.geometry?.width || rect.width,320,760)); patch.height = Math.round(clamp(this.geometry?.height || this.$('.expanded').getBoundingClientRect().height,windowHeight.min,windowHeight.max));}
      this.geometry = null;
      this.saveSettings(patch).catch(error => {this.status(errorText(error.message),true); this.position();});
    }
    applySplit(value = this.splitPreview ?? this.state.settings.findSplit) {
      const split = clamp(Number(value) || 50,30,70);
      this.el.style.setProperty('--find-split',String(split / 100));
      this.$('.find-divider').setAttribute('aria-valuenow',String(Math.round(split)));
      this.$('.find-divider').setAttribute('aria-valuetext',`最近浏览 ${Math.round(split)}%，收藏 ${Math.round(100 - split)}%`);
    }
    bindDivider() {
      const handle = this.$('.find-divider');
      handle.addEventListener('pointerdown', event => {
        if (event.button !== 0 || event.isPrimary === false || this.operation || this.splitOperation) return;
        const rect = this.$('.body').getBoundingClientRect();
        this.splitOperation = {pointerId:event.pointerId,left:rect.left,width:rect.width};
        try {handle.setPointerCapture(event.pointerId);} catch (_) {this.splitOperation = null; return;}
        event.preventDefault(); event.stopPropagation();
      });
      handle.addEventListener('pointermove', event => {
        const op = this.splitOperation;
        if (!op || op.pointerId !== event.pointerId) return;
        this.splitPreview = clamp((event.clientX - op.left) / Math.max(1,op.width) * 100,30,70);
        this.applySplit(); event.preventDefault();
      });
      ['pointerup','pointercancel','lostpointercapture'].forEach(type => handle.addEventListener(type,event => this.finishDivider(event)));
      handle.addEventListener('keydown', event => {
        if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        const current = this.splitPreview ?? this.state.settings.findSplit ?? 50;
        this.splitPreview = event.key === 'Home' ? 30 : event.key === 'End' ? 70 : clamp(current + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 10 : 2),30,70);
        this.applySplit(); this.persistSplit();
      });
    }
    finishDivider(event) {
      const op = this.splitOperation;
      if (!op || event && op.pointerId !== event.pointerId) return;
      this.splitOperation = null;
      const handle = this.$('.find-divider');
      try {if (handle.hasPointerCapture(op.pointerId)) handle.releasePointerCapture(op.pointerId);} catch (_) {}
      if (this.splitPreview != null) this.persistSplit();
    }
    async persistSplit() {
      const findSplit = Math.round(clamp(Number(this.splitPreview) || 50,30,70));
      try {await this.saveSettings({findSplit});}
      catch (error) {this.status(errorText(error.message),true);}
      finally {this.splitPreview = null; this.applySplit();}
    }
    destroy() {
      clearTimeout(this.searchTimer); this.finishPointer(); this.finishDivider();
      window.removeEventListener('resize',this.resize); window.removeEventListener('blur',this.blur);
      window.visualViewport?.removeEventListener('resize',this.resize); window.visualViewport?.removeEventListener('scroll',this.resize);
      document.removeEventListener('pointerdown',this.outsidePointer,true);
      this.host.remove();
    }
  };
  globalThis.FramePanel.errorText = errorText;
  globalThis.FramePanel.version = version;
})();
