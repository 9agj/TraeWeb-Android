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
    /** taskId -> 响应 JSON；值为 null 表示仍在进行中 */
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
        tasks.put(id, null);
        pool.execute(() -> {
            String result;
            try {
                result = doHttp(url, method, headersJson, body);
            } catch (Throwable t) {
                result = errorJson("网络异常：" + t.getClass().getSimpleName() + " " + safe(t.getMessage()));
            }
            tasks.put(id, result);
        });
        return id;
    }

    /** 轮询结果。返回空串表示仍在进行；返回 JSON 字符串表示完成（并从表中移除）。 */
    @JavascriptInterface
    public String httpPoll(String id) {
        String v = tasks.get(id);
        if (v == null) return "";
        tasks.remove(id);
        return v;
    }

    /** 取消/丢弃任务。 */
    @JavascriptInterface
    public void httpAbort(String id) {
        tasks.remove(id);
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
        return store.getString(key, "");
    }

    @JavascriptInterface
    public void storeSet(String key, String value) {
        store.edit().putString(key, value == null ? "" : value).apply();
    }

    @JavascriptInterface
    public void storeRemove(String key) {
        store.edit().remove(key).apply();
    }

    /* ------------------------------------------------------------ 杂项 */

    @JavascriptInterface
    public void toast(String msg) {
        new Handler(Looper.getMainLooper()).post(
                () -> Toast.makeText(ctx, msg, Toast.LENGTH_SHORT).show());
    }

    @JavascriptInterface
    public void log(String msg) {
        Log.i(TAG, msg);
    }

    /** 供 Java 侧读取（例如把服务地址注入页面） */
    public SharedPreferences prefs() {
        return store;
    }
}
