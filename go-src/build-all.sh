#!/bin/bash
#
# build-all.sh —— 一次性交叉编译全部平台的服务端二进制。
#
# 服务端是纯 Go stdlib（零第三方依赖、无平台专属代码），
# 所以同一份源码可直接交叉编译，无需各平台构建机。
#
# 用法：
#   ./build-all.sh            # 输出到 dist/
#   OUT=out ./build-all.sh    # 自定义输出目录
#
set -euo pipefail

cd "$(dirname "$0")"
OUT="${OUT:-dist}"
LDFLAGS="-s -w"   # 去符号与调试信息，体积约减 30%

# 目标平台：OS/ARCH
TARGETS=(
  "linux/amd64"
  "linux/arm64"
  "linux/386"
  "linux/arm"
  "windows/amd64"
  "windows/arm64"
  "darwin/amd64"
  "darwin/arm64"
)

echo "构建服务端 —— 输出到 $OUT/"
mkdir -p "$OUT"

for t in "${TARGETS[@]}"; do
  os="${t%/*}"
  arch="${t#*/}"
  ext=""
  [ "$os" = "windows" ] && ext=".exe"
  name="trae2api-${os}-${arch}${ext}"

  printf "  %-24s" "$name"
  if CGO_ENABLED=0 GOOS="$os" GOARCH="$arch" \
     go build -trimpath -ldflags="$LDFLAGS" -o "$OUT/$name" ./cmd/server 2>/tmp/build-err.txt; then
    printf "%8s B\n" "$(wc -c < "$OUT/$name")"
  else
    printf "失败: %s\n" "$(head -2 /tmp/build-err.txt | tr '\n' ' ')"
    exit 1
  fi
done

# 附上使用说明与配置样例
cat > "$OUT/README.txt" <<'EOF'
TraeWeb 服务端 —— 独立运行版
============================

纯 Go 静态二进制，无需安装运行时，解压即可运行。

一、首次使用
------------
1) 生成访问密钥（客户端用它调用，务必保管好）：

     Linux/macOS:  ./trae2api-linux-amd64 --gen-key
     Windows:      trae2api-windows-amd64.exe --gen-key

2) 准备账号凭证：把 App 里导出的 trae-<uid>.json 放进 ./auths/ 目录。
   文件名任意，.json 后缀即可。

3) 启动：

     Linux/macOS:
       TW2A_API_KEY=<你的密钥> \
       TW2A_AUTH_DIR=./auths \
       TW2A_STATE_FILE=./data/state.json \
       ./trae2api-linux-amd64

     Windows（PowerShell）:
       $env:TW2A_API_KEY="<你的密钥>"
       $env:TW2A_AUTH_DIR=".\auths"
       $env:TW2A_STATE_FILE=".\data\state.json"
       .\trae2api-windows-amd64.exe

4) 控制台：浏览器打开 http://127.0.0.1:7864/admin

二、环境变量
------------
  TW2A_API_KEY       访问密钥（必填，否则任何人可调用）
  TW2A_LISTEN        监听地址，默认 127.0.0.1:7864
                     改成 0.0.0.0:7864 可让局域网访问
  TW2A_AUTH_DIR      凭证目录，默认 ./auths
  TW2A_STATE_FILE    状态文件，默认 ./data/state.json
  TW2A_DNS           DNS 服务器（逗号分隔），留空则用内置兜底
  TW2A_CALLBACK_PORT OAuth 回调端口，默认 18080；设 0 关闭

三、调用方式（OpenAI 兼容）
---------------------------
  curl http://127.0.0.1:7864/v1/chat/completions \
    -H "Authorization: Bearer <你的密钥>" \
    -H "Content-Type: application/json" \
    -d '{"model":"Doubao-Seed-2.1-Pro","messages":[{"role":"user","content":"hi"}]}'

  模型列表：GET /v1/models
  用量统计：GET /admin/api/usage

四、解压后没有执行权限？
------------------------
zip 在部分系统上解压后不保留执行位，执行一次即可：

  chmod +x trae2api-* start-linux.sh

Windows 无需此步（.exe 直接双击或命令行运行）。

五、说明
--------
- 二进制是静态链接的，不依赖系统 libc，可放进容器或最小化系统。
- 凭证里的 token 会过期，过期后需重新登录 App 并替换 auths/ 下的文件。
- 监听非回环地址时，控制台与管理接口会要求非本机请求带 Bearer 密钥。
EOF

echo
echo "完成。产物："
ls -1 "$OUT" | sed 's/^/  /'
echo
echo "使用说明见 $OUT/README.txt"
