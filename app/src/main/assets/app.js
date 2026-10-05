'use strict';
/* TraeWeb 前端（内置引擎版）—— 数据来自本地 Engine，不再走 HTTP API */

const $ = (s) => document.querySelector(s);
const E = window.Engine;
const GH = window.GitHubApi;

let STATE = { accounts: [], github: {}, settings: {}, today: '' };
let BUSY = new Set();

/* ───────────────────────── 工具 ───────────────────────── */

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function fmtNum(n) {
  if (n == null || n < 0) return '—';
  return Math.round(n).toLocaleString('en-US');
}
function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const p = (x) => String(x).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

let toastTimer = null;
function toast(msg, type) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show ' + (type || '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => (el.hidden = true), 220);
  }, 2800);
}

function logLine(text, cls) {
  const box = $('#logs');
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 24;
  const now = new Date();
  const p = (x) => String(x).padStart(2, '0');
  const stamp = p(now.getHours()) + ':' + p(now.getMinutes()) + ':' + p(now.getSeconds());
  let c = cls;
  if (!c) {
    if (/成功|已就绪|写入成功|已启用/.test(text)) c = 'ok';
    else if (/失败|异常|错误|失效|超时/.test(text)) c = 'err';
    else if (/风控|重试|警告|上限/.test(text)) c = 'warn';
  }
  const line = document.createElement('span');
  line.className = 'l';
  line.innerHTML = '<span class="t">' + stamp + '</span> <span class="' + c + '">' + esc(text) + '</span>';
  box.appendChild(line);
  while (box.childElementCount > 400) box.removeChild(box.firstChild);
  if (atBottom) box.scrollTop = box.scrollHeight;
}

const busy = (id, on) => { if (on) BUSY.add(id); else BUSY.delete(id); };

/** 账号视图（对外不暴露 session/token） */
function publicAccount(a) {
  return {
    id: a.id,
    name: a.name,
    screenName: a.screenName,
    mobileMasked: a.mobileMasked,
    avatarUrl: a.avatarUrl,
    isStudent: !!a.isStudent,
    isMember: !!a.isMember,
    remainingCredits: typeof a.remainingCredits === 'number' ? a.remainingCredits : -1,
    lastCheckinDate: a.lastCheckinDate,
    lastCheckinAt: a.lastCheckinAt,
    enabled: !!a.enabled,
    hasSession: !!a.session,
    sessionTail: a.session ? a.session.slice(-6) : null,
    deviceId: a.deviceId || '',
    accountUid: a.accountUid || null,
    createdAt: a.createdAt,
    lastError: a.lastError || null,
  };
}

/* ───────────────────────── 状态 ───────────────────────── */

function loadState() {
  const accts = E.listAccounts().map(publicAccount);
  const g = E.getGithub();
  STATE = {
    accounts: accts,
    github: { hasToken: !!g.token, login: g.login || null },
    settings: E.getSettings(),
    today: window.TraeApi.beijingToday(),
    serverTime: window.TraeApi.beijingNow(),
    cloudAccountsLimit: E.CLOUD_ACCOUNT_LIMIT,
    todayChecked: accts.filter((a) => a.lastCheckinDate === window.TraeApi.beijingToday()).length,
    totalCredits: accts.reduce((s, a) => (a.remainingCredits >= 0 ? s + a.remainingCredits : s), 0),
  };
  render();
}

function render() {
  const accounts = STATE.accounts || [];
  $('#statAccounts').textContent = accounts.length;
  $('#statTodayNum').textContent = STATE.todayChecked;
  $('#statTodayOf').textContent = accounts.length ? ' / ' + accounts.length : '';
  $('#statCredits').textContent = fmtNum(STATE.totalCredits);
  $('#statServerTime').textContent = STATE.serverTime || '—';
  $('#cloudLimit').textContent = STATE.cloudAccountsLimit;
  renderAccounts();
  renderCloud();
  renderSettings();
}

/* ───────────────────────── 账号列表 ───────────────────────── */

function renderAccounts() {
  const box = $('#accounts');
  const accounts = STATE.accounts || [];
  if (accounts.length === 0) {
    box.innerHTML = '<div class="empty">还没有账号 · 点右上角「+ 手机号登录」或「粘贴凭证」开始</div>';
    return;
  }
  box.innerHTML = accounts.map(accountRow).join('');
  accounts.forEach((a) => {
    const root = box.querySelector('[data-id="' + a.id + '"]');
    if (!root) return;
    root.querySelector('[data-act="checkin"]').addEventListener('click', () => doCheckin(a.id));
    root.querySelector('[data-act="refresh"]').addEventListener('click', () => doRefresh(a.id));
    root.querySelector('[data-act="status"]').addEventListener('click', () => doStatus(a.id));
    root.querySelector('[data-act="usage"]').addEventListener('click', () => openUsage(a));
    root.querySelector('[data-act="del"]').addEventListener('click', () => doDelete(a));
    root.querySelector('[data-act="rename"]').addEventListener('click', () => doRename(a));
    root.querySelector('[data-act="toggle"]').addEventListener('change', (e) => doToggle(a.id, e.target.checked));
  });
}

function accountRow(a) {
  const isBusy = BUSY.has(a.id);
  const checkedToday = STATE.today && a.lastCheckinDate === STATE.today;
  const name = a.name || a.screenName || (a.accountUid ? '账号 ' + a.accountUid.slice(-4) : '未命名账号');
  const initial = esc((a.screenName || a.name || '?').trim().charAt(0).toUpperCase() || '?');
  const badges = [];
  if (a.isMember) badges.push('<span class="badge member">会员</span>');
  if (a.isStudent) badges.push('<span class="badge student">学生认证</span>');
  if (checkedToday) badges.push('<span class="badge done">今日已签</span>');
  else if (a.hasSession) badges.push('<span class="badge todo">今日未签</span>');
  if (!a.hasSession) badges.push('<span class="badge expired">缺少凭证</span>');
  const meta = [];
  if (a.mobileMasked) meta.push(esc(a.mobileMasked));
  if (a.accountUid) meta.push('UID ' + esc(a.accountUid));
  if (a.hasSession) meta.push('凭证 ····' + esc(a.sessionTail || ''));
  if (a.lastCheckinAt) meta.push('上次签到 ' + esc(fmtTime(a.lastCheckinAt)));
  const creditHtml = a.remainingCredits >= 0
    ? '<div class="v">' + fmtNum(a.remainingCredits) + '</div><div class="k">剩余积分</div>'
    : '<div class="v dim">—</div><div class="k">积分未知</div>';
  const errLine = a.lastError
    ? '<div class="acc-meta" style="color:var(--err);margin-top:4px">' + esc(a.lastError) + '</div>' : '';

  return '' +
  '<div class="account ' + (a.enabled ? '' : 'disabled') + ' ' + (a.lastError ? 'err' : '') + '" data-id="' + esc(a.id) + '">' +
    '<div class="avatar">' + (a.avatarUrl
      ? '<img src="' + esc(a.avatarUrl) + '" alt="" loading="lazy" referrerpolicy="no-referrer">'
      : initial) + '</div>' +
    '<div class="acc-main">' +
      '<div class="acc-name"><span class="nm">' + esc(name) + '</span>' + badges.join('') + '</div>' +
      '<div class="acc-meta">' + meta.join('<span class="sep">·</span>') + '</div>' + errLine +
    '</div>' +
    '<div class="acc-credits">' + creditHtml + '</div>' +
    '<div class="acc-actions">' +
      '<label class="switch" title="启用 / 停用"><input type="checkbox" data-act="toggle" ' + (a.enabled ? 'checked' : '') + '><span class="slider"></span></label>' +
      '<button class="btn small primary" data-act="checkin" ' + (isBusy ? 'disabled' : '') + '>' + (isBusy ? '…' : '签到') + '</button>' +
      '<button class="btn small ghost" data-act="status">状态</button>' +
      '<button class="btn small ghost" data-act="usage">用量</button>' +
      '<button class="btn small ghost" data-act="refresh" ' + (isBusy ? 'disabled' : '') + '>刷新</button>' +
      '<button class="btn small ghost" data-act="rename">改名</button>' +
      '<button class="btn small ghost danger" data-act="del">删除</button>' +
    '</div>' +
  '</div>';
}

/* ───────────────────────── 账号操作 ───────────────────────── */

async function doCheckin(id) {
  const a = STATE.accounts.find((x) => x.id === id);
  busy(id, true); renderAccounts();
  logLine('[' + (a && a.name || '账号') + '] 开始签到…', 'info');
  const r = await E.checkinOne(id);
  busy(id, false);
  if (r.ok) toast('签到成功 +' + r.credits + ' 积分', 'ok');
  else toast(r.error || r.message || '签到失败', 'err');
  loadState();
}

async function doRefresh(id) {
  const a = STATE.accounts.find((x) => x.id === id);
  busy(id, true); renderAccounts();
  const r = await E.refreshProfile(id);
  busy(id, false);
  if (r.ok) { toast('已刷新资料与积分', 'ok'); logLine('[' + (a && a.name || '账号') + '] 资料与积分已刷新', 'ok'); }
  else toast(r.error || '刷新失败', 'err');
  loadState();
}

async function doStatus(id) {
  const a = STATE.accounts.find((x) => x.id === id);
  const r = await E.getStatus(id);
  if (!r.ok) { toast(r.error || '查询失败', 'err'); return; }
  const b = r.body || {};
  const msg = '今日' + (b.checked_in ? '已签到' : '未签到') + ' · 基础 ' + (b.credits || 0) + ' 分' + (b.extra_credits ? ' + 连签 ' + b.extra_credits : '');
  toast(msg, 'ok');
  logLine('[' + (a && a.name || '账号') + '] 状态查询：' + msg + '（code=' + (b.code == null ? '—' : b.code) + '）', 'info');
}

async function doToggle(id, enabled) {
  E.updateAccount(id, { enabled: enabled });
  const a = STATE.accounts.find((x) => x.id === id);
  logLine('[' + (a && a.name || '账号') + '] ' + (enabled ? '已启用' : '已停用'), 'info');
  loadState();
}

async function doRename(a) {
  const v = prompt('给这个账号起个备注名（留空则清除）', a.name || '');
  if (v === null) return;
  E.updateAccount(a.id, { name: v.trim() || null });
  toast('已更新备注名', 'ok');
  loadState();
}

async function doDelete(a) {
  const name = a.name || a.screenName || a.mobileMasked || '该账号';
  if (!confirm('确定删除「' + name + '」？\n只会移除本机保存的凭证，不影响 Trae 账号本身。')) return;
  E.removeAccount(a.id);
  toast('已删除', 'ok');
  logLine('已删除账号 ' + name, 'warn');
  loadState();
}

async function doCheckinAll() {
  const btn = $('#btnCheckinAll');
  const n = STATE.accounts.filter((a) => a.enabled).length;
  if (n === 0) { toast('没有启用的账号', 'err'); return; }
  btn.disabled = true; btn.textContent = '签到中…';
  const r = await E.checkinAll();
  btn.disabled = false; btn.textContent = '一键签到全部';
  if (r.ok) toast('完成：成功 ' + r.okCount + ' / ' + r.total, r.okCount === r.total ? 'ok' : 'err');
  else toast(r.error || '批量签到失败', 'err');
  loadState();
}

async function doRefreshAll() {
  const btn = $('#btnRefreshAll');
  const accounts = STATE.accounts;
  if (accounts.length === 0) { toast('还没有账号', 'err'); return; }
  btn.disabled = true; btn.textContent = '刷新中…';
  logLine('开始刷新 ' + accounts.length + ' 个账号…', 'info');
  for (let i = 0; i < accounts.length; i++) {
    const r = await E.refreshProfile(accounts[i].id);
    logLine('[' + (accounts[i].name || accounts[i].screenName || '账号') + '] ' + (r.ok ? '已刷新' : '刷新失败：' + r.error), r.ok ? 'ok' : 'err');
  }
  btn.disabled = false; btn.textContent = '刷新';
  toast('刷新完成', 'ok');
  loadState();
}

/* ───────────────────────── 用量 ───────────────────────── */

async function openUsage(a) {
  const dlg = $('#dlgUsage');
  $('#usageTitle').textContent = '用量统计 · ' + (a.name || a.screenName || '账号');
  $('#usageBody').innerHTML = '加载中…';
  dlg.showModal();
  try {
    const acc = E.findAccount(a.id);
    const t = await E.ensureToken(acc);
    if (!t.ok) { $('#usageBody').innerHTML = '<div class="error">' + esc(t.reason || '凭证失效') + '</div>'; return; }
    const cur = E.findAccount(a.id);
    const end = new Date();
    const start = new Date(end.getTime() - 7 * 86400000);
    const r = await window.TraeApi.fetchAllUsage(
      cur.token, cur.session,
      Math.floor(start.getTime() / 1000), Math.floor(end.getTime() / 1000)
    );
    const agg = { credits: 0, inputToken: 0, outputToken: 0, cacheReadToken: 0 };
    r.items.forEach((it) => {
      agg.credits += it.credits || 0;
      agg.inputToken += it.inputToken || 0;
      agg.outputToken += it.outputToken || 0;
      agg.cacheReadToken += it.cacheReadToken || 0;
    });
    const head = '<div class="u-agg">' +
      '<div><div class="k">会话数</div><div class="v">' + r.items.length + '</div></div>' +
      '<div><div class="k">积分消耗</div><div class="v">' + fmtNum(agg.credits) + '</div></div>' +
      '<div><div class="k">输入 Token</div><div class="v">' + fmtNum(agg.inputToken) + '</div></div>' +
      '<div><div class="k">输出 Token</div><div class="v">' + fmtNum(agg.outputToken) + '</div></div>' +
      '<div><div class="k">缓存命中</div><div class="v">' + fmtNum(agg.cacheReadToken) + '</div></div>' +
      '</div>';
    const rows = r.items.slice(0, 100).map((it) => '<tr>' +
      '<td>' + esc(fmtTime(it.usageTime ? it.usageTime * 1000 : null)) + '</td>' +
      '<td class="model" title="' + esc(it.modelName) + '">' + esc(it.modelName || '—') + '</td>' +
      '<td>' + fmtNum(it.inputToken) + '</td><td>' + fmtNum(it.outputToken) + '</td>' +
      '<td>' + fmtNum(it.cacheReadToken) + '</td><td>' + fmtNum(it.credits) + '</td></tr>').join('');
    const table = r.items.length
      ? '<table><thead><tr><th>时间</th><th>模型</th><th>输入</th><th>输出</th><th>缓存读</th><th>积分</th></tr></thead><tbody>' + rows + '</tbody></table>'
      : '<div class="empty">近 7 天没有用量记录</div>';
    $('#usageBody').innerHTML = head + table;
  } catch (e) {
    $('#usageBody').innerHTML = '<div class="error">' + esc(e.message) + '</div>';
  }
}

/* ───────────────────────── 云端 ───────────────────────── */

function renderCloud() {
  const box = $('#cloudStatus');
  const g = STATE.github || {};
  const btnDeploy = $('#btnDeploy');
  const btnGh = $('#btnGitHub');
  if (!g.hasToken) {
    box.innerHTML = '尚未授权 GitHub';
    btnGh.textContent = '授权 GitHub';
    btnDeploy.disabled = true;
    return;
  }
  btnGh.textContent = '更换授权';
  btnDeploy.disabled = false;
  box.innerHTML = '<div class="row"><span class="ok">已授权：' + esc(g.login) + '</span>' +
    '<span style="opacity:.4">·</span><a href="#" id="linkActions">打开 Actions</a>' +
    '<span style="opacity:.4">·</span><a href="#" id="linkLogout">退出授权</a>' +
    '<span id="cloudDetail" style="color:var(--muted)"></span></div>';
  $('#linkActions').addEventListener('click', (e) => {
    e.preventDefault();
    window.open('https://github.com/' + encodeURIComponent(g.login) + '/TraeTools/actions', '_blank');
  });
  $('#linkLogout').addEventListener('click', (e) => {
    e.preventDefault();
    E.setGithub({ token: '', login: '' });
    toast('已退出 GitHub 授权', 'ok');
    loadState();
  });

  GH.deploymentStatus(E.getGithub().token, g.login).then((st) => {
    const el = $('#cloudDetail');
    if (!el || !st || st.authorized === false) return;
    if (st.isDeployed) { el.textContent = '· 已部署完成（' + st.deployedCount + ' 个账号），云端每天 08:00 自动签到'; el.className = 'ok'; }
    else if (st.repoExists) { el.textContent = '· 仓库已就绪，尚未部署'; el.className = 'warn'; }
    else { el.textContent = '· 尚无仓库，部署时自动创建'; }
  }).catch(() => {});
}

async function doDeploy() {
  const btn = $('#btnDeploy');
  if (!confirm('将把当前启用的账号凭证写入你的 GitHub 仓库 Secrets，并启用每日自动签到。继续？')) return;
  btn.disabled = true; btn.textContent = '部署中…';
  logLine('开始部署到 GitHub Actions…', 'info');
  const tk = E.getGithub().token;
  const r = await GH.deploy(tk, E.listAccounts(), E.getSettings().feishuWebhook, (line) => logLine(line));
  btn.disabled = false; btn.textContent = '一键部署到云端';
  toast(r.ok ? '部署完成' : (r.error || '部署失败'), r.ok ? 'ok' : 'err');
  if (!r.ok) logLine('部署失败：' + r.error, 'err');
  loadState();
}

/* ───────────────────────── 设置 ───────────────────────── */

function renderSettings() {
  const s = STATE.settings || {};
  const i = $('#setInterval'), f = $('#setFeishu');
  if (document.activeElement !== i) i.value = s.checkinIntervalSeconds;
  if (document.activeElement !== f) f.value = s.feishuWebhook || '';
}

function saveSettings() {
  E.setSettings({
    checkinIntervalSeconds: Number($('#setInterval').value),
    feishuWebhook: $('#setFeishu').value.trim(),
  });
  toast('设置已保存', 'ok');
  logLine('设置已保存', 'ok');
  loadState();
}

/* ───────────────────────── 对话框 ───────────────────────── */

function setupDialogs() {
  const dlgAdd = $('#dlgAdd');
  const dlgSms = $('#dlgSms');
  const dlgGh = $('#dlgGh');

  $('#btnAdd').addEventListener('click', () => {
    $('#addError').hidden = true;
    $('#inSession').value = ''; $('#inName').value = ''; $('#inDevice').value = '';
    dlgAdd.showModal();
  });
  $('#btnAddCancel').addEventListener('click', () => dlgAdd.close());

  $('#dlgAdd').querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#btnAddSubmit'), err = $('#addError');
    err.hidden = true; btn.disabled = true; btn.textContent = '验证中…';
    const r = await E.addAccountBySession({
      session: $('#inSession').value,
      name: $('#inName').value.trim() || null,
      deviceId: $('#inDevice').value.trim() || null,
    });
    btn.disabled = false; btn.textContent = '验证并添加';
    if (r.ok) {
      dlgAdd.close();
      toast('账号已添加', 'ok');
      loadState();
    } else { err.textContent = r.error || '添加失败'; err.hidden = false; }
  });

  $('#btnAddSms').addEventListener('click', () => {
    $('#smsError').hidden = true;
    $('#inSmsMobile').value = ''; $('#inSmsCode').value = ''; $('#inSmsName').value = '';
    dlgSms.showModal();
  });
  $('#btnSmsCancel').addEventListener('click', () => dlgSms.close());

  $('#dlgSms').querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#btnSmsSubmit'), err = $('#smsError');
    err.hidden = true;
    const mobile = $('#inSmsMobile').value.trim();
    const code = $('#inSmsCode').value.trim();
    if (!/^1[3-9]\d{9}$/.test(mobile)) { err.textContent = '请输入正确的 11 位手机号'; err.hidden = false; return; }
    if (!/^\d{4,8}$/.test(code)) { err.textContent = '请输入收到的短信验证码'; err.hidden = false; return; }
    btn.disabled = true; btn.textContent = '登录中…';
    const r = await E.addAccountBySms({ mobile: mobile, code: code, name: $('#inSmsName').value.trim() || null });
    btn.disabled = false; btn.textContent = '登录并添加';
    if (r.ok) {
      dlgSms.close();
      toast('登录成功，账号已添加', 'ok');
      logLine('短信登录成功：' + ((r.account && (r.account.screenName || r.account.name)) || '账号'), 'ok');
      loadState();
    } else { err.textContent = r.error || '登录失败'; err.hidden = false; }
  });

  $('#btnGitHub').addEventListener('click', () => { $('#ghError').hidden = true; dlgGh.showModal(); });
  $('#btnGhCancel').addEventListener('click', () => dlgGh.close());

  $('#dlgGh').querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#btnGhSubmit'), err = $('#ghError');
    err.hidden = true;
    const tk = $('#inGhToken').value.trim();
    if (tk.length < 20) { err.textContent = 'Token 长度不足'; err.hidden = false; return; }
    btn.disabled = true; btn.textContent = '验证中…';
    const v = await GH.validateToken(tk);
    btn.disabled = false; btn.textContent = '验证并保存';
    if (v.valid) {
      E.setGithub({ token: tk, login: v.login });
      dlgGh.close(); $('#inGhToken').value = '';
      toast('已授权：' + v.login, 'ok');
      logLine('GitHub 已授权：' + v.login, 'ok');
      loadState();
    } else { err.textContent = v.error || '授权失败'; err.hidden = false; }
  });

  $('#btnUsageClose').addEventListener('click', () => $('#dlgUsage').close());
  $('#dlgUsage').addEventListener('click', (e) => { if (e.target === $('#dlgUsage')) $('#dlgUsage').close(); });
}

/* ───────────────────────── 启动 ───────────────────────── */

function tickClock() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (x) => String(x).padStart(2, '0');
  $('#clock').textContent = p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + ' 北京';
}

function boot() {
  // Engine 的日志转发到界面
  E.setLogSink((entry) => logLine(entry.message));
  E.getLogs().slice(-40).forEach((e) => logLine(e.message));

  setupDialogs();

  $('#btnCheckinAll').addEventListener('click', doCheckinAll);
  $('#btnRefreshAll').addEventListener('click', doRefreshAll);
  $('#btnDeploy').addEventListener('click', doDeploy);
  $('#btnSaveSettings').addEventListener('click', saveSettings);
  $('#btnClearLog').addEventListener('click', () => { $('#logs').innerHTML = ''; });

  tickClock();
  setInterval(tickClock, 1000);

  const native = window.NativeBridge && window.NativeBridge.isNative;
  logLine(native ? 'TraeWeb 已就绪（内置引擎）· 无需服务器' : 'TraeWeb 已就绪（浏览器模式：网络功能不可用）', 'info');
  loadState();
  setInterval(loadState, 60000);
}

document.addEventListener('DOMContentLoaded', boot);
