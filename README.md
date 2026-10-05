# TraeWeb-Android

TraeWeb 的原生 Android 外壳 —— 把跑在 DSHA 容器里的 TraeWeb 服务包成一个可一键启动的 App。

## 它做什么

TraeWeb 本体是一个 Node.js 服务（Trae 多账号签到 / 用量统计 / 云端托管）。本项目只是一个 **WebView 外壳**：

- 全屏加载 TraeWeb，无浏览器地址栏
- 记住服务地址，下次直接进
- 连不上时给出明确提示与「修改地址 / 重试」入口

> ⚠️ **本应用不自带 Node 服务**。服务运行在 DSHA 容器内，需先启动容器并运行 TraeWeb。

## 前置条件

在 DSHA 容器里启动服务：

```bash
bash /root/traeweb/start.sh
```

启动后会打印访问地址，形如：

```
局域网 : http://192.168.5.3:8790/?token=xxxxxxxx
本机   : http://127.0.0.1:8790/?token=xxxxxxxx
```

## 使用

1. 安装 `TraeWeb.apk`
2. 首次打开会弹出配置框，粘贴上面的地址（**带上 `?token=` 那一段**）
3. 保存即可。之后浏览器会记住令牌，可以只填 `http://127.0.0.1:8790/`

因为容器与手机共享网络栈，**手机本机地址 `127.0.0.1:8790` 通常直接可用**。

## 构建

APK 由 GitHub Actions 自动构建，无需本地 Android SDK：

- 推送到 `main` → 构建并上传 Artifact
- 打 `v*` tag → 构建并发布 Release

本地构建（若已装 Android SDK + JDK 17 + Gradle 8.7）：

```bash
gradle assembleRelease
# 产物：app/build/outputs/apk/release/app-release.apk
```

## 技术说明

- 纯 Java，无 Kotlin
- `minSdk 26`（使用纯矢量 adaptive icon，不含 PNG 资源）
- `usesCleartextTraffic=true`（TraeWeb 走 HTTP）
- Release 使用 debug 签名 —— 本项目是个人自用，不发布应用商店
