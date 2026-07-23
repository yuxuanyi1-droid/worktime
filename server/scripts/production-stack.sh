#!/usr/bin/env bash
# 生产多实例管理：3 个 API + 1 个审批 Worker + Caddy 统一入口。
#
# 用法：
#   bash server/scripts/production-stack.sh build
#   bash server/scripts/production-stack.sh start
#   bash server/scripts/production-stack.sh stop
#   bash server/scripts/production-stack.sh restart
#   bash server/scripts/production-stack.sh status
#   bash server/scripts/production-stack.sh logs [api-3011|api-3012|api-3013|worker|caddy]
set -euo pipefail

SERVER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_DIR="$(cd "$SERVER_DIR/.." && pwd)"
RUNTIME_DIR="${WORKTIME_RUNTIME_DIR:-$SERVER_DIR/data/runtime}"
LOG_DIR="$RUNTIME_DIR/logs"
CADDY_CONFIG="${WORKTIME_CADDY_CONFIG:-$REPO_DIR/Caddyfile}"

API_PORTS=(3011 3012 3013)
API_DB_POOL_MAX="${WORKTIME_API_DB_POOL_MAX:-16}"
WORKER_DB_POOL_MAX="${WORKTIME_WORKER_DB_POOL_MAX:-6}"
APPROVAL_BATCH_SIZE="${APPROVAL_BATCH_SIZE:-50}"

mkdir -p "$LOG_DIR"

read_root_env() {
  local key="$1"
  local value
  value="$(awk -F= -v target="$key" '
    $1 == target {
      value = substr($0, index($0, "=") + 1)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", value)
      if ((substr(value, 1, 1) == "\"" && substr(value, length(value), 1) == "\"") ||
          (substr(value, 1, 1) == "\047" && substr(value, length(value), 1) == "\047")) {
        value = substr(value, 2, length(value) - 2)
      }
      print value
      exit
    }
  ' "$REPO_DIR/.env" 2>/dev/null || true)"
  printf '%s' "$value"
}

BASE_PATH="${BASE_PATH:-$(read_root_env BASE_PATH)}"
BASE_PATH="${BASE_PATH%/}"
if [[ -n "$BASE_PATH" && "$BASE_PATH" != /* ]]; then
  echo "BASE_PATH 必须为空或以 / 开头：$BASE_PATH" >&2
  exit 1
fi
HEALTH_PATH="${BASE_PATH}/api/health"
CADDY_LB_COOKIE_SECRET="${CADDY_LB_COOKIE_SECRET:-$(read_root_env CADDY_LB_COOKIE_SECRET)}"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "缺少命令：$1" >&2
    exit 1
  }
}

pid_command() {
  local pid="$1"
  tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || true
}

stop_pid_file() {
  local file="$1"
  local expected="$2"
  [[ -f "$file" ]] || return 0

  local pid command
  pid="$(cat "$file" 2>/dev/null || true)"
  if [[ ! "$pid" =~ ^[0-9]+$ ]]; then
    echo "忽略无效 PID 文件：$file"
    rm -f "$file"
    return 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$file"
    return 0
  fi

  command="$(pid_command "$pid")"
  if [[ "$command" != *"$expected"* ]]; then
    echo "PID $pid 与预期进程不符，不自动停止：$command" >&2
    rm -f "$file"
    return 1
  fi

  echo "停止 PID $pid：$expected"
  kill "$pid"
  for _ in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "进程未在 5 秒内退出：$pid" >&2
    return 1
  fi
  rm -f "$file"
}

assert_port_free() {
  local port="$1"
  if ss -ltn 2>/dev/null | awk -v suffix=":$port" '$4 ~ suffix "$" { found=1 } END { exit !found }'; then
    echo "端口 $port 已被占用，请先停止对应服务" >&2
    ss -ltnp 2>/dev/null | awk -v suffix=":$port" '$4 ~ suffix "$"'
    exit 1
  fi
}

wait_for_health() {
  local port="$1"
  for _ in $(seq 1 60); do
    if curl --noproxy '*' -fsS "http://127.0.0.1:$port$HEALTH_PATH" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "端口 $port 未在 30 秒内通过健康检查：$HEALTH_PATH" >&2
  return 1
}

build_stack() {
  require_command npm
  echo "构建前端…"
  (cd "$REPO_DIR" && npm run build)
  echo "构建服务端…"
  (cd "$SERVER_DIR" && npm run build)
}

start_api() {
  local port="$1"
  local pid_file="$RUNTIME_DIR/api-$port.pid"
  local log_file="$LOG_DIR/api-$port.log"
  (
    cd "$SERVER_DIR"
    nohup env PORT="$port" NODE_ENV=production APPROVAL_WORKER=0 \
      DB_POOL_MAX="$API_DB_POOL_MAX" \
      node dist/app.js >"$log_file" 2>&1 </dev/null &
    echo $! >"$pid_file"
  )
}

start_worker() {
  (
    cd "$SERVER_DIR"
    nohup env NODE_ENV=production DB_POOL_MAX="$WORKER_DB_POOL_MAX" \
      APPROVAL_BATCH_SIZE="$APPROVAL_BATCH_SIZE" \
      node dist/approvalWorker.js >"$LOG_DIR/worker.log" 2>&1 </dev/null &
    echo $! >"$RUNTIME_DIR/worker.pid"
  )
}

start_caddy() {
  (
    cd "$REPO_DIR"
    nohup env CADDY_LB_COOKIE_SECRET="$CADDY_LB_COOKIE_SECRET" \
      caddy run --config "$CADDY_CONFIG" --adapter caddyfile \
      >"$LOG_DIR/caddy.log" 2>&1 </dev/null &
    echo $! >"$RUNTIME_DIR/caddy.pid"
  )
}

start_stack() {
  require_command node
  require_command caddy
  require_command curl
  require_command ss
  if [[ -z "$CADDY_LB_COOKIE_SECRET" ]]; then
    CADDY_LB_COOKIE_SECRET="$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")"
  fi
  [[ -f "$SERVER_DIR/dist/app.js" ]] || {
    echo "服务端尚未构建，请先执行：bash server/scripts/production-stack.sh build" >&2
    exit 1
  }
  [[ -f "$SERVER_DIR/dist/approvalWorker.js" ]] || {
    echo "审批 Worker 尚未构建，请先执行 build" >&2
    exit 1
  }
  [[ -f "$REPO_DIR/client/dist/index.html" ]] || {
    echo "前端尚未构建，请先执行 build" >&2
    exit 1
  }

  env CADDY_LB_COOKIE_SECRET="$CADDY_LB_COOKIE_SECRET" \
    caddy validate --config "$CADDY_CONFIG" --adapter caddyfile >/dev/null
  for port in "${API_PORTS[@]}" 3000; do
    assert_port_free "$port"
  done

  trap 'trap - ERR; echo "启动失败，清理本次启动的进程" >&2; stop_stack' ERR
  for port in "${API_PORTS[@]}"; do
    start_api "$port"
  done
  for port in "${API_PORTS[@]}"; do
    wait_for_health "$port"
  done

  start_worker
  start_caddy
  wait_for_health 3000
  trap - ERR
  echo "生产栈已启动：Caddy 127.0.0.1:3000 → API 3011/3012/3013，独立审批 Worker 已启动"
}

stop_stack() {
  local failed=0
  stop_pid_file "$RUNTIME_DIR/caddy.pid" 'caddy run' || failed=1
  stop_pid_file "$RUNTIME_DIR/worker.pid" 'dist/approvalWorker.js' || failed=1
  for port in "${API_PORTS[@]}"; do
    stop_pid_file "$RUNTIME_DIR/api-$port.pid" 'dist/app.js' || failed=1
  done
  (( failed == 0 )) || return 1
  echo "生产栈已停止"
}

show_process() {
  local label="$1"
  local file="$2"
  local health_port="${3:-}"
  local pid=''
  [[ -f "$file" ]] && pid="$(cat "$file" 2>/dev/null || true)"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    printf '%-12s RUNNING pid=%s' "$label" "$pid"
    if [[ -n "$health_port" ]] && curl --noproxy '*' -fsS --max-time 2 \
      "http://127.0.0.1:$health_port$HEALTH_PATH" >/dev/null 2>&1; then
      printf ' health=ok'
    fi
    printf '\n'
  else
    printf '%-12s STOPPED\n' "$label"
  fi
}

status_stack() {
  for port in "${API_PORTS[@]}"; do
    show_process "api-$port" "$RUNTIME_DIR/api-$port.pid" "$port"
  done
  show_process worker "$RUNTIME_DIR/worker.pid"
  show_process caddy "$RUNTIME_DIR/caddy.pid" 3000
}

show_logs() {
  local target="${1:-}"
  if [[ -n "$target" ]]; then
    local file="$LOG_DIR/$target.log"
    [[ -f "$file" ]] || { echo "日志不存在：$file" >&2; exit 1; }
    tail -f "$file"
  else
    tail -f "$LOG_DIR"/*.log
  fi
}

case "${1:-}" in
  build)
    build_stack
    ;;
  start)
    start_stack
    ;;
  stop)
    stop_stack
    ;;
  restart)
    stop_stack
    start_stack
    ;;
  status)
    status_stack
    ;;
  logs)
    show_logs "${2:-}"
    ;;
  *)
    echo "用法：$0 {build|start|stop|restart|status|logs [名称]}" >&2
    exit 1
    ;;
esac
