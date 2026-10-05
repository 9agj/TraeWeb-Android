/*
 * engine.js —— 业务编排层（浏览器版）
 *
 * 由 Node 版 engine.js + store.js 合并移植：
 *   - 存储从 data/config.json 改为 localStorage（WebView 原生支持）
 *   - 日志从 SSE 推送改为内存数组 + 回调
 *   - 其余判定口径（9074 重试、签到成功条件、错峰间隔）保持不变
 */
(function () {
  'use strict';

  const T = window.TraeApi;
  const KEY = 'traeweb_state_v1';
  const HISTORY_LIMIT = 2000;
  const LOG_LIMIT = 500;
  /** 云端 checkin.yml 显式枚举的账号上限 */
  const CLOUD_ACCOUNT_LIMIT = 4;

  const DEFAULT = {
    accounts: [],
    github: { token: '', login: '' },
    feishuWebhook: '',
    checkinIntervalSeconds: 5,
    history: [],
  };

  let cache = null;
  const logs = [];
  let logSink = null;

  /* ------------------------------------------------------------ 存储 */

  function load() {
    if (cache) return cache;
    try {
      const raw = localStorage.getItem(KEY);
      cache = raw ? JSON.parse(raw) : JSON.parse(JSON.stringify(DEFAULT));
    } catch (e) {
      cache = JSON.parse(JSON.stringify(DEFAULT));
    }
    if (!Array.isArray(cache.accounts)) cache.accounts = [];
    if (!Array.isArray(cache.history)) cache.history = [];
    if (!cache.github || typeof cache.github !== 'object') cache.github = { token: '', login: '' };
    if (typeof cache.checkinIntervalSeconds !== 'number') cache.checkinIntervalSeconds = 5;
    return cache;
  }

  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify(cache));
    } catch (e) {
      log('存储写入失败：' + e.message);
    }
  }

  const listAccounts = () => load().accounts;
  const findAccount = (id) => load().accounts.find((a) => a.id === id) || null;
  const findDuplicateByUid = (uid, exceptId) =>
    uid ? load().accounts.find((a) => a.accountUid === uid && a.id !== exceptId) || null : null;

  function addAccount(acc) {
    load().accounts.push(acc);
    save();
    return acc;
  }
  function removeAccount(id) {
    const c = load();
    const i = c.accounts.findIndex((a) => a.id === id);
    if (i < 0) return false;
    c.accounts.splice(i, 1);
    save();
    return true;
  }
  function updateAccount(id, patch) {
    const a = findAccount(id);
    if (!a) return null;
    Object.assign(a, patch);
    save();
    return a;
  }

  function addHistory(entry) {
    const c = load();
    c.history.push(entry);
    if (c.history.length > HISTORY_LIMIT) c.history.splice(0, c.history.length - HISTORY_LIMIT);
    save();
    return entry;
  }
  const historyFor = (accountId, limit) =>
    load().history.filter((h) => !accountId || h.accountId === accountId).slice(-(limit || 120));

  /** 连续签到天数（以北京时间日期为准往回数） */
  function streak(accountId, today) {
    const days = {};
    load().history.forEach((h) => {
      if (h.accountId === accountId && h.ok) days[h.date] = 1;
    });
    let count = 0;
    let t = new Date(today + 'T00:00:00Z').getTime();
    for (;;) {
      const k = new Date(t).toISOString().slice(0, 10);
      if (!days[k]) break;
      count++;
      t -= 86400000;
    }
    return count;
  }

  /* ------------------------------------------------------------ 日志 */

  function log(message, scope) {
    const entry = { at: new Date().toISOString(), scope: scope || 'app', message: message };
    logs.push(entry);
    if (logs.length > LOG_LIMIT) logs.shift();
    if (logSink) { try { logSink(entry); } catch (e) { /* 忽略 */ } }
  }
  const getLogs = () => logs.slice();

  /* ------------------------------------------------------------ 工具 */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const uuid = () =>
    (window.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2);

  /** JWT 是否仍可用（留 120 秒余量） */
  function tokenAlive(acc) {
    if (!acc.token) return false;
    const exp = T.parseJwtExp(acc.token);
    if (!exp) return false;
    return Date.now() / 1000 < exp - 120;
  }

  /** 保证账号持有可用 JWT，必要时静默换新 */
  async function ensureToken(acc) {
    if (tokenAlive(acc)) return { ok: true };
    if (!acc.session) return { ok: false, reason: '缺少会话，请重新登录' };
    const r = await T.getToken(acc.session);
    if (!r.ok) {
      updateAccount(acc.id, { tokenAlive: false, lastError: r.error });
      return { ok: false, reason: r.error, expired: r.status === 401 };
    }
    updateAccount(acc.id, {
      token: r.token,
      tokenUpdatedAt: new Date().toISOString(),
      accountUid: T.parseAccountUid(r.token) || acc.accountUid || null,
      tokenAlive: true,
      lastError: null,
    });
    return { ok: true };
  }

  /* ------------------------------------------------------------ 账号 */

  /** 拉资料 + 学生认证 + 剩余积分 */
  async function refreshProfile(id, opts) {
    const withCredits = !opts || opts.withCredits !== false;
    const acc = findAccount(id);
    if (!acc) return { ok: false, error: '账号不存在' };

    const t = await ensureToken(acc);
    if (!t.ok) return { ok: false, error: t.reason, expired: t.expired };

    const cur = findAccount(id);
    const patch = {};
    const prof = await T.getUserProfile(cur.token, cur.session);
    if (prof.ok) {
      patch.screenName = prof.profile.screenName;
      patch.mobileMasked = prof.profile.mobileMasked;
      patch.avatarUrl = prof.profile.avatarUrl;
      patch.accountUid = prof.profile.userId || cur.accountUid;
      patch.profileAt = new Date().toISOString();
    } else if (prof.status === 401) {
      updateAccount(id, { token: null, lastError: '会话已失效，请重新登录' });
      return { ok: false, error: '会话已失效，请重新登录', expired: true };
    }

    const stu = await T.getStudentStatus(cur.token, cur.session);
    patch.isStudent = stu === 1;

    if (withCredits) {
      const cr = await T.getRemainingCredits(cur.token, cur.deviceId);
      if (cr.credits >= 0) patch.remainingCredits = cr.credits;
    }

    updateAccount(id, patch);
    return { ok: true, account: findAccount(id) };
  }

  /** 用 Session 添加账号（换 JWT → 判重 → 拉资料） */
  async function addAccountBySession(input) {
    const sess = T.extractSession(input.session);
    if (!sess) return { ok: false, error: '无法识别出 X-Cloudide-Session，请检查后重试' };

    const t = await T.getToken(sess);
    if (!t.ok) return { ok: false, error: t.error, expired: t.status === 401 };

    const uid = T.parseAccountUid(t.token);
    const dup = findDuplicateByUid(uid);
    if (dup) {
      return { ok: false, error: '该账号已存在（' + (dup.name || dup.screenName || '未命名') + '）', duplicate: dup.id };
    }

    const dev = /^\d{16}$/.test(String(input.deviceId || '').trim())
      ? String(input.deviceId).trim()
      : T.randomDeviceId();

    const acc = {
      id: uuid(),
      name: input.name || null,
      session: sess,
      token: t.token,
      tokenUpdatedAt: new Date().toISOString(),
      deviceId: dev,
      accountUid: uid,
      screenName: null,
      mobileMasked: null,
      avatarUrl: null,
      isStudent: false,
      isMember: false,
      remainingCredits: -1,
      lastCheckinDate: null,
      lastCheckinAt: null,
      enabled: true,
      tokenAlive: true,
      createdAt: new Date().toISOString(),
      lastError: null,
    };
    addAccount(acc);

    const r = await refreshProfile(acc.id);
    log('已添加账号 ' + (acc.name || uid || '') + (r.ok ? '（资料已同步）' : '（资料同步失败：' + r.error + '）'), 'account');
    return { ok: true, account: findAccount(acc.id), profileSynced: r.ok };
  }

  /** 手机号 + 验证码登录并添加（绕开滑块：发码在浏览器做，登录接口不校验滑块） */
  async function addAccountBySms(input) {
    const phone = T.normalizeMobile(input.mobile);
    if (!/^1[3-9]\d{9}$/.test(phone)) return { ok: false, error: '手机号格式不正确（需 11 位中国大陆号码）' };
    if (!/^\d{4,8}$/.test(String(input.code || '').trim())) return { ok: false, error: '验证码格式不正确' };

    const r = await T.smsLogin(phone, String(input.code).trim());
    if (!r.ok) return { ok: false, error: r.error || '登录失败', errorCode: r.errorCode };

    const v = await T.verifySession(r.session);
    if (!v.ok) return { ok: false, error: '已通过登录接口，但会话校验失败：' + v.error };

    const res = await addAccountBySession({ session: r.session, deviceId: input.deviceId, name: input.name });
    if (res.ok) log('已通过短信登录添加账号 ' + phone.replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2'), 'account');
    return res;
  }

  /* ------------------------------------------------------------ 签到 */

  /**
   * 单账号签到（含 9074 风控换设备号重试，最多 5 次）。
   * 判定口径与 checkin.py 一致：ok = http===200 && (code===0 || checked_in)
   */
  async function checkinOne(id, opts) {
    const silent = opts && opts.silent;
    const acc = findAccount(id);
    if (!acc) return { ok: false, error: '账号不存在' };

    const t = await ensureToken(acc);
    if (!t.ok) {
      if (!silent) log('[' + (acc.name || '账号') + '] 凭证失效：' + t.reason, 'checkin');
      return { ok: false, error: t.reason, expired: t.expired };
    }

    const cur = findAccount(id);
    let deviceId = cur.deviceId || T.randomDeviceId();
    let res = await T.claimCheckin(cur.token, deviceId);
    let body = res.body || {};
    let code = typeof body.code === 'number' ? body.code : -1;
    let attempt = 1;

    while (code === 9074 && attempt < 5) {
      deviceId = T.randomDeviceId();
      attempt++;
      if (!silent) log('[' + (cur.name || '账号') + '] 命中风控 9074，换新设备号重试（第 ' + attempt + ' 次）', 'checkin');
      await sleep(800 + Math.random() * 700);
      res = await T.claimCheckin(cur.token, deviceId);
      body = res.body || {};
      code = typeof body.code === 'number' ? body.code : -1;
    }

    const checked = body.checked_in === true;
    const ok = res.http === 200 && (code === 0 || checked);
    const credits = Number(body.credits) || 0;
    const extra = Number(body.extra_credits) || 0;
    const today = T.beijingToday();

    const patch = { deviceId: deviceId, lastCheckinAt: new Date().toISOString() };
    if (ok) {
      patch.lastCheckinDate = today;
      patch.remainingCredits = -1;
      if (extra > 0) patch.isMember = true;
    }
    updateAccount(id, patch);

    addHistory({
      accountId: id,
      date: today,
      ok: ok,
      credits: credits,
      extraCredits: extra,
      code: code,
      message: body.message || (ok ? '' : 'HTTP ' + res.http),
      at: new Date().toISOString(),
    });

    if (ok) {
      if (!silent) log('[' + (cur.name || '账号') + '] 签到成功，本次获得：' + credits + ' 积分' + (extra ? '（额外 ' + extra + '）' : ''), 'checkin');
    } else if (!silent) {
      log('[' + (cur.name || '账号') + '] 签到失败：' + (body.message || 'HTTP ' + res.http), 'checkin');
    }

    if (ok) {
      const cr = await T.getRemainingCredits(cur.token, deviceId);
      if (cr.credits >= 0) updateAccount(id, { remainingCredits: cr.credits });
    }

    return { ok: ok, credits: credits, extraCredits: extra, code: code, message: body.message || '', http: res.http };
  }

  /** 全部启用账号签到：账号之间随机错开，降低请求密度 */
  async function checkinAll() {
    const enabled = listAccounts().filter((a) => a.enabled);
    if (enabled.length === 0) return { ok: false, error: '没有启用的账号' };

    const base = load().checkinIntervalSeconds || 5;
    const results = [];
    log('开始批量签到，共 ' + enabled.length + ' 个账号', 'checkin');
    for (let i = 0; i < enabled.length; i++) {
      if (i > 0) await sleep((base + Math.random() * 1.5) * 1000);
      const r = await checkinOne(enabled[i].id, { silent: true });
      const nm = enabled[i].name || enabled[i].screenName || '账号';
      log('[' + nm + '] ' + (r.ok ? '签到成功 +' + r.credits : '签到失败：' + (r.error || r.message)), 'checkin');
      results.push({ id: enabled[i].id, name: enabled[i].name, ok: r.ok, credits: r.credits, error: r.error, message: r.message });
    }
    const okCount = results.filter((r) => r.ok).length;
    log('批量签到完成：成功 ' + okCount + ' / ' + results.length, 'checkin');
    return { ok: true, total: results.length, okCount: okCount, results: results };
  }

  async function getStatus(id) {
    const acc = findAccount(id);
    if (!acc) return { ok: false, error: '账号不存在' };
    const t = await ensureToken(acc);
    if (!t.ok) return { ok: false, error: t.reason, expired: t.expired };
    const cur = findAccount(id);
    const r = await T.getCheckinStatus(cur.token, cur.deviceId);
    return { ok: true, http: r.http, body: r.body, today: T.beijingToday() };
  }

  /* ------------------------------------------------------------ 配置 */

  function getGithub() { return load().github; }
  function setGithub(patch) {
    const c = load();
    c.github = Object.assign({}, c.github, patch);
    save();
    return c.github;
  }
  function getSettings() {
    const c = load();
    return { feishuWebhook: c.feishuWebhook || '', checkinIntervalSeconds: c.checkinIntervalSeconds || 5 };
  }
  function setSettings(patch) {
    const c = load();
    if (patch.feishuWebhook !== undefined) c.feishuWebhook = String(patch.feishuWebhook || '');
    if (patch.checkinIntervalSeconds !== undefined) {
      c.checkinIntervalSeconds = Math.max(0, Math.min(60, Number(patch.checkinIntervalSeconds) || 0));
    }
    save();
    return getSettings();
  }

  window.Engine = {
    CLOUD_ACCOUNT_LIMIT: CLOUD_ACCOUNT_LIMIT,
    setLogSink: (fn) => { logSink = fn; },
    log: log,
    getLogs: getLogs,
    listAccounts: listAccounts,
    findAccount: findAccount,
    removeAccount: removeAccount,
    updateAccount: updateAccount,
    historyFor: historyFor,
    streak: streak,
    addAccountBySession: addAccountBySession,
    addAccountBySms: addAccountBySms,
    refreshProfile: refreshProfile,
    ensureToken: ensureToken,
    checkinOne: checkinOne,
    checkinAll: checkinAll,
    getStatus: getStatus,
    getGithub: getGithub,
    setGithub: setGithub,
    getSettings: getSettings,
    setSettings: setSettings,
  };
})();
