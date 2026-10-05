/*
 * relay.js —— 内嵌中转站的前端封装
 *
 * 服务端是随 APK 打包的 Go 二进制（jniLibs/arm64-v8a/libtrae2api.so），
 * 只监听 127.0.0.1:7864，由 RelayService 在 App 启动时拉起。
 *
 * 这里只做「状态展示 + 启停 + 跳转控制台」；真正的账号管理、授权、
 * 额度查看都在控制台页面里（独立 Activity 打开，避开 file:// 的同源限制）。
 */
(function () {
  'use strict';

  const Native = window.TraeNative || null;
  const isNative = !!Native;

  /** 读取当前状态；非 APK 环境返回一个可渲染的降级对象 */
  function status() {
    if (!isNative || !Native.relayStatus) {
      return {
        available: false,
        running: false,
        reason: '当前环境不支持（需在 APK 内运行）',
      };
    }
    try {
      const raw = Native.relayStatus();
      const o = JSON.parse(raw);
      o.available = true;
      // 二进制缺失是构建问题，单独标出来便于定位
      if (o.binaryPresent === false) {
        o.reason = '内嵌二进制缺失，APK 构建流程有误';
      } else if (!o.running) {
        o.reason = o.error || '服务未运行';
      }
      return o;
    } catch (e) {
      return { available: true, running: false, reason: '状态读取失败：' + e.message };
    }
  }

  function start() {
    if (isNative && Native.relayStart) Native.relayStart();
  }
  function stop() {
    if (isNative && Native.relayStop) Native.relayStop();
  }
  function restart() {
    if (isNative && Native.relayRestart) Native.relayRestart();
  }
  function openConsole() {
    if (isNative && Native.relayOpenConsole) Native.relayOpenConsole();
  }

  /** 复制文本：优先走原生剪贴板（file:// 页面下 navigator.clipboard 常不可用） */
  function copy(text) {
    if (isNative && Native.copyToClipboard) {
      Native.copyToClipboard(text);
      return true;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
      return true;
    }
    return false;
  }

  /** 轮询等待服务就绪（启动是异步的） */
  async function waitReady(timeoutMs) {
    const limit = timeoutMs || 40000;
    for (let waited = 0; waited < limit; waited += 1000) {
      const s = status();
      if (s.running) return s;
      await new Promise((r) => setTimeout(r, 1000));
    }
    return status();
  }

  window.Relay = {
    isNative: isNative,
    status: status,
    start: start,
    stop: stop,
    restart: restart,
    openConsole: openConsole,
    copy: copy,
    waitReady: waitReady,
  };
})();
