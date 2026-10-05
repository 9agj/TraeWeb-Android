/*
 * github.js —— GitHub 云端签到部署（浏览器版）
 *
 * 由 Node 版逐条移植：
 *   fetch        → NativeBridge.http
 *   tweetnacl    → window.nacl / window.sealedBox（WebView 内本地加密）
 * 其余流程（仓库就绪 → 写 Secret → 启用 workflow → 触发验证）不变。
 */
(function () {
  'use strict';

  const NB = window.NativeBridge;
  const API = 'https://api.github.com';
  const UA = 'TraeWeb/1.0';
  const SOURCE_OWNER = 'star620';
  const SOURCE_REPO = 'TraeTools';
  const WORKFLOW_PATH = '.github/workflows/checkin.yml';
  const MAX_CLOUD_ACCOUNTS = 4;

  /* ------------------------------------------------------------ 请求 */

  async function api(path, opts) {
    const o = opts || {};
    const headers = {
      'User-Agent': UA,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (o.token) headers.Authorization = 'Bearer ' + o.token;
    let body = '';
    if (o.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(o.body);
    }
    const r = await NB.http(API + path, o.method || 'GET', headers, body, 45000);
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      text: r.text,
      json: NB.jparse(r.text),
      setCookie: r.setCookie || [],
    };
  }

  /* --------------------------------------------- sealed box（写 Secret 用） */

  /**
   * libsodium crypto_box_seal。nonce 由 BLAKE2b(eph_pk ‖ recipient_pk) 派生，
   * 不是随机数 —— 密文布局里没有 nonce 的位置。
   */
  function sealedBox(message, publicKey) {
    if (!window.sealedBox) throw new Error('sealedBox 未加载');
    return window.sealedBox.seal(message, publicKey);
  }

  /* ------------------------------------------------------------ 授权 */

  async function getLogin(token) {
    const r = await api('/user', { token: token });
    return r.ok && r.json ? r.json.login : null;
  }

  async function validateToken(token, owner) {
    const login = await getLogin(token);
    if (!login) return { valid: false, error: 'Token 无效或已被撤销' };
    const repoPath = owner ? '/repos/' + owner + '/' + SOURCE_REPO : '/repos/' + login + '/' + SOURCE_REPO;
    const r = await api(repoPath, { token: token });
    if (r.status === 404) return { valid: true, login: login, canWrite: false, note: '尚未创建仓库，部署时会自动创建' };
    if (!r.ok) return { valid: false, login: login, error: 'HTTP ' + r.status };
    const canPush = r.json && r.json.permissions && r.json.permissions.push === true;
    return {
      valid: true,
      login: login,
      canWrite: canPush,
      error: canPush ? null : '该 Token 对目标仓库没有写权限（需 repo scope）',
    };
  }

  /* ------------------------------------------------------------ 仓库 */

  async function repoStatus(token, owner) {
    const r = await api('/repos/' + owner + '/' + SOURCE_REPO, { token: token });
    return r.status;
  }

  /** 已有同名仓库则复用，否则 fork 源仓库 */
  async function ensureRepo(token, login, onLog) {
    const st = await repoStatus(token, login);
    if (st === 200) return { ok: true, reused: true };
    if (st === 401 || st === 403) {
      return { ok: false, error: '授权不足（HTTP ' + st + '）：需包含 repo scope；细粒度 PAT 需对源仓库开启 Administration 读写' };
    }
    const f = await api('/repos/' + SOURCE_OWNER + '/' + SOURCE_REPO + '/forks', { method: 'POST', token: token });
    if (f.status !== 202 && !f.ok) {
      return { ok: false, error: 'fork 失败：HTTP ' + f.status + ' ' + String(f.text).slice(0, 140) };
    }
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      if (onLog && i % 5 === 0) onLog('等待 fork 完成…（' + (i * 2) + 's）');
      if ((await repoStatus(token, login)) === 200) return { ok: true, reused: false };
    }
    return { ok: false, error: 'fork 超时未完成' };
  }

  /* ------------------------------------------------------------ Secret */

  async function setSecret(token, owner, name, value) {
    const pk = await api('/repos/' + owner + '/' + SOURCE_REPO + '/actions/secrets/public-key', { token: token });
    if (!pk.ok) {
      return { ok: false, error: pk.status === 401 ? 'GitHub 授权已失效' : '获取公开密钥失败：HTTP ' + pk.status };
    }
    const key = pk.json && pk.json.key;
    const keyId = pk.json && pk.json.key_id;
    if (!key || !keyId) return { ok: false, error: '公开密钥响应缺少 key/key_id' };

    if (!window.nacl || !window.sealedBox) {
      return { ok: false, error: '加密库未加载（nacl.js / sealedbox.js）' };
    }
    const pkBytes = new Uint8Array(atob(key).split('').map((c) => c.charCodeAt(0)));
    const sealed = sealedBox(NB.utf8(value), pkBytes);
    const sealedB64 = NB.toBase64(sealed);

    const r = await api('/repos/' + owner + '/' + SOURCE_REPO + '/actions/secrets/' + name, {
      method: 'PUT',
      token: token,
      body: { encrypted_value: sealedB64, key_id: keyId },
    });
    return r.ok ? { ok: true } : { ok: false, error: '写入 ' + name + ' 失败：HTTP ' + r.status + ' ' + String(r.text).slice(0, 120) };
  }

  async function deleteSecret(token, owner, name) {
    const r = await api('/repos/' + owner + '/' + SOURCE_REPO + '/actions/secrets/' + name, { method: 'DELETE', token: token });
    return r.ok || r.status === 404 ? { ok: true } : { ok: false, error: 'HTTP ' + r.status };
  }

  async function listSecrets(token, owner) {
    const r = await api('/repos/' + owner + '/' + SOURCE_REPO + '/actions/secrets', { token: token });
    if (!r.ok) return null;
    return ((r.json && r.json.secrets) || []).map((s) => s.name);
  }

  const sessionSecretName = (i) => (i <= 1 ? 'TRAE_SESSION' : 'TRAE_SESSION_' + i);
  const deviceSecretName = (i) => (i <= 1 ? 'TRAE_DEVICE_ID' : 'TRAE_DEVICE_ID_' + i);

  /* ------------------------------------------------------------ Actions */

  async function ensureActionsEnabled(token, owner) {
    const r = await api('/repos/' + owner + '/' + SOURCE_REPO + '/actions/permissions', {
      method: 'PUT', token: token, body: { enabled: true, allowed_actions: 'all' },
    });
    return r.ok ? { ok: true } : { ok: false, error: '开启 Actions 失败：HTTP ' + r.status };
  }

  async function getWorkflowId(token, owner) {
    const r = await api('/repos/' + owner + '/' + SOURCE_REPO + '/actions/workflows', { token: token });
    if (!r.ok) return { id: -1, error: r.status === 409 ? '仓库未开启 Actions' : 'HTTP ' + r.status };
    const wf = ((r.json && r.json.workflows) || []).find((w) => w.path === WORKFLOW_PATH);
    return wf ? { id: wf.id, state: wf.state } : { id: -1, error: '未找到 checkin workflow' };
  }

  async function enableWorkflow(token, owner, id) {
    const r = await api('/repos/' + owner + '/' + SOURCE_REPO + '/actions/workflows/' + id + '/enable', { method: 'PUT', token: token });
    return r.ok ? { ok: true } : { ok: false, error: '启用 workflow 失败：HTTP ' + r.status };
  }

  async function dispatchWorkflow(token, owner, id) {
    const r = await api('/repos/' + owner + '/' + SOURCE_REPO + '/actions/workflows/' + id + '/dispatches', {
      method: 'POST', token: token, body: { ref: 'main' },
    });
    return r.ok || r.status === 204 ? { ok: true } : { ok: false, error: '触发 workflow 失败：HTTP ' + r.status };
  }

  /** 最近一次 checkin 运行结论（只看 checkin.yml，避免把 CI/Release 误当签到结果） */
  async function latestCheckinRun(token, owner) {
    const wf = await getWorkflowId(token, owner);
    if (wf.id < 0) return null;
    const r = await api('/repos/' + owner + '/' + SOURCE_REPO + '/actions/runs?workflow_id=' + wf.id + '&per_page=1', { token: token });
    if (!r.ok) return null;
    const run = r.json && r.json.workflow_runs && r.json.workflow_runs[0];
    if (!run) return null;
    return {
      conclusion: run.conclusion,
      status: run.status,
      createdAt: run.created_at,
      runNumber: run.run_number,
      htmlUrl: run.html_url,
    };
  }

  /** 部署状态：IsDeployed = 仓库存在 && 有 secrets && workflow 已启用 */
  async function deploymentStatus(token, login) {
    const out = { authorized: true, repoExists: false, hasSecrets: false, deployedCount: 0, workflowEnabled: false, isDeployed: false };
    const me = await api('/user', { token: token });
    if (me.status === 401) { out.authorized = false; return out; }

    if ((await repoStatus(token, login)) !== 200) return out;
    out.repoExists = true;

    const names = await listSecrets(token, login);
    if (names) {
      const set = {};
      names.forEach((n) => { set[n] = 1; });
      let n = 1;
      while (set[sessionSecretName(n)] && set[deviceSecretName(n)]) n++;
      out.deployedCount = n - 1;
      out.hasSecrets = out.deployedCount >= 1;
    }
    const wf = await getWorkflowId(token, login);
    out.workflowEnabled = wf.id > 0 && wf.state === 'active';
    out.isDeployed = out.repoExists && out.hasSecrets && out.workflowEnabled;
    return out;
  }

  /* ------------------------------------------------------------ 一键部署 */

  async function deploy(token, accounts, feishuWebhook, onLog) {
    const say = onLog || function () {};
    const login = await getLogin(token);
    if (!login) return { ok: false, error: 'GitHub 授权已失效，请重新授权' };

    const enabled = accounts.filter((a) => a.enabled && a.session);
    if (enabled.length === 0) return { ok: false, error: '没有可用账号（需已启用且持有会话）' };
    if (enabled.length > MAX_CLOUD_ACCOUNTS) {
      return { ok: false, error: '云端部署上限为 ' + MAX_CLOUD_ACCOUNTS + ' 个账号（受 checkin.yml 映射限制）' };
    }

    if (!window.nacl || !window.sealedBox) {
      return { ok: false, error: '加密库未加载，无法写入 Secret' };
    }

    say('已授权：' + login);
    const repo = await ensureRepo(token, login, say);
    if (!repo.ok) return { ok: false, error: repo.error };
    say(repo.reused ? '复用现有仓库 ' + login + '/' + SOURCE_REPO : 'fork 完成：' + login + '/' + SOURCE_REPO);

    for (let i = 0; i < enabled.length; i++) {
      const idx = i + 1;
      const s1 = await setSecret(token, login, sessionSecretName(idx), enabled[i].session);
      if (!s1.ok) return { ok: false, error: s1.error };
      say(sessionSecretName(idx) + ' 写入成功');
      const s2 = await setSecret(token, login, deviceSecretName(idx), enabled[i].deviceId || '');
      if (!s2.ok) return { ok: false, error: s2.error };
      say(deviceSecretName(idx) + ' 写入成功');
    }

    for (let n = enabled.length + 1; n <= MAX_CLOUD_ACCOUNTS; n++) {
      await deleteSecret(token, login, sessionSecretName(n));
      await deleteSecret(token, login, deviceSecretName(n));
    }
    say('已清理多余 secret');

    if (feishuWebhook) {
      const s3 = await setSecret(token, login, 'FEISHU_WEBHOOK', feishuWebhook);
      if (!s3.ok) return { ok: false, error: s3.error };
      say('FEISHU_WEBHOOK 写入成功');
    }

    let wf = await getWorkflowId(token, login);
    if (wf.id < 0) {
      say('未找到 checkin workflow，正在开启 GitHub Actions…');
      const en = await ensureActionsEnabled(token, login);
      if (!en.ok) return { ok: false, error: en.error };
      for (let i = 0; i < 12 && wf.id < 0; i++) {
        await new Promise((r) => setTimeout(r, 5000));
        wf = await getWorkflowId(token, login);
      }
      if (wf.id < 0) return { ok: false, error: '已开启 Actions 但仍未登记 workflow，请确认仓库存在 .github/workflows/checkin.yml' };
    }
    say('checkin workflow 已就绪');

    const en = await enableWorkflow(token, login, wf.id);
    if (!en.ok) return { ok: false, error: en.error };
    say('workflow 已启用');

    const dp = await dispatchWorkflow(token, login, wf.id);
    if (!dp.ok) return { ok: false, error: dp.error };
    say('已触发一次验证运行');

    let conclusion = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      const run = await latestCheckinRun(token, login);
      if (run && run.conclusion) { conclusion = run.conclusion; break; }
    }
    if (conclusion === 'success') {
      say('部署成功！' + enabled.length + ' 个账号已就绪，GitHub 将在每天北京时间 08:00 自动签到');
    } else if (!conclusion) {
      say('已触发，但未在超时内拿到结果，请到 Actions 页面查看');
    } else {
      say('运行结论：' + conclusion + '。常见原因：① Trae 风控 ② 会话已过期');
    }

    return { ok: true, login: login, accounts: enabled.length, conclusion: conclusion };
  }

  window.GitHubApi = {
    SOURCE_OWNER: SOURCE_OWNER,
    SOURCE_REPO: SOURCE_REPO,
    MAX_CLOUD_ACCOUNTS: MAX_CLOUD_ACCOUNTS,
    getLogin: getLogin,
    validateToken: validateToken,
    deploymentStatus: deploymentStatus,
    latestCheckinRun: latestCheckinRun,
    deploy: deploy,
    listSecrets: listSecrets,
    // 本地自测用
    _sealedBox: sealedBox,
  };
})();
