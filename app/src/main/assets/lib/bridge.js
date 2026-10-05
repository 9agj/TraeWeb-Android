/*
 * bridge.js —— 原生能力封装
 *
 * 浏览器/Node 环境没有 CORS 问题，但 Android WebView 直接 fetch 外部 API 会被同源策略拦。
 * 因此网络请求下沉到 Java 层（NativeApi），这里做 Promise 化的异步封装。
 */
(function () {
  'use strict';

  const Native = window.TraeNative || null;
  const isNative = !!Native;

  /** 带超时的原生 HTTP（两段式：httpStart 拿 taskId，httpPoll 轮询结果） */
  async function http(url, method, headers, body, timeoutMs) {
    if (!isNative) throw new Error('原生桥未注入（NativeBridge 仅在 APK 内可用）');
    const limit = timeoutMs || 60000;
    const id = Native.httpStart(url, method || 'GET', JSON.stringify(headers || {}), body || '');
    const step = 80;
    for (let waited = 0; waited < limit; waited += step) {
      const r = Native.httpPoll(id);
      if (r) {
        const o = JSON.parse(r);
        return {
          status: o.status,
          ok: !!o.ok,
          text: o.body || '',
          setCookie: o.setCookie || [],
          location: o.location || null,
          error: o.error || null,
        };
      }
      await new Promise((res) => setTimeout(res, step));
    }
    try { Native.httpAbort(id); } catch (e) { /* 忽略 */ }
    throw new Error('请求超时（' + (limit / 1000) + 's）');
  }

  /** 简易 JSON 解析 */
  function jparse(text) {
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  /** base64url → UTF-8 字符串（替代 Node 的 Buffer） */
  function b64urlDecode(s) {
    let p = String(s).replace(/-/g, '+').replace(/_/g, '/');
    while (p.length % 4) p += '=';
    const bin = atob(p);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    try {
      return new TextDecoder('utf-8').decode(bytes);
    } catch (e) {
      return bin;
    }
  }

  /** UTF-8 字符串 → Uint8Array */
  function utf8(str) {
    return new TextEncoder().encode(String(str));
  }

  /** Uint8Array → base64 */
  function toBase64(bytes) {
    let bin = '';
    const arr = new Uint8Array(bytes);
    for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
    return btoa(bin);
  }

  window.NativeBridge = { isNative, http, jparse, b64urlDecode, utf8, toBase64 };

  /* ---------------------------------------------------- 浏览器登录桥 */

  /**
   * 浏览器登录：起本地回调监听 → 拿授权链接 → 交给系统浏览器。
   *
   * 流程：
   *   1. startBrowserLogin() 在本机 loopback 起监听，返回带
   *      auth_callback_url=http://127.0.0.1:18081/authorize 的授权链接
   *   2. openExternal() 用系统浏览器打开，用户在里面用手机号登录
   *   3. Trae 授权完成 → 302 回本地端口 → 原生侧解析并存库
   *   4. waitForBrowserLogin() 轮询 loginResult() 取回凭证
   */
  const BrowserLogin = {
    available: !!(isNative && Native.startBrowserLogin),

    /** 开始登录，返回 {ok, url, callback} */
    start() {
      if (!this.available) return { ok: false, error: '当前环境不支持（需在 APK 内运行）' };
      try {
        return JSON.parse(Native.startBrowserLogin());
      } catch (e) {
        return { ok: false, error: '发起登录失败：' + e.message };
      }
    },

    /** 用系统浏览器打开链接 */
    open(url) {
      if (isNative && Native.openExternal) {
        Native.openExternal(url);
        return true;
      }
      return false;
    },

    /** 读取一次结果；未完成返回 null */
    poll() {
      if (!this.available) return null;
      try {
        const raw = Native.loginResult();
        if (!raw) return null;
        return JSON.parse(raw);
      } catch (e) {
        return null;
      }
    },

    /** 等待结果（轮询到超时） */
    async wait(timeoutMs, onTick) {
      const limit = timeoutMs || 180000;
      const step = 1200;
      for (let waited = 0; waited < limit; waited += step) {
        const r = this.poll();
        if (r) {
          this.clear();
          return r;
        }
        if (onTick) { try { onTick(waited); } catch (e) { /* 忽略 */ } }
        await new Promise((res) => setTimeout(res, step));
      }
      return null;
    },

    clear() {
      if (isNative && Native.clearLoginResult) {
        try { Native.clearLoginResult(); } catch (e) { /* 忽略 */ }
      }
    },

    stop() {
      if (isNative && Native.stopBrowserLogin) {
        try { Native.stopBrowserLogin(); } catch (e) { /* 忽略 */ }
      }
    },
  };

  window.NativeBridge.BrowserLogin = BrowserLogin;
  /**
   * 内置登录页（推荐路径）。
   *
   * 登录在本 App 的 WebView 里完成，所以 X-Cloudide-Session 落进本 App 的
   * cookie jar，getCookie() 直接读到明文。系统浏览器那条路拿不到 ——
   * 它的 cookie 库是 v10 AES-GCM 加密，密钥在 TEE，root 也解不开。
   */
  const WebLogin = {
    available: !!(isNative && Native.openLoginWebView),

    /** 打开登录页 */
    open() {
      if (!this.available) return false;
      try { Native.openLoginWebView(); return true; }
      catch (e) { return false; }
    },

    /** 读一次结果；未完成返回 null */
    poll() {
      if (!this.available) return null;
      try {
        const raw = Native.getWebLoginResult();
        if (!raw) return null;
        const o = JSON.parse(raw);
        return o && o.ok ? o : null;
      } catch (e) {
        return null;
      }
    },

    clear() {
      if (isNative && Native.clearWebLoginResult) {
        try { Native.clearWebLoginResult(); } catch (e) { /* 忽略 */ }
      }
    },

    /** 等待用户在登录页完成（轮询到超时） */
    async wait(timeoutMs, onTick) {
      const limit = timeoutMs || 300000;
      const step = 1500;
      for (let waited = 0; waited < limit; waited += step) {
        const r = this.poll();
        if (r) { this.clear(); return r; }
        if (onTick) { try { onTick(waited); } catch (e) { /* 忽略 */ } }
        await new Promise((res) => setTimeout(res, step));
      }
      return null;
    },
  };

  window.NativeBridge.WebLogin = WebLogin;
})();
