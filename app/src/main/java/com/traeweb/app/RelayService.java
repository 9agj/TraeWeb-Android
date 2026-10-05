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
 * 内嵌接入服务（Trae2API）进程管理。
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
            k = generateKey();
            prefs.edit().putString("relay_api_key", k).apply();
        }
        return k;
    }

    /**
     * 生成一个新的接入服务 Key。
     *
     * 用 SecureRandom 取 24 字节再 base64url —— 192 位熵，
     * 与 UUID.randomUUID()（122 位）相比更宽裕，且去掉了连字符更好复制。
     */
    public static String generateKey() {
        java.security.SecureRandom r = new java.security.SecureRandom();
        byte[] b = new byte[24];
        r.nextBytes(b);
        String s = android.util.Base64.encodeToString(b,
                android.util.Base64.URL_SAFE | android.util.Base64.NO_WRAP | android.util.Base64.NO_PADDING);
        return "sk-trae-" + s;
    }

    /**
     * 设置自定义 Key。改完必须重启服务才生效 ——
     * Key 是通过 TW2A_API_KEY 环境变量传给 Go 进程的，进程不重启读不到新值。
     *
     * @return 规范化后的 Key；非法输入返回 null
     */
    public String setApiKey(String raw) {
        if (raw == null) return null;
        String k = raw.trim();
        if (k.isEmpty()) return null;
        // 只允许安全字符，避免环境变量携带怪字符导致服务异常
        if (!k.matches("^[A-Za-z0-9_\\-.]{8,128}$")) return null;
        prefs.edit().putString("relay_api_key", k).apply();
        Log.i(TAG, "接入服务 Key 已更新（需重启生效）");
        return k;
    }

    /** 随机生成并保存一个新 Key（不自动重启，由调用方决定） */
    public String regenerateApiKey() {
        String k = generateKey();
        prefs.edit().putString("relay_api_key", k).apply();
        Log.i(TAG, "接入服务 Key 已随机重置（需重启生效）");
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

            /*
             * Go 运行时在 Android 上必须收着点，否则会卡住：
             *
             * Android 把 app 放进 `mimd` 内存限制 cgroup，Go 默认按「机器有多少核」
             * 起 P（逻辑处理器），并预留大块虚拟地址。实测在受限 cgroup 下会出现
             * 「端口已 LISTEN、但除 1 个 epoll 线程外全部卡在 futex」的假死 ——
             * TCP 握手都完不成。
             *
             * 限制 P 数量 + 收紧 GC 目标，能显著降低启动期的内存预留压力。
             */
            int cores = Math.max(1, Math.min(4, Runtime.getRuntime().availableProcessors()));
            env.put("GOMAXPROCS", String.valueOf(cores));
            env.put("GOGC", "50");
            env.put("GOMEMLIMIT", "64MiB");
            // 纯 Go 的 DNS 解析器在 Android 上更稳（不依赖 cgo / resolv.conf）
            env.put("GODEBUG", "netdns=go");

            Log.i(TAG, "启动接入服务: " + bin.getAbsolutePath() + " (GOMAXPROCS=" + cores + ")");
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
                    Log.i(TAG, "接入服务就绪: " + baseUrl());
                    return true;
                }
            }
            // 超时后区分两种情况，给出可定位的错误
            boolean listening = tcpListening();
            lastError = listening
                    ? "端口已监听但服务无响应（进程假死）—— 通常是内存受限导致 Go 运行时卡住，"
                      + "已尝试用 GOMAXPROCS/GOMEMLIMIT 规避；可点「重启接入服务」再试"
                    : "启动超时（30 秒），端口未监听";
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

    /**
     * 纯 TCP 层探测：只判断端口是否 accept。
     *
     * 用来区分「服务没起来」和「服务起了但假死」—— 后者表现为端口 LISTEN
     * 但连接超时，光靠 HTTP 探测只能看到 false，无法定位。
     */
    public boolean tcpListening() {
        java.net.Socket s = null;
        try {
            s = new java.net.Socket();
            s.connect(new java.net.InetSocketAddress("127.0.0.1", HTTP_PORT), 1200);
            return true;
        } catch (Throwable t) {
            return false;
        } finally {
            if (s != null) {
                try { s.close(); } catch (Exception ignored) { }
            }
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
            Log.i(TAG, "接入服务已停止");
        }
    }

    public synchronized void restart() {
        stop();
        try { Thread.sleep(500); } catch (InterruptedException ignored) { }
        start();
    }
}
