/*
 * MAIN world, document_start. No extension APIs and no user-tab cleanup.
 * The isolated UI dispatches a JSON-string CustomEvent "ahstudio:settings".
 * Conservative limits: blank-window-then-location, named/sized popups,
 * non-search forms, shadowed/replaced APIs and earlier page listeners are not
 * forcibly rewritten. Native modifier/middle-click behavior always wins.
 */
(function () {
  'use strict';
  const installed = Symbol.for('ahstudio.navigation.installed');
  if (window[installed]) return;
  Object.defineProperty(window, installed, { value: true });
  const originalOpen = window.open;
  const originalSubmit = window.HTMLFormElement && window.HTMLFormElement.prototype.submit;
  // Isolated extension code cannot observe the page's history wrappers.
  // Notify only after the native call succeeds; retain this/arguments/return.
  for (const method of ['pushState','replaceState']) {
    const original = window.history?.[method];
    if (typeof original !== 'function') continue;
    try {
      window.history[method] = function () {
        const result = Reflect.apply(original, this, arguments);
        document.dispatchEvent(new CustomEvent('ahstudio:route-change'));
        return result;
      };
    } catch (_) { /* Mutation/load and periodic scanning remain available. */ }
  }
  let sameTab = true;
  let recentGesture = null;
  const GESTURE_MS = 650;
  const PRIVILEGED_HOST = /^(?:login|passport|account|accounts|auth|oauth|sso|pay|payment|wallet|order|trade|cart|register|i|my|uc|user|usercenter|member)(?:[0-9_-]|$)/i;
  const PRIVILEGED_PATH = /(?:^|\/)(?:login|logout|signin|signout|signup|register|passport|accounts?|auth|oauth2?|sso|pay|payment|checkout|orders?|cart|wallet|trade|usercenter|users?|profile|members?|security)(?:[\/._-]|$)/i;

  function plainEvent(event) {
    if (!event || !event.isTrusted || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return false;
    if (/^key/.test(event.type)) return event.key === 'Enter';
    return /^(click|mousedown|mouseup|pointerdown|pointerup)$/.test(event.type) &&
      (event.button === undefined || event.button === 0);
  }

  function remember(event) {
    if (!event.isTrusted) return;
    recentGesture = { plain: plainEvent(event) && !viewerGesture(event), at: Date.now() };
  }

  function plainGesture() {
    // window.event is the CURRENT native event, not a stale remembered click.
    // In particular a Ctrl click must not inherit an earlier ordinary gesture.
    const current = window.event;
    if (current && /^(?:click|auxclick|mouse\w+|pointer\w+|key\w+)$/.test(current.type)) {
      return plainEvent(current) && !viewerGesture(current);
    }
    if (current && !current.isTrusted) return false;
    if (navigator.userActivation && !navigator.userActivation.isActive) return false;
    return !!recentGesture && recentGesture.plain && Date.now() - recentGesture.at <= GESTURE_MS;
  }

  function ordinaryURL(value) {
    if (!(typeof value === 'string' || value instanceof URL)) return null;
    const raw = String(value).trim();
    if (!raw || raw.startsWith('#') || /[\u0000-\u001f\u007f]/.test(raw)) return null;
    let url;
    try { url = new URL(raw, document.baseURI || location.href); } catch (_) { return null; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port ||
        !(url.hostname === 'autohome.com.cn' || url.hostname.endsWith('.autohome.com.cn'))) return null;
    if (url.hostname.split('.').some(label => PRIVILEGED_HOST.test(label))) return null;
    // Autohome appends #pvareaid tracking to ordinary cross-page links.
    // Only same-document fragments are viewer/scroll interactions to preserve.
    if (url.hash) {
      const current = new URL(location.href);
      if (url.origin === current.origin && url.pathname === current.pathname && url.search === current.search) return null;
    }
    let path;
    try { path = decodeURIComponent(url.pathname); } catch (_) { return null; }
    if (PRIVILEGED_PATH.test(path) || /\.(?:jpe?g|png|gif|webp|avif|svg|pdf|zip|mp4)(?:$|\/)/i.test(path)) return null;
    for (const [key, val] of url.searchParams) {
      if (/^(?:login|auth|oauth|access_token|payment|checkout|password|passwd)$/i.test(key)) return null;
      if (/^(?:url|redirect|redirect_uri|redirecturl|returnurl|return_url|callback)$/i.test(key) &&
          /(?:login|passport|oauth|account|auth|payment|checkout)/i.test(val)) return null;
    }
    return url;
  }

  function newTabTarget(value) {
    return !value || String(value).toLowerCase() === '_blank';
  }

  function assign(url) {
    try { location.assign(url.href); return true; } catch (_) { return false; }
  }

  window.open = function (url, target, features) {
    const destination = sameTab && plainGesture() && newTabTarget(target) && ordinaryURL(url);
    // Window dimensions, popup flags and named windows can be deliberate UI.
    const simpleFeatures = features == null || typeof features === 'string' &&
      features.split(',').every(part => /^(?:\s*|(?:noopener|noreferrer)(?:=(?:yes|1|true))?)$/i.test(part.trim()));
    if (destination && simpleFeatures && assign(destination)) {
      return typeof features === 'string' && /(?:noopener|noreferrer)/i.test(features) ? null : window;
    }
    return Reflect.apply(originalOpen, this, arguments);
  };

  function effectiveTarget(element, override) {
    if (override !== null && override !== undefined) return override;
    const own = element.getAttribute('target');
    if (own !== null) return own;
    const base = document.querySelector('base[target]');
    return base ? base.getAttribute('target') : '';
  }

  function isViewerAnchor(anchor) {
    if (anchor.hasAttribute('download') || anchor.getAttribute('role') === 'button' ||
        anchor.getAttribute('aria-disabled') === 'true' || anchor.hasAttribute('aria-haspopup')) return true;
    for (const attr of ['data-lightbox', 'data-fancybox', 'data-pswp', 'data-gallery']) {
      if (anchor.hasAttribute(attr)) return true;
    }
    if (/^(modal|collapse|tab)$/i.test(anchor.getAttribute('data-toggle') || anchor.getAttribute('data-bs-toggle') || '')) return true;
    return /(?:lightbox|fancybox|showModal|openDialog|imageViewer)/i.test(anchor.getAttribute('onclick') || '');
  }

  function eventAnchor(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    return path.find(node => node && node.tagName === 'A') ||
      (event.target && typeof event.target.closest === 'function' ? event.target.closest('a[href]') : null);
  }

  function eventSelectable(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    return path.find(node => node?.hasAttribute?.('data-frame-selectable')) ||
      event.target?.closest?.('[data-frame-selectable]');
  }

  function viewerGesture(event) {
    const anchor = eventAnchor(event);
    return !!anchor && (isViewerAnchor(anchor) ||
      /^\s*(?:#|javascript:|data:)/i.test(anchor.getAttribute('href') || ''));
  }

  function onClick(event) {
    // Gallery selection must win over same-tab navigation, even when sameTab is off.
    // DOM markers carry no privileges; the isolated controller validates the photo URL.
    const selectable = eventSelectable(event);
    if (plainEvent(event) && selectable?.hasAttribute('data-frame-selectable') &&
        document.documentElement?.getAttribute('data-frame-selecting') === 'true') {
      event.preventDefault();
      event.stopImmediatePropagation();
      document.dispatchEvent(new CustomEvent('ahstudio:select-photo', {
        detail: selectable.getAttribute('data-frame-selectable')
      }));
      return;
    }
    if (!sameTab || event.defaultPrevented || !plainEvent(event)) return;
    const anchor = eventAnchor(event);
    if (!anchor || isViewerAnchor(anchor) || effectiveTarget(anchor).toLowerCase() !== '_blank') return;
    const destination = ordinaryURL(anchor.getAttribute('href'));
    if (!destination) return;
    // Never mutate target: future Ctrl/Meta/Shift/middle clicks stay native.
    if (assign(destination)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  function searchDestination(form, submitter) {
    if (!form || form.tagName !== 'FORM') return null;
    const method = (submitter && submitter.getAttribute('formmethod') || form.getAttribute('method') || 'get').toLowerCase();
    if (method !== 'get') return null; // Never rewrite POST, dialogs or credentials.
    const targetOverride = submitter ? submitter.getAttribute('formtarget') : null;
    if (effectiveTarget(form, targetOverride).toLowerCase() !== '_blank') return null;
    const action = submitter && submitter.getAttribute('formaction') || form.getAttribute('action') || location.href;
    const url = ordinaryURL(action);
    if (!url) return null;
    const knownHost = /^(?:sou|so|search)\.autohome\.com\.cn$/i.test(url.hostname);
    if (!knownHost || !/^\/(?:$|search(?:\.aspx|\.html)?\/?$|zonghe\/?$)/i.test(url.pathname)) return null;
    if (form.querySelector('input[type="password"],input[type="file"]')) return null;
    let data;
    try { data = submitter ? new FormData(form, submitter) : new FormData(form); }
    catch (_) { return null; }
    const entries = Array.from(data.entries());
    if (entries.length > 40 || !entries.some(([name, value]) =>
      /^(?:q|keyword|keywords|wd|searchword|searchtext)$/i.test(name) && typeof value === 'string' && value.trim())) return null;
    if (entries.some(([name, value]) => typeof value !== 'string' ||
      /(?:password|passwd|token|csrf|auth|captcha)/i.test(name))) return null;
    // HTML GET submission replaces the action query with successful controls.
    url.search = new URLSearchParams(entries).toString();
    return url;
  }

  function onSubmit(event) {
    if (!sameTab || !event.isTrusted || event.defaultPrevented || !plainGesture()) return;
    const destination = searchDestination(event.target, event.submitter);
    if (destination && assign(destination)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }

  if (originalSubmit) {
    window.HTMLFormElement.prototype.submit = function () {
      const destination = sameTab && plainGesture() && searchDestination(this, null);
      if (destination && assign(destination)) return undefined;
      return Reflect.apply(originalSubmit, this, arguments);
    };
  }

  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'auxclick', 'keydown', 'keyup']) {
    window.addEventListener(type, remember, true);
  }
  window.addEventListener('click', onClick, true);
  window.addEventListener('submit', onSubmit, true);
  window.addEventListener('pagehide', () => { recentGesture = null; }, true);
  window.addEventListener('ahstudio:settings', event => {
    if (typeof event.detail !== 'string' || event.detail.length > 4096) return;
    try {
      const data = JSON.parse(event.detail);
      if (data && typeof data.sameTab === 'boolean') sameTab = data.sameTab;
    } catch (_) { /* An unrelated page event cannot break navigation. */ }
  }, true);
  function announceReady() {
    document.dispatchEvent(new CustomEvent('ahstudio:ready', { bubbles: true }));
  }
  announceReady();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', announceReady, { once: true });
  }
})();
