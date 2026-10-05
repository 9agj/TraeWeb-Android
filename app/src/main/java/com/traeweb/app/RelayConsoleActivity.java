package com.traeweb.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

/**
 * 中转站控制台。
 *
 * 独立 Activity 而非在主界面里嵌 iframe —— 主界面是 file:///android_asset/ 页面，
 * 同源策略下无法内嵌 http://127.0.0.1:7864 的内容；用独立 WebView 直接导航过去最干净。
 *
 * 控制台本身由 Go 服务提供（/admin），账号登录/授权/额度都在那里完成。
 */
public class RelayConsoleActivity extends Activity {

    private WebView webView;
    private TextView errorView;
    private ProgressBar progressBar;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0b0d12"));

        webView = new WebView(this);
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        root.addView(webView);

        errorView = new TextView(this);
        errorView.setTextColor(Color.parseColor("#c9d4e6"));
        errorView.setTextSize(14f);
        errorView.setPadding(dp(24), dp(24), dp(24), dp(24));
        errorView.setVisibility(View.GONE);
        errorView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER));
        root.addView(errorView);

        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        FrameLayout.LayoutParams plp = new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(3));
        plp.gravity = Gravity.TOP;
        progressBar.setLayoutParams(plp);
        progressBar.setVisibility(View.GONE);
        root.addView(progressBar);

        setContentView(root);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        webView.setWebChromeClient(new WebChromeClient());
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView v, String url, android.graphics.Bitmap f) {
                progressBar.setVisibility(View.VISIBLE);
            }
            @Override
            public void onPageFinished(WebView v, String url) {
                progressBar.setVisibility(View.GONE);
            }
            @Override
            public void onReceivedError(WebView v, int code, String desc, String failingUrl) {
                progressBar.setVisibility(View.GONE);
                showError("无法连接中转站\n\n" + desc + "\n\n服务可能未启动 —— 回到主界面，"
                        + "长按返回键 → 重启中转站。");
            }
        });

        RelayService relay = RelayService.get(this);
        if (!relay.isRunning() || !relay.probe()) {
            // 从控制台进来时发现服务没跑，补启动一次
            new Thread(() -> {
                boolean ok = relay.start();
                runOnUiThread(() -> {
                    if (ok) loadConsole();
                    else showError("中转站启动失败\n\n" + relay.lastError()
                            + "\n\n二进制是否缺失：" + (relay.binaryPresent() ? "否" : "是"));
                });
            }, "relay-console-boot").start();
            progressBar.setVisibility(View.VISIBLE);
        } else {
            loadConsole();
        }
    }

    private void loadConsole() {
        errorView.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        webView.loadUrl(RelayService.get(this).consoleUrl());
    }

    private void showError(String msg) {
        errorView.setText(msg);
        errorView.setVisibility(View.VISIBLE);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && webView.canGoBack()) {
            webView.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
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
