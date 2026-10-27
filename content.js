(() => {
  if(globalThis.__frameActive || !globalThis.FramePanel || !chrome?.runtime?.id)return;
  globalThis.__frameActive=true;
  let state, page={}, panel, gallery, batch=null, batchStarting=false, downloadStarting=false, lastBatchSignature='', lastVisitKey='', lastSearch='', lastSignature='', lastViewRoute=null, pending=false, requestId='', undoCar=null, timer, suggestSequence=0, historyPromise=null;
  const send = async message => {
    try {
      const result=await chrome.runtime.sendMessage(message);
      if(!result?.ok)throw new Error(FramePanel.errorText(result?.error || '扩展未响应'));
      if(result.state) {state=result.state;panel?.setState(state);syncSettings();}
      return result;
    } catch(error) {
      if(/context invalidated|receiving end|message port/i.test(error.message))throw new Error('扩展已更新，请刷新汽车之家页面后重试。');
      throw error;
    }
  };
  const syncSettings=()=>{
    document.dispatchEvent(new CustomEvent('ahstudio:settings',{detail:JSON.stringify({sameTab:state?.settings.sameTab!==false})}));
    const appearance={...state?.settings,...panel?.appearancePreview};
    gallery?.setAccent(appearance.accent,appearance.accentTransparency,appearance.theme);
  };
  document.addEventListener('ahstudio:ready',syncSettings);
  // The search page decodes `q` as GBK unless told otherwise; declare UTF-8 so
  // Chinese queries (e.g. 蔚来) reach the results box instead of becoming mojibake.
  const searchURL=q=>`https://sou.autohome.com.cn/zonghe?q=${encodeURIComponent(q)}&charset=utf8`;
  function go(url,modified=false) {
    const safe=FrameDetector.safeURL(url);if(!safe)throw new Error('未识别到可安全打开的汽车之家链接。');
    if(modified || state?.settings.sameTab===false)window.open(safe,'_blank','noopener');else location.assign(safe);
  }
  async function search(query,modified=false) {
    const q=String(query).trim().slice(0,80),url=searchURL(q);
    if(!q)return;
    await send({type:'SEARCH',query:q,url});go(url,modified);
  }
  async function suggest(query) {
    const sequence=++suggestSequence,q=String(query||'').trim().slice(0,80);
    if(!q){panel.setSearchSuggestions({query:q,items:[],loading:false});return;}
    panel.setSearchSuggestions({query:q,items:[],loading:true});
    try {
      const result=await send({type:'SEARCH_SUGGEST',query:q});
      if(sequence===suggestSequence)panel.setSearchSuggestions({query:q,items:result.items||[],loading:false});
    } catch(error) {
      if(sequence===suggestSequence)panel.setSearchSuggestions({query:q,items:[],loading:false,error:error.message});
    }
  }
  async function selectCar(event) {
    const candidate=globalThis.AHCore?.normalizeCar(event.car);
    if(!candidate)throw new Error('车型候选已失效，请重新搜索。');
    // The endpoint supplies the ID, never an executable or arbitrary destination.
    candidate.links=FrameDetector.links(candidate.id);candidate.url=candidate.links.all;
    ++suggestSequence;
    await send({type:'VISIT',car:candidate});
    const query=String(event.query||candidate.name).trim().slice(0,80);
    await send({type:'SEARCH',query,url:searchURL(query)});
    go(candidate.links.all,event.modified);
  }
  async function diagnostic() {
    const report={extension:'FRAME '+chrome.runtime.getManifest().version,url:location.href,car:page.car?.name || null,seriesId:page.car?.id || null,image:page.image || null,category:page.category,sameTab:state?.settings.sameTab,archive:{configured:state?.settings.archiveConfigured,smart:state?.settings.smartArchive,topics:panel?.getDestinations()},ads:globalThis.FrameAds?.stats(),gallery:gallery?.snapshot(),batch,at:new Date().toISOString()};
    try {await navigator.clipboard.writeText(JSON.stringify(report,null,2));panel.archiveFeedback('诊断信息已复制。');}
    catch {
      const area=document.createElement('textarea');area.value=JSON.stringify(report,null,2);
      area.setAttribute('aria-label','页面诊断信息，按 Ctrl+C 复制');area.style.cssText='width:100%;height:100px;background:transparent;color:inherit;border:1px solid #999;padding:8px';
      panel.status('自动复制不可用，请手动复制诊断信息。',true);
      const status=panel.root.querySelector('.status'),dismiss=status.querySelector('[data-action="status-dismiss"]');
      status.replaceChildren(area,...(dismiss?[dismiss]:[]));area.focus();area.select();
    }
  }
  async function download() {
    if(pending||downloadStarting||batchStarting||['running','stopping'].includes(batch?.status))return;
    page=FrameDetector.detect();panel.setPage(page);
    if(!page.image) {
      panel.status('尚未找到已加载的大图。请点开一张实拍图片，再点击下载；仍失败可复制诊断。',true);
      if(state.settings.collapsed)await send({type:'SETTINGS',patch:{collapsed:false}});
      return;
    }
    const snapshot=structuredClone(page),topics=panel.getDestinations().slice(),sourcePage=location.href;
    downloadStarting=true;
    try {
      pending=true;requestId=crypto.randomUUID();panel.setBusy(true);
      if(state.settings.collapsed)await send({type:'SETTINGS',patch:{collapsed:false}});
      panel.status('');
      const result=await send({type:'DOWNLOAD',requestId,candidates:snapshot.image.candidates,
        name:snapshot.car?.name || '汽车实拍',seriesId:snapshot.car?.id,category:snapshot.category,
        categoryVerified:snapshot.categoryVerified===true,
        photoId:snapshot.image.id,sourcePage,topics:state.settings.smartArchive?topics:[]});
      if(result.batch) {
        pending=false;panel.setBusy(false);panel.dismissedBatch=null;receiveBatch(result.batch);
      }
      return result;
    } catch(error) {pending=false;panel.setBusy(false);panel.status(`下载未开始：${error.message} 可在帮助与维护中复制诊断。`,true);}
    finally {downloadStarting=false;}
  }
  function receiveBatch(next) {
    const signature=JSON.stringify(next);
    if(signature===lastBatchSignature)return;
    lastBatchSignature=signature;batch=next||null;panel?.setBatch(batch);
    if(batch&&['complete','stopped'].includes(batch.status))gallery?.removeCompleted(batch);
    refreshHistory();
  }
  function refreshHistory() {
    if(historyPromise)return historyPromise;
    historyPromise=send({type:'DOWNLOAD_HISTORY'})
      .then(result=>panel?.setDownloadHistory(result.history||[]))
      .catch(error=>console.warn('[FRAME history]',error.message))
      .finally(()=>{historyPromise=null;});
    return historyPromise;
  }
  async function refreshBatch() {
    try {const result=await send({type:'BATCH_STATUS'});receiveBatch(result.batch);}catch{}
    await refreshHistory();
  }
  async function startBatch() {
    if(batchStarting||downloadStarting||pending||['running','stopping'].includes(batch?.status))return;
    const items=gallery?.items();if(!items?.length)throw new Error('请先开启多选，点击图库中想要下载的照片。');
    const seriesId=gallery.seriesId,car=page.car||state.cars.find(x=>x.id===seriesId);
    const name=car?.name,topics=panel.getDestinations().slice();
    batchStarting=true;
    try {
      panel.status('');
      panel.dismissedBatch=null;
      const result=await send({type:'BATCH_START',batchId:crypto.randomUUID(),seriesId,
        name,items,topics:state.settings.smartArchive?topics:[]});
      receiveBatch(result.batch);
    }finally{batchStarting=false;}
  }
  async function exportArchive() {
    const result=await send({type:'ARCHIVE_EXPORT'});
    if(!result.data)throw new Error('未取得可导出的资料库配置。');
    const blob=new Blob([JSON.stringify(result.data,null,2)],{type:'application/json;charset=utf-8'});
    const url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download='FRAME-资料库配置.json';a.style.display='none';
    (document.body||document.documentElement).append(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),60000);
    return result;
  }
  async function action(event) {
    try {
      const car=[...(state?.cars || []),...(state?.favorites || [])].find(x=>x.id===event.id);
      switch(event.type) {
        case 'settings':return await send({type:'SETTINGS',patch:event.patch});
        case 'suggest':await suggest(event.query);break;
        case 'select-car':await selectCar(event);break;
        case 'topic-add':return await send({type:'TOPIC_ADD',name:event.name});
        case 'topic-remove':return await send({type:'TOPIC_REMOVE',name:event.name});
        case 'archive-export':return await exportArchive();
        case 'archive-import':{
          const result=await send({type:'ARCHIVE_IMPORT',data:event.data});
          return result;
        }
        case 'show-download':
          await send({type:'SHOW_DOWNLOAD',downloadId:event.downloadId});
          break;
        case 'search':case 'repeat-search':await search(event.query,event.modified);break;
        case 'remove-search':await send({type:'REMOVE_SEARCH',query:event.query});break;
        case 'open':if(car)go(car.url || car.links.all,event.modified);break;
        case 'category':if(car?.links?.[event.category])go(car.links[event.category],event.modified);break;
        case 'favorite':await send({type:'FAVORITE',id:event.id});break;
        case 'unfavorite':await send({type:'REMOVE_FAVORITE',id:event.id});break;
        case 'remove':
          undoCar=car;await send({type:'REMOVE_RECENT',id:event.id});
          panel.status('已从最近浏览移除，收藏不受影响。',false,true);break;
        case 'undo':if(undoCar)await send({type:'RESTORE_RECENT',car:undoCar});undoCar=null;panel.status('已恢复。');break;
        case 'download':await download();break;
        case 'gallery-mode':gallery?.setEnabled(!gallery.enabled);break;
        case 'gallery-all':gallery?.selectAll();break;
        case 'gallery-clear':gallery?.clear();break;
        case 'batch-start':await startBatch();break;
        case 'batch-stop':if(batch)receiveBatch((await send({type:'BATCH_STOP',batchId:batch.id})).batch);break;
        case 'batch-retry':
          if(!batch || event.batchId!==batch.id)throw new Error('下载记录已更新，请从当前失败记录重试。');
          receiveBatch((await send({type:'BATCH_RETRY_FAILED',batchId:event.batchId})).batch);break;
        case 'batch-dismiss':panel.dismissedBatch=batch?.id;panel.setBatch(batch);break;
        case 'diagnostic':await diagnostic();break;
      }
    } catch(error) {
      panel.status(error.message,true);
      if(['settings','topic-add','topic-remove','archive-import','archive-export'].includes(event.type))throw error;
    }
  }
  async function scan() {
    if(!panel || document.hidden)return;
    const next=FrameDetector.detect();
    const signature=JSON.stringify([location.pathname,next.car?.id,next.car?.name,next.categoryKey,next.category,next.image?.url,next.image?.width,next.image?.height]);
    page=next;
    const route=location.origin+location.pathname;
    if(route!==lastViewRoute) {
      lastViewRoute=route;
      // Once per route entry, not per image load/metadata scan. Preserve a
      // user's current settings task and never unfold or submit a download.
      if(FrameDetector.pageKind(location.href)!=='other' && panel.view!=='settings') {
        panel.switchView('download',{persist:true,focus:false});
      }
    }
    gallery?.scan();
    if(signature!==lastSignature){lastSignature=signature;panel.setPage(page);}
    const key=location.origin+location.pathname;
    if(page.car && lastVisitKey!==key) {lastVisitKey=key;await send({type:'VISIT',car:page.car}).catch(()=>{});}
    if(location.hostname==='sou.autohome.com.cn') {
      const params=new URL(location.href).searchParams,q=params.get('q') || params.get('keyword');
      if(q&&q!==lastSearch) {lastSearch=q;await send({type:'SEARCH',query:q,url:location.href}).catch(()=>{});}
    }
  }
  function scheduleScan() {
    // Leading coalescing: page mutations must not postpone detection forever.
    if(timer)return;
    timer=setTimeout(()=>{timer=null;scan();},80);
  }
  chrome.runtime.onMessage.addListener(message=>{
    if(message.type==='BATCH_PROGRESS')receiveBatch(message.batch);
    if(message.type==='STATE_CHANGED') {state=message.state;panel?.setState(state);syncSettings();}
    if(message.type==='TOGGLE_PANEL')action({type:'settings',patch:{collapsed:!state?.settings.collapsed}}).catch(()=>{});
    if(message.type==='DOWNLOAD_STATUS' && message.requestId===requestId) {
      // Single-photo requests also have multiple queue copies. A single copy's
      // completion must never replace the full queue and hide the other paths.
      if(batch?.requestId===message.requestId) {
        pending=false;panel.setBusy(false);return false;
      }
      if(message.status==='complete') {
        pending=false;panel.setBusy(false);panel.setDownloadResult?.({downloadId:message.downloadId,filename:message.filename,status:'complete'});
      } else if(message.status==='interrupted' || message.status==='error' || message.status==='failed') {
        pending=false;panel.setBusy(false);panel.status(`下载未完成：${message.error || message.reason || '请检查 Chrome 下载记录'}。可复制诊断后排查。`,true);
      }
    }
  });
  send({type:'GET_STATE'}).then(result=>{
    state=result.state;panel=new FramePanel({onAction:action,onAppearance:colors=>gallery?.setAccent(colors.accent,colors.accentTransparency,colors.theme)});panel.setState(state);syncSettings();
    gallery=new FrameGallery({onChange:data=>panel.setGallery(data),onNotice:text=>panel.status(text),accent:state.settings.accent,accentTransparency:state.settings.accentTransparency,theme:state.settings.theme});
    scan();refreshBatch();
    const observer=new MutationObserver(records=>{
      if(records.every(r=>r.target===panel.host))return;
      scheduleScan();
    });
    observer.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['src','srcset','href','data-src','data-original','data-bigurl','class','style','hidden']});
    document.addEventListener('load',e=>{if(e.target instanceof HTMLImageElement)scan();},true);
    document.addEventListener('error',e=>{if(e.target instanceof HTMLImageElement)scan();},true);
    // MAIN-world history updates are only a rescan hint. No page-supplied image
    // data or URLs cross this bridge and no hint can submit a download.
    document.addEventListener('ahstudio:route-change',scan);
    window.addEventListener('popstate',scan);
    window.addEventListener('hashchange',scheduleScan);
    document.addEventListener('visibilitychange',()=>{if(!document.hidden){scan();refreshBatch();}});
    window.addEventListener('pageshow',scan);
    setInterval(scan,1800);
    setInterval(()=>{if(!document.hidden)refreshBatch();},2500);
  }).catch(error=>console.warn('[FRAME]',error.message));
})();
