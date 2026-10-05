package com.traeweb.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

/**
 * TraeWeb 的原生外壳。
 *
 * 把容器里跑的 TraeWeb 服务用全屏 WebView 包起来，免去每次开浏览器输地址的麻烦。
 *
 * 配置模型（v1.1 起）：**地址与令牌分开存**
 *   - base_url : 服务地址，如 http://127.0.0.1:8790/
 *   - token    : 访问令牌，加载时自动拼到 URL 上
 *   这样换网络只改地址，令牌不用重填；也兼容直接粘贴带 ?token= 的完整 URL。
 *
 * 改配置入口：**长按返回键**（避免配置错了却进不去设置）。
 */
public class MainActivity extends Activity {

    private static final String PREF = "traeweb_prefs";
    private static final String KEY_URL = "base_url";
    private static final String KEY_TOKEN = "access_token";
    private static final String DEFAULT_URL = "http://127.0.0.1:8790/";

    private WebView webView;
    private ProgressBar progressBar;
    private LinearLayout errorView;
    private TextView errorDetail;
    private SharedPreferences prefs;
    private String currentUrl;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        prefs = getSharedPreferences(PREF, Context.MODE_PRIVATE);
        buildUi();

        String url = buildUrl();
        if (url == null) {
            showSettingsDialog(true);
        } else {
            loadUrl(url);
        }
    }

    /* ------------------------------------------------------------ URL 组装 */

    /** 把 base_url 与 token 拼成最终地址；未配置返回 null。 */
    private String buildUrl() {
        String base = prefs.getString(KEY_URL, null);
        if (base == null || base.trim().isEmpty()) return null;
        base = base.trim();
        if (!base.startsWith("http://") && !base.startsWith("https://")) {
            base = "http://" + base;
        }
        String token = prefs.getString(KEY_TOKEN, "");
        if (token == null || token.trim().isEmpty()) return base;
        if (base.contains("token=")) return base; // URL 已自带令牌
        return base + (base.contains("?") ? "&" : "?") + "token=" + token.trim();
    }

    /* ------------------------------------------------------------ UI */

    private void buildUi() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0a0c10"));

        webView = new WebView(this);
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(webView);

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        FrameLayout.LayoutParams plp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(3));
        plp.gravity = Gravity.TOP;
        progressBar.setLayoutParams(plp);
        progressBar.setVisibility(View.GONE);
        root.addView(progressBar);

        errorView = new LinearLayout(this);
        errorView.setOrientation(LinearLayout.VERTICAL);
        errorView.setGravity(Gravity.CENTER);
        errorView.setPadding(dp(28), dp(28), dp(28), dp(28));
        errorView.setBackgroundColor(Color.parseColor("#0a0c10"));
        errorView.setVisibility(View.GONE);

        TextView title = new TextView(this);
        title.setText("连不上 TraeWeb 服务");
        title.setTextColor(Color.parseColor("#e6e9ef"));
        title.setTextSize(19f);
        title.setGravity(Gravity.CENTER);
        errorView.addView(title);

        errorDetail = new TextView(this);
        errorDetail.setTextColor(Color.parseColor("#7b8494"));
        errorDetail.setTextSize(13f);
        errorDetail.setGravity(Gravity.CENTER);
        errorDetail.setPadding(0, dp(12), 0, dp(22));
        errorView.addView(errorDetail);

        Button retry = new Button(this);
        retry.setText("重试");
        retry.setOnClickListener(v -> {
            errorView.setVisibility(View.GONE);
            webView.setVisibility(View.VISIBLE);
            loadUrl(buildUrl());
        });
        errorView.addView(retry);

        Button config = new Button(this);
        config.setText("修改配置");
        config.setOnClickListener(v -> showSettingsDialog(false));
        errorView.addView(config);

        root.addView(errorView);
        setContentView(root);

        setupWebView();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setSupportZoom(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " TraeWebShell/1.1");

        CookieManager.getInstance().setAcceptCookie(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                progressBar.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progressBar.setVisibility(View.GONE);
                detectAuthFailure(view);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request != null && request.isForMainFrame()) {
                    showError(String.valueOf(error.getDescription()));
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (!String.valueOf(uri).startsWith(baseOrigin(currentUrl))) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                        return true;
                    } catch (Exception ignored) { }
                }
                return false;
            }
        });
    }

    /**
     * 检测是否落到服务端的 401 页（页面里有 meta[name=traeweb-auth]）。
     * 命中则提示用户：令牌不对，且告知改配置的入口。
     */
    private void detectAuthFailure(WebView view) {
        view.evaluateJavascript(
                "(function(){try{return document.querySelector('meta[name=\"traeweb-auth\"]')?'1':'0';}catch(e){return '0';}})()",
                value -> {
                    if (value != null && value.contains("1")) {
                        Toast.makeText(MainActivity.this,
                                "访问令牌无效 —— 长按返回键可修改配置", Toast.LENGTH_LONG).show();
                    }
                });
    }

    private static String baseOrigin(String url) {
        try {
            Uri u = Uri.parse(url);
            return u.getScheme() + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
        } catch (Exception e) {
            return url == null ? "" : url;
        }
    }

    private void showError(String detail) {
        progressBar.setVisibility(View.GONE);
        webView.setVisibility(View.GONE);
        errorDetail.setText("无法连接：" + currentUrl + "\n\n" + detail
                + "\n\n请确认：\n1) DSHA 容器已启动\n2) TraeWeb 服务已运行（bash /root/traeweb/start.sh）\n3) 地址与端口正确");
        errorView.setVisibility(View.VISIBLE);
    }

    private void loadUrl(String url) {
        if (url == null || url.trim().isEmpty()) {
            showSettingsDialog(true);
            return;
        }
        currentUrl = url.trim();
        errorView.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        webView.loadUrl(currentUrl);
    }

    /* -------------------------------------------------------- 配置对话框 */

    private void showSettingsDialog(boolean firstRun) {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(8), dp(20), 0);

        TextView tip = new TextView(this);
        tip.setText("服务地址：TraeWeb 跑在哪里。\n"
                + "访问令牌：只填一次，之后自动带上，换网也不用重填。\n\n"
                + "查看令牌：bash /root/traeweb/info.sh");
        tip.setTextSize(12.5f);
        tip.setTextColor(Color.parseColor("#a8b0bd"));
        box.addView(tip);

        TextView l1 = new TextView(this);
        l1.setText("服务地址");
        l1.setTextSize(12f);
        l1.setTextColor(Color.parseColor("#7b8494"));
        l1.setPadding(0, dp(14), 0, dp(4));
        box.addView(l1);

        EditText inUrl = new EditText(this);
        inUrl.setInputType(InputType.TYPE_TEXT_VARIATION_URI | InputType.TYPE_CLASS_TEXT);
        String savedUrl = prefs.getString(KEY_URL, "");
        if (savedUrl == null || savedUrl.isEmpty()) savedUrl = DEFAULT_URL;
        inUrl.setText(savedUrl);
        inUrl.setSelectAllOnFocus(true);
        inUrl.setTextSize(14f);
        box.addView(inUrl);

        TextView l2 = new TextView(this);
        l2.setText("访问令牌（可留空；也可直接在上面的地址里带 ?token=）");
        l2.setTextSize(12f);
        l2.setTextColor(Color.parseColor("#7b8494"));
        l2.setPadding(0, dp(12), 0, dp(4));
        box.addView(l2);

        EditText inToken = new EditText(this);
        inToken.setInputType(InputType.TYPE_CLASS_TEXT);
        inToken.setText(prefs.getString(KEY_TOKEN, ""));
        inToken.setHint("例如 u6G2nrxIU0ECbag2");
        inToken.setSelectAllOnFocus(true);
        inToken.setTextSize(14f);
        box.addView(inToken);

        AlertDialog.Builder b = new AlertDialog.Builder(this)
                .setTitle(firstRun ? "首次配置" : "修改配置")
                .setView(box)
                .setCancelable(!firstRun)
                .setPositiveButton("保存", null);
        if (!firstRun) b.setNegativeButton("取消", null);

        AlertDialog dlg = b.create();
        dlg.setOnShowListener(d -> dlg.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            String u = inUrl.getText().toString().trim();
            String t = inToken.getText().toString().trim();
            if (u.isEmpty()) {
                Toast.makeText(this, "服务地址不能为空", Toast.LENGTH_SHORT).show();
                return;
            }
            if (t.isEmpty()) {
                // 允许 URL 自带 token
                int i = u.indexOf("token=");
                if (i < 0) {
                    Toast.makeText(this, "请填写访问令牌（或在地址里带上 ?token=）", Toast.LENGTH_LONG).show();
                    return;
                }
            }
            prefs.edit().putString(KEY_URL, u).putString(KEY_TOKEN, t).apply();
            dlg.dismiss();
            loadUrl(buildUrl());
        }));
        dlg.show();

        if (dlg.getWindow() != null) {
            dlg.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE);
        }
    }

    /* ------------------------------------------------------------ 生命周期 */

    /**
     * 返回键三段式处理：短按 = 后退/退出，长按 = 打开配置。
     * 注意：onKeyLongPress 只有在 onKeyDown 里调用了 event.startTracking() 后才会触发，
     * 所以这里 onKeyDown 一律先 startTracking 并消费，真正的动作交给 onKeyUp / onKeyLongPress。
     */
    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            event.startTracking();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    /** 长按返回键 = 打开配置（配置错了也能自救，不必清应用数据） */
    @Override
    public boolean onKeyLongPress(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            showSettingsDialog(false);
            return true;
        }
        return super.onKeyLongPress(keyCode, event);
    }

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (event.isTracking() && !event.isCanceled()) {
                // 短按
                if (errorView.getVisibility() == View.VISIBLE) {
                    return super.onKeyUp(keyCode, event);
                }
                if (webView.canGoBack()) {
                    webView.goBack();
                    return true;
                }
                return super.onKeyUp(keyCode, event); // 无历史可退：交还系统（退出应用）
            }
            return true; // 已被长按消费
        }
        return super.onKeyUp(keyCode, event);
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (errorView.getVisibility() == View.VISIBLE) {
            loadUrl(buildUrl());
        }
    }

    private int dp(int v) {
        return Math.round(getResources().getDisplayMetrics().density * v);
    }
}
