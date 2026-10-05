/*
 * relay.js —— 内嵌中转站（「接入地址」）的前端封装
 *
 * 服务端是随 APK 打包的 Go 二进制（jniLibs/arm64-v8a/libtrae2api.so），
 * 只监听 127.0.0.1:7864，由 RelayService 在 App 启动时拉起。
 *
 * 主界面是 file:///android_asset/ 页面，同源策略禁止直接 fetch
 * http://127.0.0.1:7864，所以所有请求都经原生层（NativeApi）代发。
 */
(function () {
  'use strict';

  const Native = window.TraeNative || null;
  const isNative = !!Native;

  /** 轮询原生返回的 taskId（与 bridge.js 同一套契约：空串=进行中） */
  async function poll(taskId, timeoutMs) {
    const limit = timeoutMs || 30000;
    const step = 120;
    for (let waited = 0; waited < limit; waited += step) {
      const r = Native.httpPoll(taskId);
      if (r) return JSON.parse(r);
      await new Promise((res) => setTimeout(res, step));
    }
    try { Native.httpAbort(taskId); } catch (e) { /* 忽略 */ }
    throw new Error('请求超时（' + (limit / 1000) + 's）');
  }

  /** 读取当前状态；非 APK 环境返回可渲染的降级对象 */
  function status() {
    if (!isNative || !Native.relayStatus) {
      return { available: false, running: false, reason: '当前环境不支持（需在 APK 内运行）' };
    }
    try {
      const o = JSON.parse(Native.relayStatus());
      o.available = true;
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

  function start()   { if (isNative && Native.relayStart)   Native.relayStart(); }
  function stop()    { if (isNative && Native.relayStop)    Native.relayStop(); }
  function restart() { if (isNative && Native.relayRestart) Native.relayRestart(); }
  function openConsole() { if (isNative && Native.relayOpenConsole) Native.relayOpenConsole(); }

  /** 复制文本（file:// 页面下 navigator.clipboard 常不可用，故走原生剪贴板） */
  function copy(text) {
    if (isNative && Native.copyToClipboard) { Native.copyToClipboard(text); return true; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text); return true;
    }
    return false;
  }

  /** 轮询等待服务就绪（启动是异步的） */
  async function waitReady(timeoutMs) {
    const limit = timeoutMs || 40000;
    for (let waited = 0; waited < limit; waited += 1000) {
      if (status().running) return status();
      await new Promise((r) => setTimeout(r, 1000));
    }
    return status();
  }

  /** 通用只读请求（走原生转发） */
  async function get(path) {
    if (!isNative || !Native.relayGet) throw new Error('原生桥不可用');
    const taskId = Native.relayGet(path);
    const r = await poll(taskId, 25000);
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + String(r.body || '').slice(0, 120));
    try { return JSON.parse(r.body); } catch (e) { return { raw: r.body }; }
  }

  /** 可用模型列表 */
  async function models() {
    const d = await get('/v1/models');
    const arr = (d && d.data) || [];
    return arr.map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean);
  }

  /** 中转站里已导入的账号 */
  async function accounts() {
    const d = await get('/admin/api/accounts');
    return (d && d.accounts) || [];
  }

  /**
   * 把签到面板的账号推送到中转站。
   *
   * 中转站缺 refreshToken 也能用（accessToken 直通），只是无法自动续期；
   * 因此这里顺带把 deviceId 一并送过去，保底少一次风控。
   *
   * @param {{session:string, token:string, deviceId:string, uid:string,
   *          nickname:string, enterpriseId:string}} acc
   */
  async function importAccount(acc) {
    if (!isNative || !Native.relayImportAccount) throw new Error('原生桥不可用');
    if (!acc || !acc.token) throw new Error('缺少 accessToken，无法导入');

    // 中转站 auth.Parse 的嵌套格式，见 internal/auth/auth.go 的 saveAtomicLocked
    const doc = {
      auth: {
        accessToken: acc.token,
        refreshToken: acc.refreshToken || '',
        expiresAt: acc.expiresAt || 0,
        domain: 'trae.cn',
        apiHost: 'https://api.trae.com.cn',
        machineId: acc.machineId || acc.deviceId || '',
        deviceId: acc.deviceId || '',
      },
      account: {
        uid: acc.uid || '',
        enterpriseId: acc.enterpriseId || '',
        nickname: acc.nickname || '',
      },
    };

    const body = JSON.stringify({
      json: JSON.stringify(doc),
      machine_id: acc.deviceId || '',
      device_id: acc.deviceId || '',
    });

    const taskId = Native.relayImportAccount(body);
    const r = await poll(taskId, 30000);
    if (!r.ok) {
      let msg = String(r.body || '').slice(0, 160);
      try {
        const j = JSON.parse(r.body);
        msg = (j.error && (j.error.message || j.error.code)) || msg;
      } catch (e) { /* 保留原文 */ }
      throw new Error('导入被拒：' + msg);
    }
    try { return JSON.parse(r.body); } catch (e) { return { ok: true }; }
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
    get: get,
    models: models,
    accounts: accounts,
    importAccount: importAccount,
  };
})();
