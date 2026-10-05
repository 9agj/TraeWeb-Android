/*
 * refdata.js —— 开发参考数据 + 密钥生成器
 *
 * ⚠️ 重要说明（务必如实呈现给使用者）：
 *   Trae **没有**对外提供模型 API，也没有 API Key 机制。实测结论：
 *     - POST /v1/chat/completions            → 404
 *     - POST /trae/api/{v1,v2}/chat/completions → 404
 *     - POST /trae/api/{v1,v2}/model/list    → 404
 *     - /docs 与 /open 均为 SPA 兜底路由，非开放平台
 *   因此下面的「模型」来自官网定价页的产品数据（展示用），
 *   「端点」来自官网前端 JS 里的接口字面量（开发参考用），
 *   「密钥生成」是一个独立的本地随机串工具，与 Trae 无关。
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------ 模型 */

  const MODELS = [
    { id: 'seed-2-1-turbo', name: 'Seed-2.1-Turbo', vendor: '字节 Seed', note: '限时折扣' },
    { id: 'seed-code', name: 'Seed-Code', vendor: '字节 Seed', note: '代码向' },
    { id: 'deepseek-flash', name: 'DeepSeek-Flash', vendor: 'DeepSeek', note: '低峰可用' },
    { id: 'deepseek-pro', name: 'DeepSeek-Pro', vendor: 'DeepSeek', note: '低峰可用' },
    { id: 'glm-5-2-5-3', name: 'GLM 5.2 / 5.3', vendor: '智谱', note: '限时折扣' },
    { id: 'claude', name: 'Claude', vendor: 'Anthropic', note: '产品线提及' },
    { id: 'kimi', name: 'Kimi', vendor: '月之暗面', note: '产品线提及' },
    { id: 'doubao', name: 'Doubao', vendor: '字节豆包', note: '产品线提及' },
  ];

  /* ------------------------------------------------------------ 端点 */

  const ENDPOINTS = [
    {
      group: '账号与会话',
      items: [
        ['POST', '/cloudide/api/v3/common/GetUserToken', '用 Session 换取新 JWT（8 小时）'],
        ['POST', '/cloudide/api/v3/trae/GetUserInfo', '账号资料：昵称 / 脱敏手机号 / 头像'],
        ['POST', '/cloudide/api/v3/trae/Login', '登录'],
        ['POST', '/trae/api/v3/student_verification/status', '学生认证状态'],
      ],
    },
    {
      group: '签到',
      items: [
        ['POST', '/trae/api/v2/ug/checkin_credits/status', '今日签到状态'],
        ['POST', '/trae/api/v2/ug/checkin_credits/claim', '执行签到'],
      ],
    },
    {
      group: '积分与用量',
      items: [
        ['POST', '/trae/api/v2/pay/user_current_entitlement_list', '剩余积分（汇总资格包）'],
        ['POST', '/trae/api/v1/pay/query_user_usage_group_by_session', '按会话聚合的用量'],
        ['POST', '/trae/api/v2/pay/expired_ents', '即将过期 / 已过期权益'],
        ['POST', '/trae/api/v2/pay/cn_product_list', '在售套餐'],
      ],
    },
    {
      group: 'Passport（登录链路）',
      items: [
        ['POST', '/passport/web/send_code/?aid=711126&mobile=&type=24', '发验证码（受滑块风控保护）'],
        ['POST', '/passport/web/sms_login/?aid=711126&mobile=&code=', '短信登录（不校验滑块）'],
      ],
    },
    {
      group: '兑换与邀请',
      items: [
        ['POST', '/trae/api/v1/pay/get_invite_code', '获取邀请码'],
        ['POST', '/trae/api/v1/pay/redeem_invite_code', '兑换邀请码'],
        ['POST', '/trae/api/v1/pay/redeem_promo_code', '兑换优惠码'],
        ['POST', '/trae/api/v1/pay/invite_stats', '邀请统计'],
      ],
    },
  ];

  /** 统一前缀（所有 /trae 与 /cloudide 路径都挂在这个 host 下） */
  const API_HOST = 'https://api.trae.cn';
  const SITE_HOST = 'https://www.trae.cn';
  const TRAE_AID = '711126';

  /* ------------------------------------------------------- 密钥生成器 */

  const CHARSETS = {
    alnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
    hex: '0123456789abcdef',
    base64url: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',
    full: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_!@#$%^&*',
  };

  /** 优先用 Web Crypto 的强随机源；退化到 Math.random 并标注 */
  function randomBytes(n) {
    const out = new Uint8Array(n);
    if (window.crypto && window.crypto.getRandomValues) {
      window.crypto.getRandomValues(out);
      return { bytes: out, strong: true };
    }
    for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
    return { bytes: out, strong: false };
  }

  /**
   * 生成密钥列表。
   * @param {number} count 条数
   * @param {number} length 每条长度
   * @param {string} charsetName 字符集名
   * @param {string} prefix 前缀（可选）
   */
  function generateKeys(count, length, charsetName, prefix) {
    const cs = CHARSETS[charsetName] || CHARSETS.alnum;
    const n = Math.max(1, Math.min(200, count | 0));
    const len = Math.max(4, Math.min(128, length | 0));
    const pre = prefix || '';

    // 用拒绝采样消除取模偏置
    const limit = Math.floor(256 / cs.length) * cs.length;
    const keys = [];
    for (let k = 0; k < n; k++) {
      let s = '';
      while (s.length < len) {
        const r = randomBytes(Math.max(16, (len - s.length) * 2 + 8));
        const b = r.bytes;
        for (let i = 0; i < b.length && s.length < len; i++) {
          if (b[i] < limit) s += cs[b[i] % cs.length];
        }
      }
      keys.push(pre + s);
    }
    return { keys: keys, strong: !!(window.crypto && window.crypto.getRandomValues) };
  }

  window.RefData = {
    MODELS: MODELS,
    ENDPOINTS: ENDPOINTS,
    API_HOST: API_HOST,
    SITE_HOST: SITE_HOST,
    TRAE_AID: TRAE_AID,
    CHARSETS: Object.keys(CHARSETS),
    generateKeys: generateKeys,
  };
})();
