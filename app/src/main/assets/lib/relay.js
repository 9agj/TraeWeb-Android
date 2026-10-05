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
        o.state = 'nobinary';
      } else if (o.running) {
        o.state = 'running';
      } else if (o.tcpListening) {
        // 端口在听但 HTTP 不通 —— 进程假死，与「没启动」是两回事
        o.state = 'stuck';
        o.reason = o.error || '端口已监听但服务无响应（进程假死），点「重启服务」再试';
      } else {
        o.state = 'stopped';
        o.reason = o.error || '服务未运行';
      }
      return o;
    } catch (e) {
      return { available: true, running: false, state: 'error', reason: '状态读取失败：' + e.message };
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

  /**
   * 用回调链接导入账号。
   *
   * 这是服务端为「授权回调」设计的通路（importFromCallback）：
   * 它会解析链接里的 refreshToken 做 ExchangeToken + 轮换，
   * 再用 GetUserInfo 补全 uid/nickname。比手拼嵌套 JSON 可靠得多
   * —— auth.Parse 强制要求 accessToken 非空，而回调场景本来就常常只有 refreshToken。
   */
  async function importCallback(callbackUrl) {
    if (!isNative || !Native.relayImportAccount) throw new Error('原生桥不可用');
    if (!callbackUrl) throw new Error('回调链接为空');

    // 服务端接受「纯字符串 body」或 {"callback_url":...}，这里用后者更明确
    const taskId = Native.relayImportAccount(JSON.stringify({ callback_url: callbackUrl }));
    const r = await poll(taskId, 40000);
    if (!r.ok) {
      let msg = String(r.body || '').slice(0, 200);
      try {
        const j = JSON.parse(r.body);
        msg = (j.error && (j.error.message || j.error.code)) || (j.message || msg);
      } catch (e) { /* 保留原文 */ }
      throw new Error('导入被拒：' + msg);
    }
    try { return JSON.parse(r.body); } catch (e) { return { ok: true }; }
  }


  /** 随机生成新 Key（返回 {ok, apiKey}） */
  function generateKey() {
    if (!isNative || !Native.relayGenerateKey) return { ok: false, error: '原生桥不可用' };
    try { return JSON.parse(Native.relayGenerateKey()); }
    catch (e) { return { ok: false, error: e.message }; }
  }

  /** 设置自定义 Key（返回 {ok, apiKey} 或 {ok:false, error}） */
  function setKey(raw) {
    if (!isNative || !Native.relaySetKey) return { ok: false, error: '原生桥不可用' };
    try { return JSON.parse(Native.relaySetKey(String(raw || ''))); }
    catch (e) { return { ok: false, error: e.message }; }
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
    importCallback: importCallback,
    generateKey: generateKey,
    setKey: setKey,
  };
})();
