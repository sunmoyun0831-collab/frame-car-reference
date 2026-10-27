/* Site adapter. Never rewrites CDN size tokens or evaluates page scripts. */
(() => {
  const safeURL = (value, base = location.href, image = false) => {
    try {
      const u = new URL(value,base);
      if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.port) return null;
      const host = u.hostname.toLowerCase();
      if (!/(^|\.)autohome\.com\.cn$/.test(host) && !(image && /(^|\.)autoimg\.cn$/.test(host))) return null;
      if (image && u.protocol==='http:') u.protocol='https:';
      return u.href;
    } catch {return null;}
  };
  const plain = s => String(s || '').replace(/\s+/g,' ').trim();
  function pageProps(doc) {
    const scripts = [...doc.querySelectorAll('script#__NEXT_DATA__,script[type="application/json"]')];
    for (const script of scripts.slice(0,30)) {
      if (script.textContent.length>3000000) continue;
      try {const data=JSON.parse(script.textContent);const p=data?.props?.pageProps || data?.pageProps;if(p)return p;} catch {}
    }
    return {};
  }
  function seriesFromPath(url) {
    const p=new URL(url).pathname;
    const gallery=galleryRoute(url);
    if(gallery)return gallery.seriesId;
    const patterns=[/\/cars\/imgs-(\d+)-/,/\/pic\/series(?:-s\d+)?\/(\d+)(?:-|\.html)/,/\/(?:diandongche\/)?series-(\d+)\.html/,/^\/(\d+)\/?$/];
    for (const re of patterns) {const m=p.match(re);if(m)return m[1];}
    return null;
  }
  function categoryInfo(type) {
    const raw=String(type ?? 'x');
    const labels={'1':'外观','10':'内饰','3':'座椅','12':'细节','4':'夜景','53':'官图','55':'车展'};
    const keys={'1':'exterior','10':'interior','3':'seats','12':'details','4':'night','53':'official','55':'show'};
    return {
      category:({'1':'外观','10':'内饰','3':'内饰','12':'细节'})[raw] || '未分类',
      categoryVerified:/^(?:1|10|3|12)$/.test(raw),
      subcategory:labels[raw] || '',
      categoryKey:keys[raw] || (/^(?:x|0)$/.test(raw)?'all':`unknown:${raw}`)
    };
  }
  function galleryRoute(url) {
    let path;try {path=new URL(url).pathname;}catch{return null;}
    const main=path.match(/^\/cars\/imglist-(\d+|x)-(\d+|x)-([1-9]\d{0,19})-(\d+|x)-(\d+|x)-(\d+|x)-(\d+|x)-(\d+|x)-(\d+|x)-([1-9]\d*)\.html$/);
    if(main)return {seriesId:main[3],type:main[5],categoryKey:categoryInfo(main[5]).categoryKey,kind:'mainimglist'};
    const legacy=path.match(/^\/pic\/series(?:-s\d+)?\/([1-9]\d{0,19})(?:-(\d+)(?:-\d+)*)?(?:-p[1-9]\d*)?\.html$/);
    return legacy?{seriesId:legacy[1],type:legacy[2] || 'x',categoryKey:categoryInfo(legacy[2]).categoryKey,kind:'pic-series'}:null;
  }
  function pageKind(url) {
    // Navigation intent, not download eligibility. A known viewer is useful
    // before its image loads, but it still cannot download until verified.
    if (!safeURL(url,url)) return 'other';
    const path = new URL(url).pathname;
    if (galleryRoute(url)) return 'gallery';
    if (/^\/cars\/imgs-[1-9]\d{0,19}-(?:\d+|x)-(?:\d+|x)-(?:\d+|x)\/(?:\d+|1_\d+)\.html$/.test(path) ||
        /^\/photo\/(?:series|spec)\/[^?#]+/.test(path)) return 'viewer';
    return 'other';
  }
  function links(id) {
    const base=`https://car.autohome.com.cn/pic/series/${id}`;
    return {all:`${base}.html`,exterior:`${base}-1.html`,interior:`${base}-10.html`,details:`${base}-12.html`};
  }
  function nameFromDocument(doc, id, props) {
    // Only the current series' breadcrumb is authoritative. Never search
    // arbitrary recommendation objects for a convenient seriesname.
    const structured=String(props?.breadInfo?.seriesid)===id &&
      (props?.params?.seriesId==null || String(props.params.seriesId)===id) &&
      (props?.seriesId==null || String(props.seriesId)===id) && props.breadInfo.seriesname;
    if (structured) return plain(structured).slice(0,80);
    const candidates=[...doc.querySelectorAll('a[href]')].filter(a=>{
      try {
        const p=new URL(a.href).pathname;
        return p===`/${id}/` || p===`/diandongche/series-${id}.html`;
      } catch {return false;}
    });
    for (const a of candidates) {
      const text=plain(a.textContent);
      if(text.length>=2 && text.length<=30 && !/报价|图片|论坛|参数|配置|全部|首页|二手车|优惠/.test(text))return text;
    }
    const title=doc.title || '';
    const bracket=title.match(/【([^】]+)】/);
    if (bracket) {
      const name=plain(bracket[1].replace(/(?:报价|图片|参数|配置|价格|汽车).*$/,'').replace(/[_|].*$/,''));
      if (name.length>=2&&name.length<=40)return name;
    }
    const first=plain(title.split(/[_|【]/)[0].replace(/(?:\s+20\d\d款|图片大全|图片|报价|参数).*$/,''));
    if(first.length>=2 && first.length<=40 && !/汽车之家|选车|汽车报价/.test(first))return first;
    return null;
  }
  function isVisible(img) {
    const rect=img.getBoundingClientRect(), style=getComputedStyle(img);
    return rect.width>=200 && rect.height>=140 && style.visibility!=='hidden' && style.display!=='none' && +style.opacity!==0;
  }
  function sameImage(a,b) {
    try {
      const identity=value=>{
        const path=new URL(value).pathname;
        // Compare observed asset identities only; never synthesize a download URL.
        const stamped=path.match(/autohomecar__[^/]+$/)?.[0];
        return (stamped || path.replace(/\/\d+x\d+_/,'/')).replace(/\.webp$/i,'');
      };
      return identity(a)===identity(b);
    } catch {return false;}
  }
  function currentImage(doc, url, props) {
    const path=new URL(url).pathname;
    const viewer=/\/cars\/imgs-\d+-/.test(path) || /\/photo\/(?:series|spec)\//.test(path);
    if(!viewer)return null; // Do not mistake a gallery thumbnail/ad for the viewed photograph.
    let img=doc.querySelector('#big-img-show');
    if(!img) {
      const known=[...doc.querySelectorAll('#img,img#bigimg,.pic-main img,.pic-show img')];
      img=known.filter(x=>isVisible(x)&&x.naturalWidth>=600).sort((a,b)=>(b.clientWidth*b.clientHeight)-(a.clientWidth*a.clientHeight))[0];
    }
    if(!img || !img.complete || img.naturalWidth<600 || !isVisible(img))return null;
    const shown=safeURL(img.currentSrc || img.src,url,true);
    if(!shown)return null;
    const photoId=path.match(/\/((?:1_)?[1-9]\d{0,19})\.html$/)?.[1];
    if(!photoId)return null; // /0.html is category navigation, not a photo identity.
    const info=props.imgInfo;
    const routeSeries=seriesFromPath(url);
    const propsSeries=props.seriesId ?? props.breadInfo?.seriesid;
    // HQ photos have id=47198 but mixid/idx=1_47198. Do not strip the prefix:
    // plain /47198.html is a different identity, not an alias.
    const identity=info?.mixid || (info?.ishqpic===1?'':info?.id);
    const currentIdentity=!!info && String(identity)===photoId &&
      (props.idx==null || String(props.idx)===photoId) &&
      (propsSeries==null || String(propsSeries)===routeSeries) &&
      !!safeURL(info.nowebppic,url,true) && sameImage(info.nowebppic,shown);
    // Next's hydration script stays on the initial photo after client navigation.
    // The live filmstrip pairs each real viewer link with its observed thumbnail.
    // Require the CURRENT route's thumbnail and the loaded main image to agree:
    // route-first, image-first and rapid multi-photo transitions then fail closed.
    // Thumbnails establish identity only; they are NEVER download candidates.
    const liveIdentity=!currentIdentity && [...doc.querySelectorAll('a[href]')].some(anchor=>{
      const target=safeURL(anchor.href,url);
      if(!target || pageKind(target)!=='viewer' || seriesFromPath(target)!==routeSeries ||
        new URL(target).pathname.match(/\/((?:1_)?[1-9]\d{0,19})\.html$/)?.[1]!==photoId)return false;
      return [...anchor.querySelectorAll('img')].some(thumb=>{
        for(const value of [thumb.currentSrc,thumb.src,thumb.getAttribute('data-src')]) {
          const source=value && safeURL(value,url,true);
          if(source && sameImage(source,shown))return true;
        }
        return false;
      });
    });
    if(info && !currentIdentity && !liveIdentity)return null;
    const candidates=[];
    const add=(value,label)=>{const resolved=value && safeURL(value,url,true);if(resolved&&!candidates.some(x=>x.url===resolved))candidates.push({url:resolved,label});};
    // An explicit current-page high-resolution anchor is stronger evidence than a guessed URL.
    const originalLink=[...doc.querySelectorAll('a[href]')].find(a=>/查看高清|查看原图|高清大图|原始图片/.test(a.textContent+' '+(a.title||'')) && sameImage(a.href,shown) && /(^|\.)autoimg\.cn$/.test((()=>{try{return new URL(a.href).hostname;}catch{return '';}})()));
    if((currentIdentity || liveIdentity) && originalLink && sameImage(originalLink.href,shown))add(originalLink.href,'页面高清地址');
    if(currentIdentity && sameImage(info.originalpic,shown))add(info.originalpic,'页面原图数据');
    for(const attr of ['data-original','data-bigurl','data-src']) {
      if((currentIdentity || liveIdentity) && img.getAttribute(attr) && !/480x360|240x180|120x90/.test(img.getAttribute(attr)) && sameImage(img.getAttribute(attr),shown))add(img.getAttribute(attr),'主图属性');
    }
    add(shown,'当前显示大图');
    return {url:shown,candidates,width:img.naturalWidth,height:img.naturalHeight,id:photoId || '',selector:img.id?'#'+img.id:'legacy viewer'};
  }
  function detect(doc=document,url=location.href) {
    if(!safeURL(url))return {car:null,image:null,category:'未分类',subcategory:'',categoryKey:null};
    const props=pageProps(doc), routeId=seriesFromPath(url);
    const id=routeId; // Do not auto-record recommended cars found elsewhere in page data.
    const name=id?nameFromDocument(doc,id,props):null;
    const car=id&&name ? {id,name,url:`https://car.autohome.com.cn/pic/series/${id}.html`,links:links(id)} : null;
    if(car && /\/diandongche\/series-\d+\.html/.test(new URL(url).pathname))car.url=url.split('#')[0];
    const image=currentImage(doc,url,props);
    const path=new URL(url).pathname;
    const type=path.match(/^\/cars\/imgs-\d+-(?:\d+|x)-(\d+|x)-/)?.[1] || galleryRoute(url)?.type;
    return {car,image,...categoryInfo(type)};
  }
  globalThis.FrameDetector={detect,safeURL,seriesFromPath,links,pageProps,sameImage,galleryRoute,categoryInfo,pageKind};
  if(typeof module!=='undefined')module.exports=globalThis.FrameDetector;
})();
