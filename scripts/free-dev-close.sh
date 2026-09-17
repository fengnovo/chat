#!/usr/bin/env bash
# === 关闭 chat 项目 dev 栈（web/api/worker） ===
REPO=/Users/keen/Desktop/code/projects/chat

# 1) 优雅终止：dev 编排进程 + 端口占用进程
pkill -TERM -f 'free-dev-ports\.mjs' 2>/dev/null
pkill -TERM -f 'concurrently' 2>/dev/null
lsof -ti tcp:3020 2>/dev/null | xargs -r kill -TERM 2>/dev/null
lsof -ti tcp:8002 2>/dev/null | xargs -r kill -TERM 2>/dev/null

# 2) 优雅终止：本仓库的 worker（tsx --watch 父进程 + src/worker.ts 子进程）
for pid in $(pgrep -f 'worker\.(ts|js)' 2>/dev/null); do
  cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep '^n' | sed 's/^n//' | head -1)
  case "$cwd" in "$REPO"/*) kill -TERM "$pid" 2>/dev/null ;; esac
done

sleep 2

# 3) 强制清理：端口幸存者 + 本仓库 worker 幸存者
lsof -ti tcp:3020 tcp:8002 2>/dev/null | xargs -r kill -KILL 2>/dev/null
for pid in $(pgrep -f 'worker\.(ts|js)' 2>/dev/null); do
  cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep '^n' | sed 's/^n//' | head -1)
  case "$cwd" in "$REPO"/*) kill -KILL "$pid" 2>/dev/null ;; esac
done

# 4) 校验
echo "──────── 端口 3020/8002 ────────"
(lsof -nP -iTCP:3020 -iTCP:8002 -sTCP:LISTEN 2>/dev/null | grep -E ':(3020|8002)') && echo "⚠️  仍有端口占用" || echo "✅ 3020/8002 已释放"

echo "──────── 本仓库 worker ────────"
leak=0
for pid in $(pgrep -f 'worker\.(ts|js)' 2>/dev/null); do
  cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep '^n' | sed 's/^n//' | head -1)
  case "$cwd" in "$REPO"/*) leak=1; echo "⚠️  残留 worker pid=$pid cwd=$cwd" ;; esac
done
[ $leak -eq 0 ] && echo "✅ 本仓库无残留 worker"