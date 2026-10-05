package com.traeweb.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 注入到 WebView 的原生能力层。
 *
 * 设计要点：
 *  - @JavascriptInterface 方法在 WebView 的 JS 线程上执行，**同步耗时操作会冻结页面**。
 *    因此网络请求采用「启动 + 轮询」两段式：httpStart 立即返回 taskId，
 *    后台线程真正发请求，JS 侧轮询 httpPoll 取结果。
 *  - 不引入 OkHttp 等依赖，使用 JDK 自带的 HttpURLConnection，保持 APK 极简。
 *  - 存储落在 SharedPreferences，替代原 Node 版的 data/config.json。
 */
public class NativeApi {

    private static final String TAG = "TraeWebNative";
    private static final String PREF = "traeweb_store";

    private final Context ctx;
    private final SharedPreferences store;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    /**
     * taskId -> 响应 JSON。
     * 约定：空串 "" 表示仍在进行中，非空字符串表示已完成。
     * 注意不能用 null 表示进行中 —— ConcurrentHashMap 不允许 null value，会抛 NPE。
     */
    private static final String PENDING = "";
    private final Map<String, String> tasks = new ConcurrentHashMap<>();

    public NativeApi(Context ctx) {
        this.ctx = ctx.getApplicationContext();
        this.store = this.ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    /* ------------------------------------------------------------ 网络 */

    /**
     * 发起请求（异步）。立即返回 taskId。
     * @param headersJson JSON 对象形式的请求头，可为 "{}"
     * @param body        POST 正文，GET 传空串
     */
    @JavascriptInterface
    public String httpStart(String url, String method, String headersJson, String body) {
        final String id = UUID.randomUUID().toString();
        tasks.put(id, PENDING);
        try {
            pool.execute(() -> {
                String result;
                try {
                    result = doHttp(url, method, headersJson, body);
                } catch (Throwable t) {
                    result = errorJson("网络异常：" + t.getClass().getSimpleName() + " " + safe(t.getMessage()));
                }
                tasks.put(id, result);
            });
        } catch (Throwable t) {
            // 线程池已关闭等极端情况：直接落成已完成态，避免异常穿透到 JS
            tasks.put(id, errorJson("任务提交失败：" + safe(t.getMessage())));
        }
        return id;
    }

    /**
     * 轮询结果。
     * 返回空串 = 仍在进行；返回非空 JSON = 已完成（同时从表中移除）。
     * 任何异常都在此收敛，绝不抛给 JS —— @JavascriptInterface 一抛异常，前端只会收到
     * 一句无信息量的 "Java exception was raised during method invocation"。
     */
    @JavascriptInterface
    public String httpPoll(String id) {
        try {
            if (id == null) return PENDING;
            final String v = tasks.get(id);
            if (v == null) return PENDING;      // 未知 id：视为未完成，由前端超时兜底
            if (PENDING.equals(v)) return PENDING;
            tasks.remove(id);
            return v;
        } catch (Throwable t) {
            return errorJson("轮询异常：" + safe(t.getMessage()));
        }
    }

    /** 取消/丢弃任务。 */
    @JavascriptInterface
    public void httpAbort(String id) {
        try {
            tasks.remove(id);
        } catch (Throwable ignored) { }
    }

    private String doHttp(String url, String method, String headersJson, String body) {
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod(method == null || method.isEmpty() ? "GET" : method);
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(30000);
            conn.setInstanceFollowRedirects(false);   // 手动处理，便于捕获 Set-Cookie
            conn.setRequestProperty("User-Agent", "TraeWeb/1.0 (Android)");

            // 请求头
            if (headersJson != null && !headersJson.isEmpty()) {
                JSONObject hs = new JSONObject(headersJson);
                Iterator<String> it = hs.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    String v = hs.optString(k, "");
                    if (!k.isEmpty()) {
                        try {
                            conn.setRequestProperty(k, v);
                        } catch (Exception ignore) {
                            // 某些受限头（如 Host）会抛异常，跳过即可
                        }
                    }
                }
            }

            // 正文
            boolean hasBody = body != null && !body.isEmpty()
                    && !"GET".equalsIgnoreCase(method) && !"HEAD".equalsIgnoreCase(method);
            if (hasBody) {
                conn.setDoOutput(true);
                byte[] payload = body.getBytes(StandardCharsets.UTF_8);
                conn.setFixedLengthStreamingMode(payload.length);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(payload);
                }
            } else {
                conn.setDoOutput(false);
            }

            int code = conn.getResponseCode();
            String text = readAll(code >= 400 ? conn.getErrorStream() : conn.getInputStream());

            JSONObject out = new JSONObject();
            out.put("status", code);
            out.put("body", text);
            out.put("ok", code >= 200 && code < 300);

            // Set-Cookie 全部收集（GitHub 写 secret、Trae 换 JWT 都要用）
            Map<String, java.util.List<String>> hf = conn.getHeaderFields();
            org.json.JSONArray cookies = new org.json.JSONArray();
            for (Map.Entry<String, java.util.List<String>> e : hf.entrySet()) {
                if (e.getKey() != null && "set-cookie".equalsIgnoreCase(e.getKey())) {
                    for (String c : e.getValue()) cookies.put(c);
                }
            }
            out.put("setCookie", cookies);

            String loc = conn.getHeaderField("Location");
            if (loc != null) out.put("location", loc);

            return out.toString();
        } catch (Throwable t) {
            return errorJson("请求失败：" + t.getClass().getSimpleName() + " " + safe(t.getMessage()));
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static String readAll(InputStream in) {
        if (in == null) return "";
        try (ByteArrayOutputStream bos = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            return bos.toString("UTF-8");
        } catch (Exception e) {
            return "";
        }
    }

    private static String errorJson(String msg) {
        try {
            JSONObject o = new JSONObject();
            o.put("status", 0);
            o.put("ok", false);
            o.put("error", msg);
            o.put("body", "");
            o.put("setCookie", new org.json.JSONArray());
            return o.toString();
        } catch (Exception e) {
            return "{\"status\":0,\"ok\":false,\"error\":\"unknown\",\"body\":\"\",\"setCookie\":[]}";
        }
    }

    private static String safe(String s) {
        return s == null ? "" : s;
    }

    /* ------------------------------------------------------------ 存储 */

    @JavascriptInterface
    public String storeGet(String key) {
        try {
            return store.getString(key, "");
        } catch (Throwable t) {
            return "";
        }
    }

    @JavascriptInterface
    public void storeSet(String key, String value) {
        try {
            store.edit().putString(key, value == null ? "" : value).apply();
        } catch (Throwable t) {
            Log.w(TAG, "storeSet 失败: " + safe(t.getMessage()));
        }
    }

    @JavascriptInterface
    public void storeRemove(String key) {
        try {
            store.edit().remove(key).apply();
        } catch (Throwable ignored) { }
    }

    /* ------------------------------------------------------------ 杂项 */

    @JavascriptInterface
    public void toast(String msg) {
        try {
            new Handler(Looper.getMainLooper()).post(
                    () -> Toast.makeText(ctx, msg, Toast.LENGTH_SHORT).show());
        } catch (Throwable ignored) { }
    }

    @JavascriptInterface
    public void log(String msg) {
        try {
            Log.i(TAG, msg);
        } catch (Throwable ignored) { }
    }

    /* -------------------------------------------------------- 接入服务 */

    /** 接入服务状态：前端据此渲染面板 */
    @JavascriptInterface
    public String relayStatus() {
        try {
            RelayService r = RelayService.get(ctx);
            JSONObject o = new JSONObject();
            o.put("running", r.isRunning() && r.probe());
            o.put("port", r.port());
            o.put("callbackPort", r.callbackPort());
            o.put("baseUrl", r.baseUrl());
            o.put("consoleUrl", r.consoleUrl());
            o.put("apiKey", r.apiKey());
            o.put("baseUrlV1", r.baseUrl() + "/v1");
            o.put("binaryPresent", r.binaryPresent());
            String err = r.lastError();
            o.put("error", err == null ? "" : err);
            return o.toString();
        } catch (Throwable t) {
            return errorJson("relayStatus 失败：" + safe(t.getMessage()));
        }
    }

    /** 启动接入服务（异步，前端轮询 relayStatus 观察结果） */
    @JavascriptInterface
    public void relayStart() {
        try {
            final RelayService r = RelayService.get(ctx);
            new Thread(() -> r.start(), "relay-start").start();
        } catch (Throwable t) {
            Log.w(TAG, "relayStart 失败: " + safe(t.getMessage()));
        }
    }

    @JavascriptInterface
    public void relayStop() {
        try {
            RelayService.get(ctx).stop();
        } catch (Throwable ignored) { }
    }

    @JavascriptInterface
    public void relayRestart() {
        try {
            final RelayService r = RelayService.get(ctx);
            new Thread(() -> r.restart(), "relay-restart").start();
        } catch (Throwable ignored) { }
    }

    /** 打开控制台 Activity（独立 WebView，避免 file:// 页面的同源限制） */
    @JavascriptInterface
    public void relayOpenConsole() {
        try {
            android.content.Intent i = new android.content.Intent(ctx, RelayConsoleActivity.class);
            i.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
        } catch (Throwable t) {
            Log.w(TAG, "打开控制台失败: " + safe(t.getMessage()));
        }
    }

    /** 把文本放进系统剪贴板 */
    @JavascriptInterface
    public void copyToClipboard(String text) {
        try {
            android.content.ClipboardManager cm =
                    (android.content.ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm != null) {
                cm.setPrimaryClip(android.content.ClipData.newPlainText("traeweb", text == null ? "" : text));
            }
        } catch (Throwable t) {
            Log.w(TAG, "复制失败: " + safe(t.getMessage()));
        }
    }

    /**
     * 把签到面板的凭证推送到内嵌接入服务。
     *
     * 接入服务只监听 loopback，而主界面是 file:///android_asset/ 页面 ——
     * 直接 fetch 会被同源策略拦，所以由原生层代发。
     *
     * 用「启动 + 轮询」两段式，理由同 httpStart：@JavascriptInterface 是同步调用，
     * 直接在里面做网络会冻结页面。
     *
     * @param jsonBody 接入服务 /admin/api/accounts/import 接受的请求体
     *                 （形如 {"json":"<嵌套凭证 JSON>"}）
     */
    @JavascriptInterface
    public String relayImportAccount(String jsonBody) {
        final String id = UUID.randomUUID().toString();
        tasks.put(id, PENDING);
        try {
            final RelayService relay = RelayService.get(ctx);
            final String url = relay.baseUrl() + "/admin/api/accounts/import";
            final String key = relay.apiKey();
            pool.execute(() -> {
                String result;
                try {
                    java.net.HttpURLConnection c = null;
                    try {
                        c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                        c.setRequestMethod("POST");
                        c.setConnectTimeout(8000);
                        c.setReadTimeout(20000);
                        c.setDoOutput(true);
                        c.setRequestProperty("Content-Type", "application/json");
                        c.setRequestProperty("Authorization", "Bearer " + key);
                        byte[] body = (jsonBody == null ? "{}" : jsonBody).getBytes(StandardCharsets.UTF_8);
                        c.setFixedLengthStreamingMode(body.length);
                        try (OutputStream os = c.getOutputStream()) {
                            os.write(body);
                        }
                        int code = c.getResponseCode();
                        String text = readAll(code >= 400 ? c.getErrorStream() : c.getInputStream());
                        JSONObject o = new JSONObject();
                        o.put("status", code);
                        o.put("ok", code >= 200 && code < 300);
                        o.put("body", text);
                        result = o.toString();
                    } finally {
                        if (c != null) c.disconnect();
                    }
                } catch (Throwable t) {
                    result = errorJson("导入失败：" + safe(t.getMessage()));
                }
                tasks.put(id, result);
            });
        } catch (Throwable t) {
            tasks.put(id, errorJson("导入任务提交失败：" + safe(t.getMessage())));
        }
        return id;
    }

    /**
     * 从接入服务拉取账号列表 / 状态（只读，走同一条原生转发通道）。
     * @param path 形如 "/admin/api/accounts" 或 "/v1/models"
     */
    @JavascriptInterface
    public String relayGet(String path) {
        final String id = UUID.randomUUID().toString();
        tasks.put(id, PENDING);
        try {
            final RelayService relay = RelayService.get(ctx);
            final String url = relay.baseUrl() + (path == null ? "/" : path);
            final String key = relay.apiKey();
            pool.execute(() -> {
                String result;
                try {
                    java.net.HttpURLConnection c = null;
                    try {
                        c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                        c.setRequestMethod("GET");
                        c.setConnectTimeout(6000);
                        c.setReadTimeout(20000);
                        c.setRequestProperty("Authorization", "Bearer " + key);
                        int code = c.getResponseCode();
                        String text = readAll(code >= 400 ? c.getErrorStream() : c.getInputStream());
                        JSONObject o = new JSONObject();
                        o.put("status", code);
                        o.put("ok", code >= 200 && code < 300);
                        o.put("body", text);
                        result = o.toString();
                    } finally {
                        if (c != null) c.disconnect();
                    }
                } catch (Throwable t) {
                    result = errorJson("请求失败：" + safe(t.getMessage()));
                }
                tasks.put(id, result);
            });
        } catch (Throwable t) {
            tasks.put(id, errorJson("任务提交失败：" + safe(t.getMessage())));
        }
        return id;
    }

    /** 供 Java 侧读取（例如把服务地址注入页面） */
    public SharedPreferences prefs() {
        return store;
    }
}
