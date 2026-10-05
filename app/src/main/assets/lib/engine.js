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

  /** 诊断日志：同时写日志区与设备文件（logcat 缓冲太小，出问题就被冲掉） */
  function diag(tag, msg) {
    try {
      log('[' + tag + '] ' + msg, tag);
      const N = window.TraeNative;
      if (N && N.diag) N.diag(tag, msg);
    } catch (e) { /* 忽略 */ }
  }

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

    // 路径一：session → JWT（原有方式，最可靠）
    if (acc.session) {
      const r = await T.getToken(acc.session);
      if (r.ok) {
        updateAccount(acc.id, {
          token: r.token,
          tokenUpdatedAt: new Date().toISOString(),
          accountUid: T.parseAccountUid(r.token) || acc.accountUid || null,
          tokenAlive: true,
          lastError: null,
        });
        return { ok: true };
      }
      updateAccount(acc.id, { tokenAlive: false, lastError: r.error });
      // 401 说明 session 真废了，不再尝试别的路径
      if (r.status === 401) {
        return { ok: false, reason: r.error, expired: true };
      }
    }

    // 路径二：refreshToken 兜底。
    // 浏览器登录拿到的凭证里，session 若解析失败仍有 refreshToken 可用 ——
    // 交给接入服务做 ExchangeToken（它会轮换 refreshToken）。
    if (acc.refreshToken) {
      const ex = await exchangeRefreshToken(acc.refreshToken, { uid: acc.accountUid || '' });
      if (ex.ok) {
        // 交换成功后，接入服务那边已持有新凭证；本地用 session 或旧 token 保守续期
        const r2 = acc.session ? await T.getToken(acc.session) : { ok: false };
        if (r2.ok) {
          updateAccount(acc.id, {
            token: r2.token,
            tokenUpdatedAt: new Date().toISOString(),
            accountUid: T.parseAccountUid(r2.token) || acc.accountUid || null,
            tokenAlive: true,
            lastError: null,
          });
          return { ok: true };
        }
        // 本地换不到也没关系：接入服务已能独立工作
        log('[凭证] 本地续期失败，但凭证已同步到接入服务，中转可用', 'relay');
        return { ok: false, reason: '本地令牌已过期，请在签到面板用「浏览器登录」刷新凭证' };
      }
      return { ok: false, reason: '凭证已过期且刷新失败：' + ex.error };
    }

    return { ok: false, reason: '缺少会话与刷新令牌，请重新登录' };
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

    // 顺带推送到内嵌中转站，省得两边各登一次。
    // 失败不阻断登录 —— 中转站可能没启动，用户可在「接入地址」面板手动重推。
    await pushToRelay(acc.id, { silent: false });

    return { ok: true, account: findAccount(acc.id), profileSynced: r.ok };
  }

  /**
   * 把账号推送到内嵌中转站。
   *
   * 中转站只认 accessToken（Cloud-IDE-JWT），正好是 ensureToken 换出来的那个；
   * 顺手把 deviceId 带过去，减少一端风控差异。
   */
  async function pushToRelay(accountId, opts) {
    const silent = opts && opts.silent;
    const R = window.Relay;
    if (!R || !R.isNative) {
      if (!silent) log('未在 APK 内运行，跳过中转站同步', 'relay');
      return { ok: false, error: '环境不支持' };
    }

    const acc = findAccount(accountId);
    if (!acc) return { ok: false, error: '账号不存在' };

    // 确保有可用 JWT（过期会自动用 session 换新）
    const t = await ensureToken(acc);
    if (!t.ok) {
      if (!silent) log('[中转站] 同步跳过：' + t.reason, 'relay');
      return { ok: false, error: t.reason };
    }

    const cur = findAccount(accountId);
    const exp = T.parseJwtExp(cur.token);

    try {
      const res = await R.importAccount({
        token: cur.token,
        deviceId: cur.deviceId || '',
        machineId: cur.deviceId || '',
        uid: cur.accountUid || '',
        nickname: cur.name || cur.screenName || '',
        enterpriseId: '',
        expiresAt: exp || 0,
      });
      const action = (res && res.action) || 'ok';
      if (!silent) log('[中转站] 同步成功（' + action + '）：'
        + (cur.name || cur.screenName || cur.accountUid || ''), 'relay');
      updateAccount(accountId, { relaySyncedAt: new Date().toISOString(), relayUid: (res && res.uid) || cur.accountUid });
      return { ok: true, action: action, uid: (res && res.uid) || cur.accountUid };
    } catch (e) {
      if (!silent) log('[中转站] 同步失败：' + e.message, 'relay');
      updateAccount(accountId, { relaySyncError: e.message });
      return { ok: false, error: e.message };
    }
  }

  /** 批量推送所有账号到中转站 */
  async function pushAllToRelay() {
    const list = listAccounts();
    if (list.length === 0) return { ok: false, error: '没有账号' };
    let okCount = 0;
    for (let i = 0; i < list.length; i++) {
      const r = await pushToRelay(list[i].id, { silent: true });
      if (r.ok) okCount++;
      log('[' + (list[i].name || list[i].screenName || '账号') + '] 中转站同步'
        + (r.ok ? '成功' : '失败：' + r.error), r.ok ? 'ok' : 'err');
    }
    return { ok: true, total: list.length, okCount: okCount };
  }

  
  /**
   * 内置 WebView 登录（首选方式）。
   *
   * 为什么这条路能拿到可用凭证：
   *   X-Cloudide-Session 只有落在**本 App 的 WebView** 里才能读到明文。
   *   系统浏览器的 cookie 库用 v10 AES-GCM 加密、密钥在 TEE，root 也解不开；
   *   而授权回调只给 userJwt / refreshToken（source=refresh_token 的受限凭证），
   *   打业务接口一律 401。
   *
   * 所以登录必须在 App 内完成。
   */
  async function addAccountByWebLogin(onTick) {
    const WL = window.NativeBridge && window.NativeBridge.WebLogin;
    if (!WL || !WL.available) {
      return { ok: false, error: '内置登录仅支持在 APK 内使用' };
    }

    diag('login', '=== 打开内置登录页 ===');
    WL.clear();
    if (!WL.open()) {
      return { ok: false, error: '无法打开登录页' };
    }

    diag('login', '等待用户在 WebView 内完成登录…');
    const r = await WL.wait(300000, onTick);
    if (!r) {
      return { ok: false, error: '等待超时（5 分钟）。请在登录页内完成手机号登录后点「我已登录完成」。' };
    }

    const session = r.session || '';
    let token = r.token || '';
    diag('login', '登录页返回: session=' + (session ? session.length + '字符' : '空')
      + ' token=' + (token ? token.length + '字符' : '空'));

    if (!session) {
      return { ok: false, error: '未拿到 X-Cloudide-Session' };
    }

    // 拿 session 换一个新鲜的 JWT（比 localStorage 里的更可靠）
    const t = await T.getToken(session);
    if (t.ok) {
      token = t.token;
      diag('login', '用 session 换到新 JWT（' + token.length + '字符）');
    } else {
      diag('login', 'session 换 JWT 失败：' + t.error + '（回退用 localStorage 的 token）');
    }

    if (!token) {
      return { ok: false, error: '既没有换到 JWT，也没有可用的本地 token' };
    }

    const uid = T.parseAccountUid(token) || null;
    const exp = T.parseJwtExp(token);
    const dev = T.randomDeviceId();

    // 判重：同 uid 视为同一账号，刷新凭证即可
    const dup = findDuplicateByUid(uid);
    if (dup) {
      updateAccount(dup.id, {
        session: session,
        token: token,
        tokenUpdatedAt: new Date().toISOString(),
        tokenAlive: true,
        accountUid: uid || dup.accountUid,
        lastError: null,
        loginMethod: 'webview',
      });
      diag('login', '已有账号，凭证已刷新: ' + dup.id);
      const rf = await refreshProfile(dup.id);
      await pushToRelay(dup.id, { silent: false });
      return { ok: true, account: findAccount(dup.id), refreshed: true, profileSynced: rf.ok };
    }

    const acc = {
      id: uuid(),
      name: null,
      session: session,
      refreshToken: null,
      token: token,
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
      loginMethod: 'webview',
    };
    addAccount(acc);
    diag('login', '账号已写入: ' + acc.id + ' uid=' + (uid || '?'));

    const rf = await refreshProfile(acc.id);
    diag('login', 'refreshProfile -> ok=' + rf.ok + ' err=' + (rf.error || '-'));

    await pushToRelay(acc.id, { silent: false });

    return { ok: true, account: findAccount(acc.id), profileSynced: rf.ok };
  }

/**
   * 浏览器登录：跳系统浏览器 → 手机号登录 → 回调自动完成。
   *
   * 拿到的可能是 userJwt（Cloud-IDE-JWT）或 refreshToken：
   *   - userJwt      → 直接当 token，并用它换一次 session（走 GetUserToken 的逆路径不可行，
   *                    所以优先要 refreshToken；只有 userJwt 时直接落地，靠后续 refresh 兜底）
   *   - refreshToken → 走中转站的 import 通道（它能做 ExchangeToken），
   *                    同时本地也用它换一次 JWT
   *
   * @param {(ms:number)=>void} onTick 轮询回调，用于更新界面提示
   */
  async function addAccountByBrowserLogin(onTick) {
    diag('login', '=== 开始浏览器登录 ===');
    const BL = window.NativeBridge && window.NativeBridge.BrowserLogin;
    if (!BL || !BL.available) {
      return { ok: false, error: '浏览器登录仅支持在 APK 内使用' };
    }

    const s = BL.start();
    diag('login', 'startBrowserLogin -> ok=' + s.ok + ' callback=' + (s.callback || '') + ' err=' + (s.error || ''));
    if (!s.ok) return { ok: false, error: s.error };

    log('已生成授权链接，正在打开浏览器…', 'login');
    BL.open(s.url);

    if (!BL.open) {
      // open 失败时把链接给出去，让用户手动打开
      return { ok: false, error: '无法自动打开浏览器', url: s.url };
    }

    log('请在浏览器里用手机号登录 Trae（含滑块验证），完成后会自动回到 App', 'login');
    const r = await BL.wait(180000, onTick);
    diag('login', 'wait 返回: ' + (r ? ('ok=' + r.ok + ' 参数=' + JSON.stringify(Object.keys(r.params || {}))) : 'null（超时）'));

    if (!r) {
      BL.stop();
      return { ok: false, error: '等待超时（3 分钟）。请确认在浏览器里完成了登录；也可以再试一次。' };
    }
    if (!r.ok) {
      BL.stop();
      return { ok: false, error: r.error || '浏览器登录未完成' };
    }

    const parsed = parseAuthCallback(r.params || {});
    diag('login', '解析: token=' + (parsed.token ? parsed.token.length + '字符' : '空')
      + ' session=' + (parsed.session ? '有(' + parsed.session.length + ')' : '空')
      + ' refresh=' + (parsed.refreshToken ? '有' : '空')
      + ' uid=' + (parsed.uid || '空') + ' note=' + (parsed.note || '-'));
    if (!parsed.token) {
      BL.stop();
      return { ok: false, error: '回调里没有可用的访问令牌' + (parsed.note ? '（' + parsed.note + '）' : '') };
    }

    log('已收到授权回调：'
      + (parsed.token ? 'Token ' + parsed.token.length + ' 字符' : '')
      + (parsed.session ? ' + session' : '')
      + (parsed.refreshToken ? ' + refreshToken' : '')
      + (parsed.uid ? ' + uid ' + parsed.uid : ''), 'login');

    let token = parsed.token;
    let finalRefresh = parsed.refreshToken;
    let session = parsed.session;
    let uid = parsed.uid;
    const nickname = parsed.nickname;

    // refreshToken → 换新 token。
    // 优先交给接入服务做（它内部走 ExchangeToken 并轮换 refreshToken）；
    // 失败时退回已拿到的 Token 直接用。
    diag('login', '准备交换 refreshToken: ' + (finalRefresh ? '有' : '无'));
    if (finalRefresh) {
      const ex = await exchangeRefreshToken(finalRefresh, {
        uid: uid,
      });
      if (ex.ok) {
        log('refreshToken 已交给接入服务换取（会同时完成账号导入）', 'login');
      } else {
        log('refreshToken 换取失败，回退使用 userJwt：' + ex.error, 'login');
      }
    }

    if (!token) {
      BL.stop();
      return { ok: false, error: '回调里没有可用的访问令牌（userJwt / refreshToken 均为空）' };
    }

    const exp = T.parseJwtExp(token);
    const dev = T.randomDeviceId();

    // 判重：先用 uid 对一下已有账号
    const accountUid = uid || T.parseAccountUid(token) || null;
    diag('login', '判重: accountUid=' + (accountUid || '空'));
    const dup = findDuplicateByUid(accountUid);
    diag('login', '判重结果: ' + (dup ? ('命中 ' + dup.id) : '无重复，将新建'));
    if (dup) {
      const patchDup = {
        token: token,
        refreshToken: finalRefresh || dup.refreshToken || null,
        tokenUpdatedAt: new Date().toISOString(),
        tokenAlive: true,
        lastError: null,
      };
      if (session) patchDup.session = session;
      if (uid) patchDup.accountUid = uid;
      updateAccount(dup.id, patchDup);
      log('账号已存在，凭证已刷新：' + (dup.name || dup.screenName || accountUid), 'login');
      const rf = await refreshProfile(dup.id);
      await pushToRelay(dup.id, { silent: false });
      BL.stop();
      return { ok: true, account: findAccount(dup.id), refreshed: true, profileSynced: rf.ok };
    }

    const acc = {
      id: uuid(),
      name: nickname || null,
      // session 从 JWT 的 data.source_id 反推得到（就是 X-Cloudide-Session 的值），
      // 有了它就能走原有的 session → JWT 续期路径，不必依赖 refreshToken
      session: session || null,
      refreshToken: finalRefresh || null,
      token: token,
      tokenUpdatedAt: new Date().toISOString(),
      deviceId: dev,
      accountUid: accountUid,
      screenName: nickname || null,
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
      loginMethod: 'browser',
    };
    addAccount(acc);
    diag('login', '账号已写入: id=' + acc.id + ' session=' + (acc.session ? '有' : '空') + ' token长度=' + acc.token.length);

    const rf = await refreshProfile(acc.id);
    diag('login', 'refreshProfile -> ok=' + rf.ok + ' err=' + (rf.error || '-'));
    log('已通过浏览器登录添加账号 ' + (nickname || accountUid || '')
      + (rf.ok ? '（资料已同步）' : '（资料同步失败：' + rf.error + '）'), 'login');

    await pushToRelay(acc.id, { silent: false });

    BL.stop();
    return { ok: true, account: findAccount(acc.id), profileSynced: rf.ok };
  }

  /**
   * 解析 Trae 授权回调参数。
   *
   * 实测回调有两种形态，必须都兼容：
   *
   * ① 打包成 JSON 字符串（设备实测走的就是这条）：
   *      userJwt = '{"ClientID":"...","Token":"eyJ...","UserJwt":"eyJ...",
   *                  "RefreshToken":"yZf0...","TokenExpireAt":1792...,...}'
   *    —— 真正的凭证在 JSON 内部，外层那个字符串本身不是 JWT。
   *    把整串当 token 用会直接失败（这正是上一版「缺少凭证」的原因）。
   *
   * ② 平铺的参数：userJwt / token / refreshToken / uid 各自独立。
   *
   * JWT payload 里的 data.source_id 就是 X-Cloudide-Session 值，
   * 所以从 Token 里还能反推出 session —— 有它就能走原有的 session 续期路径。
   */
  function parseAuthCallback(params) {
    const out = { token: '', refreshToken: '', session: '', uid: '', nickname: '', note: '' };

    // 候选原始值：优先 userJwt，其次各种 token 变体
    const raw = params.userJwt || params.UserJwt || params.token || params.Token
      || params.accessToken || params.access_token || '';

    let inner = null;
    let obj = null;

    // 判断是不是「JSON 打包」形态
    const looksJson = typeof raw === 'string' && raw.trim().startsWith('{');
    if (looksJson) {
      try { obj = JSON.parse(raw); } catch (e) { obj = null; }
    }
    // 回调参数本身也可能直接是对象（原生侧已解析过）
    if (!obj && params.data && typeof params.data === 'object') obj = params.data;

    if (obj) {
      out.token = obj.Token || obj.token || obj.UserJwt || obj.userJwt || obj.AccessToken || '';
      out.refreshToken = obj.RefreshToken || obj.refreshToken || '';
      out.uid = obj.UID || obj.uid || obj.UserID || obj.userId || '';
      inner = obj;
      if (!out.token) out.note = 'JSON 里没有 Token 字段';
    } else {
      out.token = raw;
      out.refreshToken = params.refreshToken || params.RefreshToken || params.refresh_token || '';
      out.uid = params.uid || params.UID || params.userId || params.user_id || '';
    }

    // 外层参数可能也带这些，缺了就用外层的补
    if (!out.refreshToken) {
      out.refreshToken = params.refreshToken || params.RefreshToken || params.refresh_token || '';
    }
    if (!out.uid) {
      out.uid = params.uid || params.UID || params.userId || params.user_id || '';
    }
    out.nickname = params.nickname || params.screenName || params.screen_name || '';
    if (inner) {
      out.nickname = out.nickname || inner.Nickname || inner.nickname || inner.ScreenName || '';
    }

    // 从 JWT payload 反推 session 与 uid
    if (out.token && out.token.indexOf('.') > 0) {
      const payload = T.jwtPayload(out.token);
      const d = payload && payload.data;
      if (d) {
        if (d.source_id && !out.session) out.session = d.source_id;
        if (d.id && !out.uid) out.uid = String(d.id);
      }
      if (!out.session && d && typeof d.session === 'string') out.session = d.session;
    }

    // 兜底：外层直接给了 session
    if (!out.session) {
      out.session = params.session || params['X-Cloudide-Session'] || params.source_id || '';
    }

    // 有效性检查：token 必须是三段点分的 JWT，否则不算拿到凭证
    if (out.token && out.token.split('.').length !== 3) {
      const t = String(out.token);
      out.note = 'Token 不是 JWT 格式（' + t.slice(0, 24) + '…）';
      out.token = '';
    }

    return out;
  }

  /**
   * 用 refreshToken 换新的 access/refresh 对。
   *
   * 不要自己拼 JSON 走 import —— auth.Parse 强制要求 accessToken 非空，
   * 而 refreshToken 换新 token 的正确通路是服务端的 importFromCallback：
   * 它内部会做 ExchangeToken 并轮换 refreshToken。
   *
   * 所以这里把回调参数还原成一条回调链接交给它处理。
   */
  async function exchangeRefreshToken(refreshToken, extraParams) {
    const R = window.Relay;
    if (!R || !R.isNative || !R.status().running) {
      return { ok: false, error: '接入服务未运行' };
    }
    // 拼成服务端 ParseCallback 能识别的链接形式
    const qs = Object.keys(extraParams || {})
      .filter((k) => extraParams[k] !== undefined && extraParams[k] !== null && extraParams[k] !== '')
      .map((k) => encodeURIComponent(k) + '=' + encodeURIComponent(extraParams[k]))
      .join('&');
    const callback = 'http://127.0.0.1:18081/authorize?refreshToken='
      + encodeURIComponent(refreshToken) + (qs ? '&' + qs : '');

    try {
      // 走原生转发（file:// 页面 fetch 不到 127.0.0.1）
      const r = await R.importCallback(callback);
      return { ok: true, result: r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
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
    parseAuthCallback: parseAuthCallback,
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
    addAccountByWebLogin: addAccountByWebLogin,
    addAccountByBrowserLogin: addAccountByBrowserLogin,
    refreshProfile: refreshProfile,
    ensureToken: ensureToken,
    checkinOne: checkinOne,
    checkinAll: checkinAll,
    getStatus: getStatus,
    pushToRelay: pushToRelay,
    pushAllToRelay: pushAllToRelay,
    getGithub: getGithub,
    setGithub: setGithub,
    getSettings: getSettings,
    setSettings: setSettings,
  };
})();
