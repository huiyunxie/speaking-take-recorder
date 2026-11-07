#!/bin/bash
# EchoTake · 一键启动
# 只在本机 127.0.0.1 上开一个静态服务，然后把页面交给 Chrome。
set -euo pipefail
cd "$(dirname "$0")"

PORT=8765
while lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
  PORT=$((PORT + 1))
done

URL="http://127.0.0.1:${PORT}/"

cleanup() {
  if [ -n "${SRV:-}" ] && kill -0 "$SRV" 2>/dev/null; then
    kill "$SRV" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "EchoTake 正在启动：${URL}"
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SRV=$!

sleep 0.8
if [ -d "/Applications/Google Chrome.app" ]; then
  open -a "Google Chrome" "$URL"
else
  open "$URL"
fi

echo "页面已打开。关闭这个终端窗口即可停止服务。"
wait "$SRV"
