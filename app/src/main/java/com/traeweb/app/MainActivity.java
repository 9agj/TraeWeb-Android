package com.traeweb.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

/**
 * TraeWeb 自包含外壳（v2）。
 *
 * 与 v1 的根本区别：**不再依赖任何外部服务器**。
 *   - 前端与全部业务逻辑随 APK 打包在 assets/ 内
 *   - 网络请求经 NativeApi（@JavascriptInterface）在原生层发出，绕开 WebView 同源限制
 *   - 数据存 SharedPreferences / localStorage，纯本地
 *
 * 因此不再需要填「服务地址」，装完即用；只有手机号登录那一步需要联网。
 */
public class MainActivity extends Activity {

    private WebView webView;
    private ProgressBar progressBar;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

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

        setContentView(root);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // localStorage：账号数据存这里
        s.setDatabaseEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setSupportZoom(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        // 页面自身是 file:// ，不发起任何 Web 请求；网络全部走 NativeApi
        s.setBlockNetworkLoads(false);

        CookieManager.getInstance().setAcceptCookie(true);
        webView.setWebChromeClient(new WebChromeClient());

        // 关键：注入原生能力（必须在 loadUrl 之前）
        webView.addJavascriptInterface(new NativeApi(this), "TraeNative");

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
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String u = String.valueOf(uri);
                // 站外链接交给系统浏览器；本地资源放行
                if (!u.startsWith("file://") && !u.startsWith("about:")) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                        return true;
                    } catch (Exception ignored) { }
                }
                return false;
            }
        });

        webView.loadUrl("file:///android_asset/index.html");

        // 内嵌接入服务：后台拉起 Go 服务，不阻塞界面。
        // 二进制缺失（构建异常）时静默失败，前端「接入地址」面板会显示具体状态。
        new Thread(() -> RelayService.get(this).start(), "relay-boot").start();
    }

    /* ------------------------------------------------------------ 生命周期 */

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            event.startTracking();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    /** 长按返回键 = 工具菜单（清空数据等），配置错误时也能自救 */
    @Override
    public boolean onKeyLongPress(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            showToolsMenu();
            return true;
        }
        return super.onKeyLongPress(keyCode, event);
    }

    @Override
    public boolean onKeyUp(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            if (event.isTracking() && !event.isCanceled()) {
                if (webView.canGoBack()) {
                    webView.goBack();
                    return true;
                }
                return super.onKeyUp(keyCode, event);
            }
            return true;
        }
        return super.onKeyUp(keyCode, event);
    }

    private void showToolsMenu() {
        new AlertDialog.Builder(this)
                .setTitle("TraeWeb 工具")
                .setItems(new String[]{"接入地址控制台", "重启接入服务", "刷新页面", "清空全部数据", "关于"}, (d, which) -> {
                    if (which == 0) {
                        startActivity(new Intent(this, RelayConsoleActivity.class));
                    } else if (which == 1) {
                        RelayService.get(this).restart();
                        android.widget.Toast.makeText(this, "正在重启接入服务…", android.widget.Toast.LENGTH_SHORT).show();
                    } else if (which == 2) {
                        webView.reload();
                    } else if (which == 3) {
                        new AlertDialog.Builder(this)
                                .setTitle("确认清空？")
                                .setMessage("将删除本机保存的所有账号凭证与签到记录，不可恢复。\n\n"
                                        + "接入服务的账号凭证在另一个目录，不会被清掉 —— 需要的话进控制台单独删。")
                                .setPositiveButton("清空", (d2, w2) -> {
                                    webView.evaluateJavascript(
                                            "try{localStorage.clear();}catch(e){};location.reload();", null);
                                })
                                .setNegativeButton("取消", null)
                                .show();
                    } else {
                        new AlertDialog.Builder(this)
                                .setTitle("TraeWeb")
                                .setMessage("自包含版 · 无需服务器\n\n"
                                        + "① 签到面板：管理 Trae 账号、每日签到、云端部署\n"
                                        + "② 接入地址：把 Trae 模型通道转成 OpenAI 兼容接口\n"
                                        + "    地址 http://" + RelayService.get(this).baseUrl().replace("http://", "")
                                        + "  端口 " + RelayService.get(this).port() + "\n\n"
                                        + "两部分数据各自独立存放，互不影响。\n"
                                        + "长按返回键可再次打开本菜单。")
                                .setPositiveButton("知道了", null)
                                .show();
                    }
                })
                .show();
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
