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

    private static final String START_URL = "https://www.trae.cn/";
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
                // 全部留在本 WebView 内，登录态才不会跑出去
                return false;
            }
        });

        webView.loadUrl(START_URL);
    }

    /**
     * 检查登录态：只要 cookie jar 里出现了 X-Cloudide-Session，就认为已登录。
     * 同时把 localStorage 里的 Cloud-IDE-Token 一并取出（部分接口需要）。
     */
    private void checkLoginState() {
        try {
            String cookies = CookieManager.getInstance().getCookie("https://www.trae.cn");
            String session = extractCookie(cookies, SESSION_COOKIE);
            if (session != null && !session.isEmpty()) {
                statusView.setText("✓ 已检测到登录凭证，点上方按钮完成");
                statusView.setTextColor(Color.parseColor("#3fb950"));
                doneButton.setEnabled(true);
            } else {
                statusView.setText("尚未检测到登录凭证，请继续在页面内完成登录。");
                statusView.setTextColor(Color.parseColor("#8b949e"));
                doneButton.setEnabled(false);
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
        if (session == null || session.isEmpty()) {
            Toast.makeText(this, "未找到 " + SESSION_COOKIE + "，请确认已登录", Toast.LENGTH_LONG).show();
            return;
        }

        // 再从页面里取一次 Cloud-IDE-Token（localStorage，明文）
        webView.evaluateJavascript(
                "(function(){try{return localStorage.getItem('Cloud-IDE-Token')||'';}catch(e){return '';}})()",
                value -> {
                    String token = unquoteJson(value);
                    try {
                        JSONObject o = new JSONObject();
                        o.put("ok", true);
                        o.put("session", session);
                        o.put("token", token == null ? "" : token);
                        o.put("cookies", cookies == null ? "" : cookies);

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
