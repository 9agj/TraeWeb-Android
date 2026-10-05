package com.traeweb.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Map;
import java.util.UUID;

/**
 * 内嵌中转站（Trae2API）进程管理。
 *
 * 单例，供 MainActivity（启动）与 NativeApi（前端查询状态）共用。
 *
 * 二进制以内嵌方式随 APK 分发：jniLibs/arm64-v8a/libtrae2api.so。
 * 之所以改名 .so，是因为 Android 10+ 只允许 exec nativeLibraryDir 下的文件，
 * 而 app 私有目录受 W^X 限制无法执行。详见 build.gradle 的 useLegacyPackaging 注释。
 *
 * 服务只监听 127.0.0.1，不对外暴露。
 */
public class RelayService {

    private static final String TAG = "TraeWebRelay";
    private static final String BIN_NAME = "libtrae2api.so";
    private static final String PREF = "traeweb_store";
    private static final int HTTP_PORT = 7864;
    private static final int CALLBACK_PORT = 18080;

    private static volatile RelayService instance;

    private final Context ctx;
    private final SharedPreferences prefs;
    private Process process;
    private String lastError;

    private RelayService(Context c) {
        this.ctx = c.getApplicationContext();
        this.prefs = this.ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE);
    }

    public static RelayService get(Context c) {
        if (instance == null) {
            synchronized (RelayService.class) {
                if (instance == null) instance = new RelayService(c);
            }
        }
        return instance;
    }

    public int port() { return HTTP_PORT; }
    public int callbackPort() { return CALLBACK_PORT; }
    public String baseUrl() { return "http://127.0.0.1:" + HTTP_PORT; }
    public String consoleUrl() { return baseUrl() + "/admin"; }
    public String lastError() { return lastError; }

    /** API Key 持久化在本地，首次访问时自动生成 */
    public String apiKey() {
        String k = prefs.getString("relay_api_key", null);
        if (k == null || k.isEmpty()) {
            k = "sk-trae-" + UUID.randomUUID().toString().replace("-", "");
            prefs.edit().putString("relay_api_key", k).apply();
        }
        return k;
    }

    /** 二进制是否存在（构建时 CI 编译产出；缺失说明构建流程有问题） */
    public boolean binaryPresent() {
        return binaryFile().exists();
    }

    private File binaryFile() {
        return new File(new File(ctx.getApplicationInfo().nativeLibraryDir), BIN_NAME);
    }

    public boolean isRunning() {
        if (process == null) return false;
        try {
            // Java 8 无 isAlive()，反射调用（Android 上可用）
            Object r = Process.class.getMethod("isAlive").invoke(process);
            return Boolean.TRUE.equals(r);
        } catch (Throwable t) {
            return true; // 拿不到状态时按存活处理，避免误杀
        }
    }

    /** 启动服务（同步等待端口就绪，最多 30 秒）。幂等：已在跑则直接返回。 */
    public synchronized boolean start() {
        if (isRunning() && probe()) return true;

        File bin = binaryFile();
        if (!bin.exists()) {
            lastError = "内嵌二进制缺失：" + bin.getAbsolutePath();
            Log.e(TAG, lastError);
            return false;
        }

        try {
            File base = ctx.getFilesDir();
            File authDir = new File(base, "relay/auths");
            File dataDir = new File(base, "relay/data");
            if (!authDir.exists() && !authDir.mkdirs()) Log.w(TAG, "authDir 创建失败");
            if (!dataDir.exists() && !dataDir.mkdirs()) Log.w(TAG, "dataDir 创建失败");

            ProcessBuilder pb = new ProcessBuilder(bin.getAbsolutePath());
            pb.directory(base);
            pb.redirectErrorStream(true);

            Map<String, String> env = pb.environment();
            env.put("TW2A_LISTEN", "127.0.0.1:" + HTTP_PORT);
            env.put("TW2A_CALLBACK_PORT", String.valueOf(CALLBACK_PORT));
            env.put("TW2A_API_KEY", apiKey());
            env.put("TW2A_AUTH_DIR", authDir.getAbsolutePath());
            env.put("TW2A_STATE_FILE", new File(dataDir, "state.json").getAbsolutePath());
            env.put("HOME", base.getAbsolutePath());
            env.put("TMPDIR", ctx.getCacheDir().getAbsolutePath());

            Log.i(TAG, "启动中转站: " + bin.getAbsolutePath());
            process = pb.start();

            // 必须持续消费 stdout，否则管道写满会阻塞服务端
            final Process p = process;
            new Thread(() -> {
                try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream()))) {
                    String line;
                    while ((line = r.readLine()) != null) Log.i(TAG, "[relay] " + line);
                } catch (Exception ignored) { }
            }, "relay-log").start();

            for (int i = 0; i < 60; i++) {
                try { Thread.sleep(500); } catch (InterruptedException e) { break; }
                if (probe()) {
                    lastError = null;
                    Log.i(TAG, "中转站就绪: " + baseUrl());
                    return true;
                }
            }
            lastError = "启动超时（30 秒），端口未监听";
            Log.e(TAG, lastError);
            return false;
        } catch (Throwable t) {
            lastError = t.getClass().getSimpleName() + ": " + t.getMessage();
            Log.e(TAG, "启动失败", t);
            return false;
        }
    }

    /** 端口探测：任何 HTTP 状态码都算活着 */
    public boolean probe() {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(baseUrl() + "/v1/models").openConnection();
            c.setConnectTimeout(1500);
            c.setReadTimeout(1500);
            c.setRequestMethod("GET");
            return c.getResponseCode() > 0;
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    public synchronized void stop() {
        if (process != null) {
            try {
                process.destroy();
                Class<?>[] noArgs = new Class<?>[0];
                Process.class.getMethod("destroyForcibly").invoke(process, noArgs);
            } catch (Throwable ignored) { }
            process = null;
            Log.i(TAG, "中转站已停止");
        }
    }

    public synchronized void restart() {
        stop();
        try { Thread.sleep(500); } catch (InterruptedException ignored) { }
        start();
    }
}
