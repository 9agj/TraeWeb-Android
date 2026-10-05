package com.traeweb.app;

import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
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

import androidx.appcompat.app.AppCompatActivity;

/**
 * TraeWeb 的原生外壳。
 *
 * 只做一件事：把容器里跑的 TraeWeb 服务（默认 127.0.0.1:8790）用全屏 WebView 包起来，
 * 免去每次开浏览器、输地址、输 token 的麻烦。
 *
 * 注意：本应用**不自带** Node 服务，服务运行在 DSHA 容器内。
 * 若容器没启动，会显示错误页并提供「修改地址 / 重试」入口。
 */
public class MainActivity extends AppCompatActivity {

    private static final String PREF = "traeweb_prefs";
    private static final String KEY_URL = "access_url";
    /** 默认地址：容器与手机共享网络栈，因此本机回环即可直达 */
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

        currentUrl = prefs.getString(KEY_URL, null);
        if (currentUrl == null || currentUrl.trim().isEmpty()) {
            showSettingsDialog(true);
        } else {
            loadUrl(currentUrl);
        }
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

        // 错误页
        errorView = new LinearLayout(this);
        errorView.setOrientation(LinearLayout.VERTICAL);
        errorView.setGravity(Gravity.CENTER);
        errorView.setPadding(dp(32), dp(32), dp(32), dp(32));
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
        errorDetail.setPadding(0, dp(12), 0, dp(24));
        errorView.addView(errorDetail);

        Button retry = new Button(this);
        retry.setText("重试");
        retry.setOnClickListener(v -> {
            errorView.setVisibility(View.GONE);
            webView.setVisibility(View.VISIBLE);
            loadUrl(currentUrl);
        });
        errorView.addView(retry);

        Button config = new Button(this);
        config.setText("修改地址");
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
        s.setUserAgentString(s.getUserAgentString() + " TraeWebShell/1.0");

        // 保留浏览器 Cookie（访问令牌靠它记住），但不启用第三方 Cookie
        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                progressBar.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progressBar.setVisibility(View.GONE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                // 只关心主文档错误，忽略子资源失败
                if (request != null && request.isForMainFrame()) {
                    showError(String.valueOf(error.getDescription()));
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                // 站外链接交给系统浏览器
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

    private static String baseOrigin(String url) {
        try {
            Uri u = Uri.parse(url);
            return u.getScheme() + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
        } catch (Exception e) {
            return url;
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
        if (url == null || url.trim().isEmpty()) return;
        String u = url.trim();
        if (!u.startsWith("http://") && !u.startsWith("https://")) {
            u = "http://" + u;
        }
        currentUrl = u;
        errorView.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        webView.loadUrl(u);
    }

    /* -------------------------------------------------------- 设置对话框 */

    private void showSettingsDialog(boolean firstRun) {
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI | InputType.TYPE_CLASS_TEXT);
        input.setText(prefs.getString(KEY_URL, DEFAULT_URL));
        input.setSelectAllOnFocus(true);
        input.setTextSize(14f);

        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(20), dp(8), dp(20), 0);

        TextView tip = new TextView(this);
        tip.setText("填入 TraeWeb 服务地址。\n\n· 手机本机：http://127.0.0.1:8790/?token=你的令牌\n"
                + "· 局域网 ：http://192.168.x.x:8790/?token=你的令牌\n\n"
                + "带一次 ?token= 之后浏览器会记住，之后可只填 http://127.0.0.1:8790/");
        tip.setTextSize(12.5f);
        tip.setTextColor(Color.parseColor("#a8b0bd"));
        box.addView(tip);

        LinearLayout.LayoutParams ilp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        ilp.topMargin = dp(14);
        input.setLayoutParams(ilp);
        box.addView(input);

        AlertDialog.Builder b = new AlertDialog.Builder(this)
                .setTitle(firstRun ? "首次配置" : "修改服务地址")
                .setView(box)
                .setCancelable(!firstRun)
                .setPositiveButton("保存", null);
        if (!firstRun) b.setNegativeButton("取消", null);

        AlertDialog dlg = b.create();
        dlg.setOnShowListener(d -> dlg.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            String v2 = input.getText().toString().trim();
            if (v2.isEmpty()) {
                Toast.makeText(this, "地址不能为空", Toast.LENGTH_SHORT).show();
                return;
            }
            prefs.edit().putString(KEY_URL, v2).apply();
            dlg.dismiss();
            loadUrl(v2);
        }));
        dlg.show();

        if (dlg.getWindow() != null) {
            dlg.getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_STATE_VISIBLE);
        }
    }

    /* ------------------------------------------------------------ 生命周期 */

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (errorView.getVisibility() == View.VISIBLE) {
                return super.onKeyDown(keyCode, event);
            }
            if (webView.canGoBack()) {
                webView.goBack();
                return true;
            }
        }
        return super.onKeyDown(keyCode, event);
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 回到前台时若当前是错误页，自动重试一次（服务可能刚启动）
        if (errorView.getVisibility() == View.VISIBLE && currentUrl != null) {
            loadUrl(currentUrl);
        }
    }

    private int dp(int v) {
        return Math.round(getResources().getDisplayMetrics().density * v);
    }
}
