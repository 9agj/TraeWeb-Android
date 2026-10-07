package com.traeweb.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

/**
 * 内置登录页：在 App 自己的 WebView 里完成 Trae 登录。
 *
 * 为什么必须放在 App 内 —— 这是整个凭证问题的破局点：
 *
 *   系统浏览器（Edge）登录后，X-Cloudide-Session 落在 Edge 的 cookie 库里，
 *   而该库用 v10 AES-GCM 加密、密钥存在 Android Keystore（TEE 内），
 *   root 也解不出明文。App 的回调只能拿到 URL 参数（userJwt / refreshToken），
 *   那些是 source=refresh_token 的受限凭证，打业务接口一律 401。
 *
 *   但 cookie 一旦落在**本 App 的 WebView** 里，就能通过
 *   CookieManager.getCookie() 直接读到明文 —— 不需要解密、不需要 root。
 *
 * 所以这里把登录搬进来：用户在本 WebView 内用手机号登录（含滑块），
 * 登录态写入 WebView 的 cookie jar 后，我们直接取用。
 */
public class LoginWebViewActivity extends Activity {

    public static final String EXTRA_RESULT = "login_result";

    /** 回调地址：WebView 内拦截，不真正请求（避免依赖本地监听端口） */
    private static final String CALLBACK_URL = "http://127.0.0.1:18081/authorize";

    /**
     * 登录入口改为 OAuth 授权链接（而非普通的 trae.cn 首页）。
     *
     * 为什么必须这样：普通登录只会拿到 X-Cloudide-Session，而 session 存在
     * WebView 的 cookie 罐里 —— 一个罐只能装一个号。要登第二个号就得先登出
     * 第一个，**登出会让服务端作废前一个 session**，于是第一个号的凭证直接
     * 失效。这就是「登第二个号弄掉第一个号」的根因。
     *
     * 走 OAuth 授权流程时，回调会带回 refreshToken：它按账号独立、长期有效、
     * 登出不作废。有了它每个账号可以各自续期，互不干扰。
     */
    private static final String AUTH_BASE = "https://www.trae.cn/authorization";

    /** 回调里捕获到的 refreshToken（若有） */
    private volatile String capturedRefreshToken = "";
    /** 首次检测到 session 的时间；用于给 OAuth 回调留出宽限期 */
    private volatile long firstSeenSessionAt = 0;
    /**
     * 拿到 session 后还要等多久才允许结束（毫秒）。
     *
     * 原因：session cookie 一出现就允许点「完成」，用户往往立刻点了 ——
     * 而 OAuth 回调（refreshToken 的唯一来源）通常稍后才触发。
     * 提前结束就只能拿到 session，多账号场景必然出问题。
     */
    private static final long CALLBACK_GRACE_MS = 12000;
    /** 回调原始 URL，便于排查 */
    private volatile String capturedCallback = "";
    private static final String SESSION_COOKIE = "X-Cloudide-Session";

    private WebView webView;
    private ProgressBar progressBar;
    private TextView statusView;
    private Button doneButton;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#0d1117"));

        // ── 顶部提示条 ──
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.VERTICAL);
        bar.setBackgroundColor(Color.parseColor("#161b22"));
        bar.setPadding(dp(14), dp(12), dp(14), dp(12));

        TextView title = new TextView(this);
        title.setText("登录 Trae");
        title.setTextColor(Color.parseColor("#e6edf3"));
        title.setTextSize(16f);
        title.setTypeface(null, android.graphics.Typeface.BOLD);
        bar.addView(title);

        statusView = new TextView(this);
        statusView.setText("请用手机号登录。登录成功后会自动识别并返回。");
        statusView.setTextColor(Color.parseColor("#8b949e"));
        statusView.setTextSize(12.5f);
        statusView.setPadding(0, dp(4), 0, dp(8));
        bar.addView(statusView);

        LinearLayout btns = new LinearLayout(this);
        btns.setOrientation(LinearLayout.HORIZONTAL);

        doneButton = new Button(this);
        doneButton.setText("我已登录完成");
        doneButton.setEnabled(false);
        doneButton.setOnClickListener((v) -> finishWithCookies());
        btns.addView(doneButton);

        Button cancel = new Button(this);
        cancel.setText("取消");
        cancel.setOnClickListener((v) -> {
            setResult(RESULT_CANCELED);
            finish();
        });
        btns.addView(cancel);

        bar.addView(btns);
        root.addView(bar);

        // ── 进度条 ──
        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        root.addView(progressBar, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(3)));

        // ── WebView ──
        webView = new WebView(this);
        root.addView(webView, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        // 桌面 UA 更容易拿到完整登录页（部分移动端页面会隐藏某些入口）
        s.setUserAgentString(s.getUserAgentString().replace("Mobile", ""));

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, true);

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView v, int p) {
                progressBar.setProgress(p);
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView v, String url) {
                // 每次页面加载完都探一次，登录成功通常伴随跳转
                checkLoginState();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                String u = req.getUrl() == null ? "" : req.getUrl().toString();
                // OAuth 回调：就地解析出 refreshToken，不真正加载（无需本地监听端口）
                if (u.startsWith(CALLBACK_URL)) {
                    captureFromCallback(u);
                    firstSeenSessionAt = 0;   // 已拿到回调，无需再等
                    runOnUiThread(() -> {
                        statusView.setText(capturedRefreshToken.isEmpty()
                                ? "✓ 已检测到登录凭证"
                                : "✓ 已拿到长期凭证（refreshToken），点上方按钮完成");
                        statusView.setTextColor(Color.parseColor("#3fb950"));
                        doneButton.setEnabled(true);
                    });
                    return true;
                }
                // 其余全部留在本 WebView 内，登录态才不会跑出去
                return false;
            }
        });

        webView.loadUrl(buildAuthUrl());
    }


    /** 构造 OAuth 授权链接（参数与 NativeApi.buildAuthUrl 对齐） */
    private String buildAuthUrl() {
        java.util.UUID u = java.util.UUID.randomUUID();
        String mid = u.toString().replace("-", "").substring(0, 32);
        String did = String.format("%019d", Math.abs(u.getMostSignificantBits() % 1000000000000000000L));
        try {
            StringBuilder sb = new StringBuilder(AUTH_BASE).append("?");
            sb.append("login_version=1");
            sb.append("&auth_from=solo");
            sb.append("&login_channel=native_ide");
            sb.append("&plugin_version=2.3.24254");
            sb.append("&auth_type=local");
            sb.append("&client_id=").append(java.net.URLEncoder.encode("ono9krqynydwx5", "UTF-8"));
            sb.append("&redirect=0");
            sb.append("&login_trace_id=").append(java.net.URLEncoder.encode(u.toString(), "UTF-8"));
            sb.append("&auth_callback_url=").append(java.net.URLEncoder.encode(CALLBACK_URL, "UTF-8"));
            sb.append("&machine_id=").append(mid);
            sb.append("&device_id=").append(did);
            sb.append("&x_device_id=").append(did);
            sb.append("&x_machine_id=").append(mid);
            sb.append("&x_device_brand=").append(java.net.URLEncoder.encode("Xiaomi", "UTF-8"));
            sb.append("&x_device_type=android");
            sb.append("&x_os_version=").append(java.net.URLEncoder.encode(android.os.Build.VERSION.RELEASE, "UTF-8"));
            sb.append("&x_env=");
            sb.append("&x_app_version=0.1.7");
            sb.append("&x_app_type=stable");
            sb.append("&hide_saas_login=true");
            return sb.toString();
        } catch (Throwable t) {
            return "https://www.trae.cn/";   // 兜底：退回普通登录
        }
    }

    /**
     * 从回调 URL 里取 refreshToken。
     *
     * 回调形如：
     *   http://127.0.0.1:18081/authorize?refreshToken=xxx&userJwt=yyy&...
     * 参数可能整体包在 data= 里（JSON），两种形态都试。
     */
    private void captureFromCallback(String url) {
        capturedCallback = url;
        try {
            String q = url;
            int p = q.indexOf('?');
            if (p >= 0) q = q.substring(p + 1);
            int h = q.indexOf('#');
            if (h >= 0) q = q.substring(0, h);
            for (String kv : q.split("&")) {
                int eq = kv.indexOf('=');
                if (eq <= 0) continue;
                String k = kv.substring(0, eq);
                String v = java.net.URLDecoder.decode(kv.substring(eq + 1), "UTF-8");
                if ("refreshToken".equalsIgnoreCase(k) && !v.isEmpty()) {
                    capturedRefreshToken = v;
                }
            }
            // 参数可能被塞进 data= 的 JSON 里
            if (capturedRefreshToken.isEmpty()) {
                java.util.regex.Matcher m = java.util.regex.Pattern
                        .compile("\"refreshToken\"\\s*:\\s*\"([^\"]+)\"")
                        .matcher(java.net.URLDecoder.decode(q, "UTF-8"));
                if (m.find()) capturedRefreshToken = m.group(1);
            }
        } catch (Throwable ignored) { }
    }

    /** 检查登录态：只要 cookie jar 里出现了 X-Cloudide-Session，就认为已登录。
     * 同时把 localStorage 里的 Cloud-IDE-Token 一并取出（部分接口需要）。
     */
    private void checkLoginState() {
        try {
            String cookies = CookieManager.getInstance().getCookie("https://www.trae.cn");
            String session = extractCookie(cookies, SESSION_COOKIE);
            boolean hasSession = session != null && !session.isEmpty();
            boolean hasRefresh = capturedRefreshToken != null && !capturedRefreshToken.isEmpty();
            if (hasRefresh) {
                statusView.setText("✓ 已拿到长期凭证（refreshToken），点上方按钮完成");
                statusView.setTextColor(Color.parseColor("#3fb950"));
                doneButton.setEnabled(true);
            } else if (hasSession) {
                if (firstSeenSessionAt == 0) firstSeenSessionAt = System.currentTimeMillis();
                long waited = System.currentTimeMillis() - firstSeenSessionAt;
                if (waited < CALLBACK_GRACE_MS) {
                    // 给 OAuth 回调留时间 —— 它才是 refreshToken 的来源
                    statusView.setText("已登录，正在等待授权回调（约 "
                            + ((CALLBACK_GRACE_MS - waited) / 1000 + 1) + " 秒）…");
                    statusView.setTextColor(Color.parseColor("#d29922"));
                    doneButton.setEnabled(false);
                } else {
                    statusView.setText("✓ 已检测到登录凭证（未收到授权回调），点上方按钮完成");
                    statusView.setTextColor(Color.parseColor("#d29922"));
                    doneButton.setEnabled(true);
                }
            } else {
                statusView.setText("尚未检测到登录凭证，请继续在页面内完成登录。");
                statusView.setTextColor(Color.parseColor("#8b949e"));
                doneButton.setEnabled(false);
                firstSeenSessionAt = 0;
            }
        } catch (Throwable t) {
            statusView.setText("检测登录态失败：" + t.getMessage());
        }
    }

    /** 收集凭证并返回 */
    private void finishWithCookies() {
        String cookies;
        try {
            cookies = CookieManager.getInstance().getCookie("https://www.trae.cn");
        } catch (Throwable t) {
            Toast.makeText(this, "读取 cookie 失败：" + t.getMessage(), Toast.LENGTH_LONG).show();
            return;
        }

        final String session = extractCookie(cookies, SESSION_COOKIE);
        // session 与 refreshToken 二者有一即可：
        //   - 普通登录页 → 只有 session
        //   - OAuth 授权流程 → refreshToken 是主要产物，session 可能没有
        // 之前强制要求 session，走 OAuth 时会被误判成「未登录」。
        if ((session == null || session.isEmpty())
                && (capturedRefreshToken == null || capturedRefreshToken.isEmpty())) {
            Toast.makeText(this, "未检测到登录凭证，请确认已完成登录", Toast.LENGTH_LONG).show();
            return;
        }

        // 一次性把页面里的凭据全取出来。
        //
        // 为什么不能只要 session：WebView 只有一个 cookie 罐，装的是「最后登录
        // 那个号」。要登第二个号就得先登出第一个，而**登出会让服务端作废前一个
        // session** —— 所以靠 session 做多账号，账号之间必然互相踩。
        //
        // refreshToken 不同：按账号独立、长期有效、登出不作废，可以拿它单独续期。
        // 这里把 localStorage / sessionStorage / 当前 URL 全部捞出来，
        // 由前端挑出 refreshToken（键名不确定，只能全量取回再筛）。
        final String dumpJs =
                "(function(){try{"
                + "var o={local:{},session:{}};"
                + "try{for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);"
                + "o.local[k]=localStorage.getItem(k);}}catch(e){}"
                + "try{for(var j=0;j<sessionStorage.length;j++){var k2=sessionStorage.key(j);"
                + "o.session[k2]=sessionStorage.getItem(k2);}}catch(e){}"
                + "o.url=location.href;"
                + "return JSON.stringify(o);"
                + "}catch(e){return '{}';}})()";

        webView.evaluateJavascript(dumpJs, value -> {
                    String dump = unquoteJson(value);
                    String token = "";
                    try {
                        JSONObject all = new JSONObject(dump == null || dump.isEmpty() ? "{}" : dump);
                        JSONObject local = all.optJSONObject("local");
                        if (local != null) token = local.optString("Cloud-IDE-Token", "");
                    } catch (Throwable ignored) { }
                    try {
                        JSONObject o = new JSONObject();
                        o.put("ok", true);
                        o.put("session", session);
                        o.put("token", token == null ? "" : token);
                        o.put("cookies", cookies == null ? "" : cookies);
                        // 全量页面存储 + 当前 URL：前端据此筛出 refreshToken
                        o.put("storage", dump == null ? "" : dump);
                        String cur = webView.getUrl();
                        o.put("pageUrl", cur == null ? "" : cur);
                        // OAuth 回调里直接拿到的 refreshToken（最可靠的一路）
                        o.put("refreshToken", capturedRefreshToken == null ? "" : capturedRefreshToken);
                        o.put("callbackUrl", capturedCallback == null ? "" : capturedCallback);

                        String payload = o.toString();
                        // 落盘：跨 Activity 回传受 launchMode / 进程回收影响，存盘更稳。
                        // PREF 名与 NativeApi 保持一致，前端用 getWebLoginResult() 取。
                        getSharedPreferences("traeweb_store", MODE_PRIVATE)
                                .edit()
                                .putString("web_login_result", payload)
                                .apply();

                        Intent data = new Intent();
                        data.putExtra(EXTRA_RESULT, payload);
                        setResult(RESULT_OK, data);
                    } catch (Throwable ignored) { }
                    finish();
                });
    }

    /** 从 Cookie 串里取指定名字的值 */
    private static String extractCookie(String cookieStr, String name) {
        if (cookieStr == null) return null;
        for (String part : cookieStr.split(";")) {
            String p = part.trim();
            int eq = p.indexOf('=');
            if (eq > 0 && p.substring(0, eq).equals(name)) {
                return p.substring(eq + 1);
            }
        }
        return null;
    }

    /** evaluateJavascript 返回的是 JSON 字面量（带引号），去掉外层引号并反转义 */
    private static String unquoteJson(String v) {
        if (v == null) return null;
        String s = v.trim();
        if (s.equals("null") || s.isEmpty()) return null;
        if (s.startsWith("\"") && s.endsWith("\"") && s.length() >= 2) {
            s = s.substring(1, s.length() - 1);
            s = s.replace("\\\"", "\"").replace("\\\\", "\\")
                 .replace("\\n", "\n").replace("\\/", "/");
        }
        return s;
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            setResult(RESULT_CANCELED);
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (webView != null) webView.destroy();
        super.onDestroy();
    }

    private int dp(int v) {
        return Math.round(getResources().getDisplayMetrics().density * v);
    }
}
