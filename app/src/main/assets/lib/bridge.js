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
})();
