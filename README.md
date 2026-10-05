# TraeWeb-Android

TraeWeb 的**自包含** Android 版 —— 不依赖任何外部服务器，装完即用。

## 与旧版的区别

| | v1.x（空壳） | v2.0（自包含） |
|---|---|---|
| 依赖容器跑 Node 服务 | ✅ 必须 | ❌ **不需要** |
| 需要填服务地址/令牌 | ✅ | ❌ **不需要** |
| 网络请求 | 浏览器 fetch（受同源限制） | 原生层发出 |
| 数据存储 | 容器 data/config.json | 本机 SharedPreferences / localStorage |

## 架构

```
WebView (assets/)
  ├── index.html / app.js / style.css    界面
  └── lib/
      ├── nacl.js + sealedbox.js         GitHub Secret 加密（curve25519 sealed box）
      ├── bridge.js                      Promise 化原生桥
      ├── trae.js                        Trae API 客户端
      ├── engine.js                      账号 / 签到 / 存储
      └── github.js                      Actions 部署
        ↓ window.TraeNative (@JavascriptInterface)
  NativeApi.java                         原生 HTTP（绕开同源限制）+ 配置存储
        ↓
  api.trae.cn / api.github.com
```

## 功能

- **手机号登录**：浏览器取码 + 本机登录接口换会话（绕开发码接口的滑块风控）
- **粘贴凭证**：直接粘贴 `X-Cloudide-Session`
- **每日签到**：单账号 / 批量，含 9074 风控自动换设备号重试
- **用量统计**：近 7 天会话、模型、Token、缓存命中
- **云端托管**：一键部署到 GitHub Actions，每天 08:00 自动签到
- **飞书推送**

## 使用

1. 安装 APK
2. 点「+ 手机号登录」，填手机号与验证码；或点「粘贴凭证」
3. 长按返回键打开工具菜单（刷新 / 清空数据 / 关于）

## 构建

```bash
gradle assembleRelease
# 产物：app/build/outputs/apk/release/app-release.apk
```

固定签名（`keystore/traeweb.p12`），后续版本可直接覆盖安装。

## 说明

- 纯 Java + 原生 WebView，无第三方依赖
- `minSdk 26`
- 走的是 Trae 网页端接口，字段随官方可能变动，代码内已做容错解析
