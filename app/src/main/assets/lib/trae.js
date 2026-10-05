/*
 * trae.js（浏览器版）—— 由 Node 版逐条移植，仅替换运行时：
 *   fetch → NativeBridge.http      （Android 侧绕开同源限制）
 *   Buffer → atob/TextDecoder      （WebView 无 Node API）
 *   无 module/require，挂到 window.TraeApi
 *
 * 认证模型不变：
 *   X-Cloudide-Session (Cookie, ~14 天) --GetUserToken--> Cloud-IDE-JWT (~8 小时)
 *   业务接口用 JWT；dashboard 类网页接口额外带 Cookie + Referer/Origin。
 */
(function () {
  'use strict';

  const NB = window.NativeBridge;
  const BASE = 'https://api.trae.cn';
  const ORIGIN = 'https://www.trae.cn';
  const TRAE_AID = '711126';
  const PASSPORT = 'https://www.trae.cn';

  /* ------------------------------------------------------------ 底层 */

  async function post(path, headers, body) {
    const r = await NB.http(BASE + path, 'POST', headers, body === undefined ? '' : body, 45000);
    return { status: r.status, text: r.text };
  }

  /** 业务接口请求头（签到/积分）：JWT + 区域 + 设备号 */
  function bizHeaders(token, deviceId) {
    return {
      Authorization: 'Cloud-IDE-JWT ' + token,
      'X-User-Region': 'cn',
      'x-device-id': deviceId,
      'Content-Type': 'application/json',
      'User-Agent': 'TraeCheckin/1.0',
    };
  }

  /** dashboard 网页接口请求头：JWT + Session Cookie + 页面来源 */
  function webHeaders(token, session) {
    const h = {
      Referer: ORIGIN + '/',
      Origin: ORIGIN,
      'Content-Type': 'application/json',
      'User-Agent': 'TraeTools/1.0',
    };
    if (token) h.Authorization = 'Cloud-IDE-JWT ' + token;
    if (session) h.Cookie = 'X-Cloudide-Session=' + session;
    return h;
  }

  /* ------------------------------------------------------- 凭证/设备号 */

  /** 16 位十进制设备号。用 GUID/UUID 会触发 9074 风控。 */
  function randomDeviceId() {
    let s = '';
    for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 10);
    return s[0] === '0' ? '1' + s.slice(1) : s;
  }

  /** 从 JWT payload 的 data.id 解析账号唯一标识（跨登录会话恒定）。 */
  function parseAccountUid(jwt) {
    const p = jwtPayload(jwt);
    const id = p && p.data && p.data.id;
    return id ? String(id) : null;
  }

  /** JWT 过期时间（秒），解析不出返回 null */
  function parseJwtExp(jwt) {
    const p = jwtPayload(jwt);
    return p && typeof p.exp === 'number' ? p.exp : null;
  }

  function jwtPayload(jwt) {
    if (!jwt || typeof jwt !== 'string') return null;
    const parts = jwt.split('.');
    if (parts.length < 2) return null;
    try {
      return JSON.parse(NB.b64urlDecode(parts[1]));
    } catch (e) {
      return null;
    }
  }

  /**
   * 从粘贴的任意内容里提取 Session 值。
   * 实测格式为 <base64>=.<hex>，字符集必须包含 '='。
   */
  function extractSession(raw) {
    if (!raw) return null;
    let s = String(raw).trim().replace(/^["']|["']$/g, '');
    const m = s.match(/X-Cloudide-Session\s*=\s*([^;\s"']+)/i);
    if (m) return m[1].trim();
    const j = NB.jparse(s);
    if (j && typeof j === 'object') {
      const v = j['X-Cloudide-Session'] || j.session || j['x-cloudide-session'];
      if (v) return String(v).trim();
    }
    s = s.replace(/\s+/g, '');
    if (/^[A-Za-z0-9._=-]{16,}$/.test(s)) return s;
    return null;
  }

  /* ------------------------------------------------------------- 核心 */

  /** 用 Session 换全新 JWT */
  async function getToken(session) {
    const headers = {
      Cookie: 'X-Cloudide-Session=' + session,
      Referer: ORIGIN + '/',
      Origin: ORIGIN,
      'User-Agent': 'TraeCheckin/1.0',
      Accept: 'application/json, text/plain, */*',
    };
    let r;
    try {
      r = await post('/cloudide/api/v3/common/GetUserToken', headers, '');
    } catch (e) {
      return { ok: false, status: 0, error: '网络错误：' + e.message };
    }
    const data = NB.jparse(r.text);
    const token = data && data.Result && data.Result.Token;
    if (r.status === 401) {
      return {
        ok: false,
        status: 401,
        error: '账号会话已失效(HTTP 401)：X-Cloudide-Session 可能已过期（约 14 天）。请重新登录 trae.cn 并更新。',
      };
    }
    if (r.status !== 200 || !token) {
      return { ok: false, status: r.status, error: 'GetUserToken 失败: HTTP ' + r.status + ' ' + String(r.text).slice(0, 160) };
    }
    return { ok: true, status: 200, token: token };
  }

  /** 今日签到状态 */
  async function getCheckinStatus(token, deviceId) {
    try {
      const r = await post('/trae/api/v2/ug/checkin_credits/status', bizHeaders(token, deviceId), '{}');
      const d = NB.jparse(r.text);
      return { http: r.status, body: d || { raw: r.text } };
    } catch (e) {
      return { http: 0, body: { raw: e.message }, error: e.message };
    }
  }

  /** 执行签到 */
  async function claimCheckin(token, deviceId) {
    try {
      const r = await post('/trae/api/v2/ug/checkin_credits/claim', bizHeaders(token, deviceId), '{}');
      const d = NB.jparse(r.text);
      return { http: r.status, body: d || { raw: r.text } };
    } catch (e) {
      return { http: 0, body: { raw: e.message }, error: e.message };
    }
  }

  /** 剩余积分（汇总所有资格包；空列表视为异常，返回 -1） */
  async function getRemainingCredits(token, deviceId) {
    try {
      const r = await post('/trae/api/v2/pay/user_current_entitlement_list', bizHeaders(token, deviceId), '{}');
      const doc = NB.jparse(r.text);
      if (!doc) return { credits: -1, error: '响应无法解析' };
      const packs = doc.user_entitlement_pack_list;
      if (!Array.isArray(packs)) return { credits: -1, error: '响应缺少 user_entitlement_pack_list' };
      if (packs.length === 0) return { credits: -1, error: '积分包列表为空，可能会话失效' };
      let remaining = 0;
      for (let i = 0; i < packs.length; i++) {
        const p = packs[i] || {};
        const cl = p.entitlement_base_info && p.entitlement_base_info.quota && p.entitlement_base_info.quota.credits_limit;
        const ua = p.usage && p.usage.credits_amount;
        const limit = typeof cl === 'number' ? cl : parseFloat(cl) || 0;
        const used = typeof ua === 'number' ? ua : parseFloat(ua) || 0;
        const rem = limit - used;
        remaining += rem < 0 ? 0 : rem;
      }
      return { credits: remaining, packs: packs.length };
    } catch (e) {
      return { credits: -1, error: e.message };
    }
  }

  /** 账号资料 */
  async function getUserProfile(token, session) {
    try {
      const r = await post('/cloudide/api/v3/trae/GetUserInfo', webHeaders(token, session), '{}');
      const doc = NB.jparse(r.text);
      const R = doc && doc.Result;
      if (!R || typeof R !== 'object') return { ok: false, status: r.status, error: 'GetUserInfo 缺少 Result' };
      return {
        ok: true,
        status: r.status,
        profile: {
          userId: R.UserID || null,
          screenName: R.ScreenName || null,
          mobileMasked: R.NonPlainTextMobile || null,
          avatarUrl: R.AvatarUrl || null,
          tenantId: R.TenantID || null,
        },
      };
    } catch (e) {
      return { ok: false, status: 0, error: e.message };
    }
  }

  /** 学生认证状态：1 = 已认证 */
  async function getStudentStatus(token, session) {
    try {
      const r = await post('/trae/api/v3/student_verification/status', webHeaders(token, session), '{}');
      const doc = NB.jparse(r.text);
      return doc && typeof doc.status === 'number' ? doc.status : 0;
    } catch (e) {
      return 0;
    }
  }

  /* ------------------------------------------------------------- 用量 */

  async function getUsageSessions(token, session, startSec, endSec, pageNum, pageSize) {
    const ps = pageSize || 20;
    const body = JSON.stringify({
      start_time: startSec,
      end_time: endSec,
      page_size: ps,
      page_num: pageNum,
      usage_type: [7],
    });
    try {
      const r = await post('/trae/api/v1/pay/query_user_usage_group_by_session', webHeaders(token, session), body);
      const doc = NB.jparse(r.text);
      if (!doc) return { total: 0, items: [], error: '响应为空或无法解析' };
      if (doc.total === undefined) return { total: 0, items: [], error: '响应缺少 total 字段（接口可能失效/风控）' };
      const arr = doc.user_usage_group_by_sessions;
      if (!Array.isArray(arr)) return { total: int(doc.total), items: [], error: '响应缺少 user_usage_group_by_sessions' };
      return { total: int(doc.total), items: arr.map(parseUsageSession) };
    } catch (e) {
      return { total: 0, items: [], error: e.message };
    }
  }

  async function fetchAllUsage(token, session, startSec, endSec, pageSize, maxPages) {
    const ps = pageSize || 20;
    const mp = maxPages || 20;
    const items = [];
    let page = 1;
    let total = 1;
    while (page <= mp && (items.length < total || total <= 0)) {
      const r = await getUsageSessions(token, session, startSec, endSec, page, ps);
      if (r.items.length > 0) {
        for (let i = 0; i < r.items.length; i++) items.push(r.items[i]);
        total = r.total;
      } else {
        break;
      }
      if (r.items.length < ps) break;
      page++;
    }
    return { items: items, pages: page };
  }

  function parseUsageSession(el) {
    const rec = {
      sessionId: str(el, 'session_id'),
      usageTime: num(el, 'usage_time'),
      modelName: str(el, 'model_name'),
      mode: str(el, 'mode'),
      useMaxMode: el && el.use_max_mode === true,
      credits: dec(el, 'credits_float', dec(el, 'amount_float', 0)),
      costMoney: dec(el, 'cost_money_float', 0),
      userInputPreview: str(el, 'user_input_preview'),
      inputToken: 0,
      outputToken: 0,
      cacheReadToken: 0,
      cacheWriteToken: 0,
    };
    const extra = el && el.extra_info;
    if (extra && typeof extra === 'object') {
      rec.inputToken = num(extra, 'input_token');
      rec.outputToken = num(extra, 'output_token');
      rec.cacheReadToken = num(extra, 'cache_read_token');
      rec.cacheWriteToken = num(extra, 'cache_write_token');
    }
    return rec;
  }

  /* ------------------------------------------------------------- 登录 */

  /** 申请短信验证码（受滑块风控保护，实测返回 1105） */
  async function sendSmsCode(mobile, type) {
    const t = type || 24;
    const url = PASSPORT + '/passport/web/send_code/?aid=' + TRAE_AID +
      '&mobile=' + encodeURIComponent(mobile) + '&type=' + t;
    try {
      const r = await NB.http(url, 'POST', {
        'Content-Type': 'application/json',
        'User-Agent': 'TraeCheckin/1.0',
        Referer: PASSPORT + '/',
        Origin: PASSPORT,
      }, '{}', 40000);
      const d = NB.jparse(r.text);
      const code = d && d.data ? d.data.error_code : (d ? d.error_code : undefined);
      if (code === 1105) {
        return { ok: false, needCaptcha: true, error: '需要完成滑块验证（风控）。请在浏览器里操作获取验证码。' };
      }
      if (code === 0) return { ok: true, raw: d };
      return { ok: false, error: (d && d.data && d.data.description) || ('error_code=' + code), raw: d };
    } catch (e) {
      return { ok: false, error: '网络错误：' + e.message };
    }
  }

  /**
   * 短信登录：手机号 + 验证码 → X-Cloudide-Session。
   * 关键：mobile/code/aid 必须放 URL query（放 body 会返回 1002「手机号为空」）。
   * 该接口不校验滑块，所以「浏览器取码 + 本接口登录」可以绕过滑块。
   */
  async function smsLogin(mobile, code) {
    const url = PASSPORT + '/passport/web/sms_login/?aid=' + TRAE_AID +
      '&mobile=' + encodeURIComponent(mobile) + '&code=' + encodeURIComponent(code);
    try {
      const r = await NB.http(url, 'POST', {
        'Content-Type': 'application/json',
        'User-Agent': 'TraeCheckin/1.0',
        Referer: PASSPORT + '/',
        Origin: PASSPORT,
      }, '{}', 40000);

      let session = null;
      const sc = r.setCookie || [];
      for (let i = 0; i < sc.length; i++) {
        const m = String(sc[i]).match(/X-Cloudide-Session=([^;]+)/i);
        if (m && m[1]) session = m[1];
      }
      const d = NB.jparse(r.text);
      if (session) return { ok: true, session: session, status: r.status, raw: d };

      // 会话可能设在重定向响应上
      if (r.location && (r.status === 301 || r.status === 302 || r.status === 303)) {
        const loc = r.location.indexOf('http') === 0 ? r.location : PASSPORT + r.location;
        const f = await NB.http(loc, 'GET', { 'User-Agent': 'TraeCheckin/1.0', Referer: PASSPORT + '/' }, '', 40000);
        const sc2 = f.setCookie || [];
        for (let i = 0; i < sc2.length; i++) {
          const m = String(sc2[i]).match(/X-Cloudide-Session=([^;]+)/i);
          if (m && m[1]) session = m[1];
        }
        if (session) return { ok: true, session: session, status: f.status };
      }

      const errCode = d && d.data ? d.data.error_code : (d ? d.error_code : undefined);
      const desc = (d && d.data && d.data.description) || '';
      let hint = desc;
      if (errCode === 1203) hint = '验证码错误或已过期，请重新获取';
      else if (errCode === 1002) hint = '手机号未填写（接口参数异常）';
      else if (errCode === 1003) hint = '手机号格式错误';
      else if (!desc) hint = '登录失败（HTTP ' + r.status + '）';
      return { ok: false, status: r.status, error: hint, errorCode: errCode };
    } catch (e) {
      return { ok: false, error: '网络错误：' + e.message };
    }
  }

  async function verifySession(session) {
    const r = await getToken(session);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, token: r.token, uid: parseAccountUid(r.token) };
  }

  function normalizeMobile(raw) {
    let s = String(raw || '').replace(/[\s-]/g, '');
    if (s.indexOf('+86') === 0) s = s.slice(3);
    if (s.indexOf('86') === 0 && s.length === 13) s = s.slice(2);
    return s;
  }

  /* ------------------------------------------------------------- 工具 */

  function num(el, key) {
    const v = el ? el[key] : undefined;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') return parseInt(v, 10) || 0;
    return 0;
  }
  function dec(el, key, def) {
    const v = el ? el[key] : undefined;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const d = parseFloat(v);
      return isNaN(d) ? (def || 0) : d;
    }
    return def || 0;
  }
  function str(el, key) {
    const v = el ? el[key] : undefined;
    return typeof v === 'string' ? v : '';
  }
  function int(v) {
    if (typeof v === 'number') return Math.round(v);
    if (typeof v === 'string') return parseInt(v, 10) || 0;
    return 0;
  }

  function beijingNow() {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    return d.toISOString().replace('T', ' ').slice(0, 19);
  }
  function beijingToday() {
    return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  }

  window.TraeApi = {
    BASE: BASE,
    TRAE_AID: TRAE_AID,
    getToken: getToken,
    getCheckinStatus: getCheckinStatus,
    claimCheckin: claimCheckin,
    getRemainingCredits: getRemainingCredits,
    getUserProfile: getUserProfile,
    getStudentStatus: getStudentStatus,
    getUsageSessions: getUsageSessions,
    fetchAllUsage: fetchAllUsage,
    parseAccountUid: parseAccountUid,
    parseJwtExp: parseJwtExp,
    jwtPayload: jwtPayload,
    extractSession: extractSession,
    randomDeviceId: randomDeviceId,
    sendSmsCode: sendSmsCode,
    smsLogin: smsLogin,
    verifySession: verifySession,
    normalizeMobile: normalizeMobile,
    beijingNow: beijingNow,
    beijingToday: beijingToday,
  };
})();
