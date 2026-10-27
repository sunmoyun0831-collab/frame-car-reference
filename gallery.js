/* Select full-viewer links, never thumbnail source URLs. Shared with preview. */
(() => {
  const LIMIT=80, KEY='ahstudioSelection';
  function photoLink(value,base=location.href) {
    try {
      if(typeof value!=='string' || /[\\%\u0000-\u0020\u007f]/.test(value))return null;
      const u=new URL(value,base);
      if(!/^https?:$/.test(u.protocol)||u.username||u.password||u.port||!/(^|\.)autohome\.com\.cn$/.test(u.hostname))return null;
      const m=u.pathname.match(/^\/cars\/imgs-([1-9]\d{0,19})-(\d{1,20}|x)-(\d{1,20}|x)-(\d{1,20}|x)\/((?:1_)?[1-9]\d{0,19})\.html$/);
      if(!m)return null;
      u.protocol='https:';u.hash='';u.search='';
      return {url:u.href,seriesId:m[1],id:m[5],photoId:m[5],category:m[3]};
    }catch{return null;}
  }
  function galleryRoute(url=location.href) {
    if(globalThis.FrameDetector?.galleryRoute)return FrameDetector.galleryRoute(url);
    // Standalone preview loads only gallery.js; keep the same route contract.
    let path;try{path=new URL(url).pathname;}catch{return null;}
    const main=path.match(/^\/cars\/imglist-(\d+|x)-(\d+|x)-([1-9]\d{0,19})-(\d+|x)-(\d+|x)-(\d+|x)-(\d+|x)-(\d+|x)-(\d+|x)-([1-9]\d*)\.html$/);
    const legacy=path.match(/^\/pic\/series(?:-s\d+)?\/([1-9]\d{0,19})(?:-(\d+)(?:-\d+)*)?(?:-p[1-9]\d*)?\.html$/);
    if(!main&&!legacy)return null;
    const type=main?.[5] || legacy?.[2] || 'x';
    const categoryKey=({'1':'exterior','10':'interior','3':'seats','12':'details','4':'night','53':'official','55':'show'})[type] || (/^(?:x|0)$/.test(type)?'all':`unknown:${type}`);
    return {seriesId:main?.[3] || legacy[1],type,categoryKey};
  }
  function collect(scope,seriesId,base=location.href) {
    const entries=[];
    // Both genuine templates render viewer anchors, including before lazy images
    // have a src. Never require image dimensions/loading, or use JSON picpath as
    // the download source. Numeric and 1_ HQ IDs are observed in the main template.
    for(const anchor of scope.querySelectorAll('a[href]')) {
      if(anchor.closest('frame-design-assistant') || !anchor.querySelector('img,picture'))continue;
      const photo=photoLink(anchor.getAttribute('href'),base);
      if(photo?.seriesId===seriesId)entries.push({...photo,anchor});
    }
    return entries;
  }
  globalThis.FrameGallery=class {
    constructor({onChange=()=>{},onNotice=()=>{},persist=true,seriesId=null,scope=document,accent='#6ad2cb',accentTransparency=0,theme='light'}={}) {
      this.onChange=onChange;this.onNotice=onNotice;this.persist=persist;this.scope=scope;this.override=seriesId;
      this.seriesId=null;this.categoryKey=null;this.enabled=false;this.selected=new Map();this.entries=[];this.markerNodes=new Set();
      this.saved=null;this.ready=false;this.queue=Promise.resolve();
      this.style=document.createElement('style');
      this.setAccent(accent,accentTransparency,theme);
      (document.head||document.documentElement).append(this.style);
      document.addEventListener('ahstudio:select-photo',e=>{
        if(typeof e.detail==='string' && this.enabled)this.toggle(e.detail);
      });
      // Fallback when testing shared UI without MAIN-world navigation.
      this.click=e=>{
        if(!this.enabled||e.defaultPrevented||e.button!==0||e.ctrlKey||e.metaKey||e.shiftKey||e.altKey)return;
        const anchor=e.composedPath().find(x=>x?.hasAttribute?.('data-frame-selectable'));
        if(!anchor||!this.entries.some(x=>x.anchor===anchor))return;
        e.preventDefault();e.stopImmediatePropagation();this.toggle(anchor.dataset.frameSelectable);
      };
      window.addEventListener('click',this.click,true);
      const load=persist&&globalThis.chrome?.storage?.local ? chrome.storage.local.get(KEY).then(x=>x[KEY]).catch(()=>null) : Promise.resolve(null);
      this.initialized=load.then(saved=>{this.saved=saved;this.ready=true;this.scan();});
    }
    scan() {
      if(!this.ready)return;
      const route=galleryRoute();
      const id=this.override || route?.seriesId || null;
      this.categoryKey=route?.categoryKey || (this.override?'all':null);
      if(id!==this.seriesId) {
        this.cleanMarkers();this.seriesId=id;this.selected.clear();this.enabled=false;
        if(id && this.saved?.seriesId===id) {
          this.enabled=this.saved.enabled===true;
          for(const row of (Array.isArray(this.saved.items)?this.saved.items:[]).slice(0,LIMIT)) {
            const p=photoLink(row.url);if(p?.seriesId===id)this.selected.set(p.id,p);
          }
        }
      }
      const entries=id?collect(this.scope,id):[];
      const active=new Set(entries.map(x=>x.anchor));
      for(const node of this.markerNodes)if(!active.has(node)){this.cleanNode(node);this.markerNodes.delete(node);}
      this.entries=entries;
      for(const {anchor,url,id:photoId} of entries) {
        if(anchor.dataset.frameSelectable!==url)anchor.dataset.frameSelectable=url;
        if(!anchor.querySelector('frame-photo-check')) {
          const host=document.createElement('frame-photo-check'),shadow=host.attachShadow({mode:'open'});
          shadow.innerHTML=`<style>:host{all:initial}button{all:unset;display:grid;place-items:center;width:30px;height:30px;border:1px solid #ffffffaa;border-radius:9px;background:#1d2122cc;backdrop-filter:blur(16px);color:#fff;cursor:pointer;box-shadow:0 2px 9px #0004}button:focus-visible{outline:3px solid var(--frame-photo-accent);outline-offset:3px;box-shadow:0 0 0 3px var(--frame-photo-focus-edge),0 0 0 7px var(--frame-photo-focus-edge)}button[aria-checked=true]{background:var(--frame-photo-accent);color:var(--frame-photo-ink);border-color:var(--frame-photo-accent)}svg{width:17px;height:17px;opacity:0}button[aria-checked=true] svg{opacity:1}</style><button type="button" role="checkbox" aria-checked="false">${globalThis.FRAME_ICONS?.check||'✓'}</button>`;
          shadow.querySelector('button').setAttribute('aria-label',`选择照片 ${photoId}`);
          this.applyMarkerAccent(host);
          anchor.append(host);
        }
        this.markerNodes.add(anchor);
      }
      this.render();
    }
    setAccent(value,transparency=0,theme='light') {
      const accent=typeof value==='string' && /^#[\da-f]{6}$/i.test(value) ? value.toLowerCase() : '#6ad2cb';
      const accentTransparency=Number.isInteger(transparency) && transparency>=0 && transparency<=100 ? transparency : 0;
      theme=theme==='dark'?'dark':'light';
      if(accent===this.accent && accentTransparency===this.accentTransparency && theme===this.theme)return;
      this.accent=accent;this.accentTransparency=accentTransparency;this.theme=theme;
      const rgb=[1,3,5].map(i=>parseInt(accent.slice(i,i+2),16));
      const alpha=1-accentTransparency/100,base=theme==='dark'?24:249;
      this.fill=`rgba(${rgb.join(',')},${alpha})`;
      const lum=rgb.map(c=>(c*alpha+base*(1-alpha))/255).map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);
      this.onAccent=(lum+.05)/.05 >= 1.05/(lum+.05) ? '#000000' : '#ffffff';
      this.focusEdge=`rgba(${this.onAccent==='#000000'?'0,0,0':'255,255,255'},${alpha})`;
      // No document-wide color variables: only our marked photos are outlined,
      // and each checkbox's own host carries its Shadow DOM color tokens.
      this.style.textContent=`
        html[data-frame-selecting="true"] [data-frame-selectable]{position:relative!important;cursor:pointer!important}
        frame-photo-check{display:none;position:absolute;top:8px;left:8px;z-index:60;line-height:1}
        html[data-frame-selecting="true"] frame-photo-check{display:block}
        html[data-frame-selecting="true"] [data-frame-selectable][data-frame-selected="true"] img{outline:3px solid ${this.fill}!important;outline-offset:-3px!important;border-radius:4px}
      `;
      for(const anchor of this.markerNodes)this.applyMarkerAccent(anchor.querySelector('frame-photo-check'));
    }
    applyMarkerAccent(host) {
      if(!host)return;
      host.style.setProperty('--frame-photo-accent',this.fill);
      host.style.setProperty('--frame-photo-ink',this.onAccent);
      host.style.setProperty('--frame-photo-focus-edge',this.focusEdge);
    }
    cleanNode(node){delete node.dataset.frameSelectable;delete node.dataset.frameSelected;node.querySelectorAll('frame-photo-check').forEach(x=>x.remove());}
    cleanMarkers(){for(const node of this.markerNodes)this.cleanNode(node);this.markerNodes.clear();}
    render() {
      document.documentElement.setAttribute('data-frame-selecting',String(this.enabled&&!!this.seriesId));
      for(const row of this.entries) {
        const yes=this.selected.has(row.id),str=String(yes);
        if(row.anchor.dataset.frameSelected!==str)row.anchor.dataset.frameSelected=str;
        const button=row.anchor.querySelector('frame-photo-check')?.shadowRoot?.querySelector('button');
        button?.setAttribute('aria-checked',str);
      }
      this.onChange(this.snapshot());
    }
    snapshot(){const count=new Set(this.entries.map(x=>x.id)).size;return {available:!!this.seriesId,count,selected:this.selected.size,enabled:this.enabled,limit:LIMIT,seriesId:this.seriesId,categoryKey:this.categoryKey,notice:this.seriesId&&!count?'当前页尚无可选实拍照片，可滚动加载或切换分类；不会使用缩略图代替。':''};}
    setEnabled(value){this.enabled=!!value&&!!this.seriesId;this.render();this.save();if(this.enabled&&this.snapshot().notice)this.onNotice(this.snapshot().notice);}
    toggle(url) {
      const row=this.entries.find(x=>x.url===url);if(!row)return;
      if(this.selected.has(row.id))this.selected.delete(row.id);
      else if(this.selected.size>=LIMIT)return this.onNotice(`一次最多选择 ${LIMIT} 张，请先下载这一批。`);
      else this.selected.set(row.id,{id:row.id,photoId:row.id,url:row.url,seriesId:row.seriesId,category:row.category});
      this.render();this.save();
    }
    selectAll() {
      this.enabled=!!this.seriesId;
      for(const row of this.entries){if(this.selected.size>=LIMIT)break;this.selected.set(row.id,{id:row.id,photoId:row.id,url:row.url,seriesId:row.seriesId,category:row.category});}
      this.render();this.save();
      if(new Set(this.entries.map(x=>x.id)).size>LIMIT)this.onNotice(`已选择前 ${LIMIT} 张；下载后可继续选择其它图片。`);
      else if(this.snapshot().notice)this.onNotice(this.snapshot().notice);
    }
    clear(){this.selected.clear();this.render();this.save();}
    items(){return [...this.selected.values()].map(({url})=>({url}));}
    removeCompleted(batch) {
      if(batch?.seriesId!==this.seriesId)return;
      // A photo now has a base copy plus zero or more topic copies. Keep the
      // selection if ANY required copy failed/stopped/is pending, so retries do
      // not silently lose the original selection. Old batches still use url.
      const groups=new Map();
      for(const item of batch.items||[]) {
        const photo=photoLink(item.url);
        if(!photo || photo.seriesId!==this.seriesId)continue;
        if(!groups.has(photo.id))groups.set(photo.id,[]);
        groups.get(photo.id).push(item);
      }
      for(const [id,items] of groups) {
        const topics=Array.isArray(batch.topics)?batch.topics:[];
        const complete=items.every(item=>item.status==='complete' &&
          (item.photoId==null || String(item.photoId)===id));
        const allCopies=topics.length===0 || (items.some(item=>!item.topic) &&
          topics.every(topic=>items.some(item=>item.topic===topic)));
        if(complete&&allCopies)this.selected.delete(id);
      }
      this.render();this.save();
    }
    save(){
      if(!this.seriesId)return;
      this.saved={seriesId:this.seriesId,enabled:this.enabled,items:this.items()};
      if(this.persist&&globalThis.chrome?.storage?.local) {
        const payload=this.saved;this.queue=this.queue.catch(()=>{}).then(()=>chrome.storage.local.set({[KEY]:payload})).catch(()=>{});
      }
    }
  };
  globalThis.FrameGallery.photoLink=photoLink;
  globalThis.FrameGallery.galleryRoute=galleryRoute;
  globalThis.FrameGallery.collect=collect;
})();
