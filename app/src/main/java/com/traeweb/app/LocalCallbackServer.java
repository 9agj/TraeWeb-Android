package com.traeweb.app;

import android.util.Log;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URLDecoder;
import java.util.HashMap;
import java.util.Map;

/**
 * 本地 OAuth 回调监听器。
 *
 * 用于「跳到浏览器用手机号登录 → 自动回到 App」的登录闭环：
 *
 *   1. App 生成 Trae 授权链接，auth_callback_url 指向 http://127.0.0.1:<port>/authorize
 *   2. 交给系统浏览器打开，用户在浏览器里完成登录（含滑块验证）
 *   3. Trae 授权完成后 302 跳到该回调地址
 *   4. 本监听器接住请求，解析 query，把凭证交给上层
 *
 * 为什么绑 127.0.0.1 而不是 0.0.0.0：回调只可能来自本机浏览器，
 * 绑 loopback 既不暴露到局域网，也避免被外部误触。
 *
 * 只处理 /authorize 一个路径，拿到结果即关闭，不做成常驻服务。
 */
public class LocalCallbackServer {

    private static final String TAG = "TraeWebCallback";

    /** 回调落点：与 Trae 授权页的 auth_callback_url 一一对应 */
    public static final String PATH = "/authorize";

    /** 回调结果 */
    public static class Result {
        public boolean ok;
        public String error;
        /** 解析出的全部 query 参数（含 token / refreshToken / uid 等） */
        public Map<String, String> params = new HashMap<>();
        public String rawQuery;
    }

    public interface Listener {
        void onResult(Result r);
    }

    private final int port;
    private ServerSocket server;
    private Thread thread;
    private volatile boolean closed = false;
    private Listener listener;

    public LocalCallbackServer(int port) {
        this.port = port;
    }

    public int port() { return port; }

    public String callbackUrl() {
        return "http://127.0.0.1:" + port + PATH;
    }

    public boolean isRunning() {
        return server != null && !server.isClosed();
    }

    /** 启动监听（幂等）。端口被占时返回 false。 */
    public synchronized boolean start(Listener l) {
        if (isRunning()) { this.listener = l; return true; }
        this.listener = l;
        closed = false;
        try {
            server = new ServerSocket(port, 4, InetAddress.getByName("127.0.0.1"));
        } catch (Throwable t) {
            Log.e(TAG, "监听失败 port=" + port + " : " + t.getMessage());
            server = null;
            return false;
        }
        thread = new Thread(this::loop, "local-callback");
        thread.setDaemon(true);
        thread.start();
        Log.i(TAG, "回调监听已启动: " + callbackUrl());
        return true;
    }

    private void loop() {
        while (!closed && server != null && !server.isClosed()) {
            Socket s = null;
            try {
                s = server.accept();
                handle(s);
            } catch (Throwable t) {
                if (!closed) Log.w(TAG, "accept/handle: " + t.getMessage());
            } finally {
                if (s != null) {
                    try { s.close(); } catch (Exception ignored) { }
                }
                // 单次用途：处理完一个回调即收工
                if (listener != null) break;
            }
        }
        close();
    }

    private void handle(Socket s) throws Exception {
        // 读请求行 + 头部（回调都是 GET，不需要读 body）
        BufferedReader r = new BufferedReader(new InputStreamReader(s.getInputStream(), "UTF-8"));
        String requestLine = r.readLine();
        if (requestLine == null) { respond(s, 400, "Bad Request"); return; }
        while (true) {
            String h = r.readLine();
            if (h == null || h.isEmpty()) break;
        }

        String path = "/";
        String query = "";
        String[] parts = requestLine.split(" ");
        if (parts.length >= 2) {
            String target = parts[1];
            int q = target.indexOf('?');
            if (q >= 0) { path = target.substring(0, q); query = target.substring(q + 1); }
            else path = target;
        }

        Log.i(TAG, "收到回调 " + path + (query.isEmpty() ? "" : "?" + query));

        Result res = new Result();
        res.rawQuery = query;

        if (!PATH.equals(path)) {
            respond(s, 404, page(false, "路径不匹配", "回调应落在 " + PATH));
            return;
        }

        res.params = parseQuery(query);
        String token = firstNonEmpty(res.params, "userJwt", "token", "accessToken", "access_token");
        String refresh = firstNonEmpty(res.params, "refreshToken", "refresh_token");

        if (token == null && refresh == null) {
            res.ok = false;
            res.error = "未收到凭证（userJwt / refreshToken 均为空）";
            respond(s, 200, page(false, "授权未完成", res.error));
            notifyListener(res);
            return;
        }

        res.ok = true;
        respond(s, 200, page(true, "登录成功", "已回到 App，可以关闭此页面了。"));
        notifyListener(res);
    }

    private void notifyListener(Result r) {
        Listener l = listener;
        if (l != null) {
            try { l.onResult(r); } catch (Throwable t) { Log.w(TAG, "listener: " + t.getMessage()); }
        }
    }

    private static String firstNonEmpty(Map<String, String> m, String... keys) {
        for (String k : keys) {
            String v = m.get(k);
            if (v != null && !v.isEmpty()) return v;
        }
        return null;
    }

    static Map<String, String> parseQuery(String query) {
        Map<String, String> out = new HashMap<>();
        if (query == null || query.isEmpty()) return out;
        for (String pair : query.split("&")) {
            if (pair.isEmpty()) continue;
            int eq = pair.indexOf('=');
            try {
                if (eq < 0) {
                    out.put(URLDecoder.decode(pair, "UTF-8"), "");
                } else {
                    String k = URLDecoder.decode(pair.substring(0, eq), "UTF-8");
                    String v = URLDecoder.decode(pair.substring(eq + 1), "UTF-8");
                    out.put(k, v);
                }
            } catch (Exception ignored) { }
        }
        return out;
    }

    private void respond(Socket s, int code, String html) {
        try {
            byte[] body = html.getBytes("UTF-8");
            String head = "HTTP/1.1 " + code + " " + (code == 200 ? "OK" : "Error") + "\r\n"
                    + "Content-Type: text/html; charset=utf-8\r\n"
                    + "Cache-Control: no-store\r\n"
                    + "Content-Length: " + body.length + "\r\n"
                    + "Connection: close\r\n\r\n";
            OutputStream os = s.getOutputStream();
            os.write(head.getBytes("UTF-8"));
            os.write(body);
            os.flush();
        } catch (Exception ignored) { }
    }

    /** 结果页：移动端友好，成功后提示可关页面 */
    private static String page(boolean ok, String title, String msg) {
        String color = ok ? "#34c77b" : "#e6a23c";
        return "<!doctype html><html><head><meta charset='utf-8'>"
                + "<meta name='viewport' content='width=device-width,initial-scale=1'>"
                + "<title>" + esc(title) + "</title>"
                + "<style>body{margin:0;background:#0b0d12;color:#e6edf7;"
                + "font:15px/1.7 -apple-system,Roboto,sans-serif;display:flex;align-items:center;"
                + "justify-content:center;min-height:100vh;padding:28px}"
                + ".c{max-width:400px;width:100%;text-align:center}"
                + ".t{font-size:19px;font-weight:600;margin:0 0 10px;color:" + color + "}"
                + ".m{color:#8b98ad;font-size:13.5px}"
                + "</style></head><body><div class='c'>"
                + "<div class='t'>" + esc(title) + "</div>"
                + "<div class='m'>" + esc(msg) + "</div>"
                + "</div></body></html>";
    }

    private static String esc(String s) {
        return String.valueOf(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
    }

    public synchronized void close() {
        closed = true;
        if (server != null) {
            try { server.close(); } catch (Exception ignored) { }
            server = null;
        }
        Log.i(TAG, "回调监听已关闭");
    }
}
