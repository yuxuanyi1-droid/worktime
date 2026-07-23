#!/usr/bin/env bash
# 固定 PostgreSQL 快照下运行一组 Caddy + 多 API + 独立审批 worker 压测。
#
# 用法：
#   bash tests/performance/perf-caddy-case.sh snapshot
#   bash tests/performance/perf-caddy-case.sh run 4 20 200 2000 batch20-c200
#   bash tests/performance/perf-caddy-case.sh restore
#   bash tests/performance/perf-caddy-case.sh stop
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SERVER_DIR="$REPO_DIR/server"
RUNTIME_DIR="${PERF_RUNTIME_DIR:-/tmp/worktime-perf-20260718}"
SNAPSHOT="${PERF_DB_SNAPSHOT:-$RUNTIME_DIR/fixed.dump}"
PG_URL="${PERF_PG_URL:-postgresql://worktime:worktime@127.0.0.1:5432/worktime}"
REDIS_CLI="${PERF_REDIS_CLI:-redis-cli}"
RESULT_CSV="$RUNTIME_DIR/results.csv"
STREAM_KEY="worktime:stream:timesheet-approval"

mkdir -p "$RUNTIME_DIR/logs"

stop_pid_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    local pid
    pid="$(cat "$file" 2>/dev/null || true)"
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
    rm -f "$file"
  fi
}

stop_stack() {
  stop_pid_file "$RUNTIME_DIR/caddy.pid"
  stop_pid_file "$RUNTIME_DIR/worker.pid"
  for port in 3011 3012 3013 3014; do
    stop_pid_file "$RUNTIME_DIR/api-$port.pid"
  done
  sleep 2
}

clear_worktime_redis() {
  "$REDIS_CLI" --raw --scan --pattern 'worktime:*' \
    | xargs -r -n 100 "$REDIS_CLI" del >/dev/null
}

restore_snapshot() {
  [[ -f "$SNAPSHOT" ]] || { echo "快照不存在: $SNAPSHOT" >&2; exit 1; }
  stop_stack
  pg_restore --clean --if-exists --no-owner --exit-on-error --dbname="$PG_URL" "$SNAPSHOT"
  # pg_dump 不包含优化器统计信息；恢复后统一 ANALYZE，确保各组使用可比的查询计划。
  psql "$PG_URL" --quiet --command='ANALYZE;'
  clear_worktime_redis
}

create_snapshot() {
  stop_stack
  pg_dump --format=custom --no-owner --file="$SNAPSHOT" "$PG_URL"
  sha256sum "$SNAPSHOT" | tee "$SNAPSHOT.sha256"
  ls -lh "$SNAPSHOT"
}

start_stack() {
  local api_count="$1"
  local batch_size="$2"
  local gateway="${PERF_GATEWAY:-caddy}"
  local caddy_config="$REPO_DIR/Caddyfile"
  [[ "$api_count" == "4" ]] && caddy_config="$REPO_DIR/Caddyfile.perf-4"

  for ((i = 0; i < api_count; i++)); do
    local port=$((3011 + i))
    (
      cd "$SERVER_DIR"
      nohup env PORT="$port" NODE_ENV=production APPROVAL_WORKER=0 \
        DB_POOL_MAX="${PERF_API_POOL_MAX:-12}" \
        HTTP_SUCCESS_LOG_SAMPLE_RATE=0.01 \
        node dist/app.js >"$RUNTIME_DIR/logs/api-$port.log" 2>&1 </dev/null &
      echo $! >"$RUNTIME_DIR/api-$port.pid"
    )
  done

  if [[ "${PERF_DISABLE_WORKER:-0}" != "1" ]]; then
    (
      cd "$SERVER_DIR"
      nohup env NODE_ENV=production DB_POOL_MAX=6 APPROVAL_BATCH_SIZE="$batch_size" \
        node dist/approvalWorker.js >"$RUNTIME_DIR/logs/worker.log" 2>&1 </dev/null &
      echo $! >"$RUNTIME_DIR/worker.pid"
    )
  fi

  # 主动健康检查不能早于应用启动，否则 Caddy 会在首轮测试开始时临时摘除全部上游。
  for ((i = 0; i < api_count; i++)); do
    local port=$((3011 + i))
    local ready=0
    for _ in $(seq 1 60); do
      if curl --noproxy '*' -fsS "http://127.0.0.1:$port/worktime/api/health" >/dev/null 2>&1; then
        ready=1
        break
      fi
      sleep 0.5
    done
    [[ "$ready" == "1" ]] || { echo "API $port 未在 30 秒内就绪" >&2; exit 1; }
  done

  if [[ "$gateway" == "node" ]]; then
    local backends='127.0.0.1:3011,127.0.0.1:3012,127.0.0.1:3013'
    [[ "$api_count" == "4" ]] && backends="$backends,127.0.0.1:3014"
    (
      cd "$SERVER_DIR"
      nohup env LB_PORT=3001 BACKENDS="$backends" node scripts/lb-round-robin.mjs \
        >"$RUNTIME_DIR/logs/caddy.log" 2>&1 </dev/null &
      echo $! >"$RUNTIME_DIR/caddy.pid"
    )
  else
    (
      cd "$REPO_DIR"
      nohup caddy run --config "$caddy_config" --adapter caddyfile \
        >"$RUNTIME_DIR/logs/caddy.log" 2>&1 </dev/null &
      echo $! >"$RUNTIME_DIR/caddy.pid"
    )
  fi

  for _ in $(seq 1 60); do
    if curl --noproxy '*' -fsS http://127.0.0.1:3001/worktime/api/health >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "服务未在 30 秒内就绪" >&2
  tail -80 "$RUNTIME_DIR/logs"/*.log >&2 || true
  exit 1
}

queue_length() {
  "$REDIS_CLI" xlen "$STREAM_KEY" 2>/dev/null || echo 0
}

wait_queue_drain() {
  if [[ "${PERF_DISABLE_WORKER:-0}" == "1" ]]; then
    echo 0
    return 0
  fi
  local start=$SECONDS
  local remaining
  while (( SECONDS - start < 180 )); do
    remaining="$(queue_length)"
    if [[ "$remaining" == "0" ]]; then
      echo $((SECONDS - start))
      return 0
    fi
    sleep 0.2
  done
  echo 180
}

ensure_csv() {
  if [[ ! -f "$RESULT_CSV" ]]; then
    echo 'label,api_count,batch_size,concurrency,total,throughput_req_s,p50_ms,p95_ms,max_ms,success_count,error_count,error_rate_pct,queue_drain_s' >"$RESULT_CSV"
  fi
}

run_case() {
  local api_count="$1"
  local batch_size="$2"
  local concurrency="$3"
  local total="$4"
  local label="$5"
  local out="$RUNTIME_DIR/logs/result-$label.log"
  local monitor="$RUNTIME_DIR/logs/monitor-$label.csv"

  trap stop_stack EXIT

  restore_snapshot
  start_stack "$api_count" "$batch_size"
  sleep 2

  # 每次 restore 都会产生新的 PostgreSQL relation 文件；先用固定负载预热，
  # 避免第一组数据承担冷缓存和 V8 JIT 成本。预热数据和队列也在每组中完全一致。
  (
    cd "$SERVER_DIR"
    WEEK_OFFSET=390000 node scripts/stress-timesheet-submit.mjs 50 200
  ) >"$RUNTIME_DIR/logs/warmup-$label.log" 2>&1
  wait_queue_drain >/dev/null

  (
    cd "$SERVER_DIR"
    MONITOR_CSV="$monitor" WEEK_OFFSET=400000 \
      bash scripts/stress-with-monitor.sh submit "$concurrency" "$total"
  ) | tee "$out"

  local drain_s throughput p50 p95 max success error_count error_rate
  drain_s="$(wait_queue_drain)"
  throughput="$(awk '/吞吐:/{print $2; exit}' "$out")"
  p50="$(awk '/^  p50/{print $2; exit}' "$out")"
  p95="$(awk '/^  p95/{print $2; exit}' "$out")"
  max="$(awk '/^  max/{print $2; exit}' "$out")"
  success="$(awk '/成功:/{split($2,a,"/"); print a[1]; exit}' "$out")"
  error_count="$(awk '/失败:/{print $2; exit}' "$out")"
  error_rate="$(awk -v e="$error_count" -v n="$total" 'BEGIN { printf "%.2f", n ? e * 100 / n : 0 }')"

  ensure_csv
  echo "$label,$api_count,$batch_size,$concurrency,$total,$throughput,$p50,$p95,$max,$success,$error_count,$error_rate,$drain_s" \
    | tee -a "$RESULT_CSV"
  stop_stack
}

run_matrix() {
  local api_count concurrency total label
  for api_count in 3 4; do
    for concurrency in 100 150 200 250 300; do
      total=$((concurrency * 10))
      label="api${api_count}-c${concurrency}-b50"
      run_case "$api_count" 50 "$concurrency" "$total" "$label" \
        >"$RUNTIME_DIR/logs/driver-$label.log" 2>&1
      tail -1 "$RESULT_CSV"
    done
  done
}

run_three_api_matrix() {
  local concurrency total label
  local api_pool="${PERF_API_POOL_MAX:-12}"
  for concurrency in 100 150 200 250 300; do
    total=$((concurrency * 10))
    label="api3-p${api_pool}-c${concurrency}-b50"
    run_case 3 50 "$concurrency" "$total" "$label" \
      >"$RUNTIME_DIR/logs/driver-$label.log" 2>&1
    tail -1 "$RESULT_CSV"
  done
}

case "${1:-}" in
  snapshot) create_snapshot ;;
  restore) restore_snapshot ;;
  stop) stop_stack ;;
  matrix) run_matrix ;;
  matrix3) run_three_api_matrix ;;
  run)
    [[ $# -eq 6 ]] || { echo "参数: run API数 批量 并发 总数 标签" >&2; exit 1; }
    run_case "$2" "$3" "$4" "$5" "$6"
    ;;
  *) echo "用法: $0 snapshot|restore|stop|run|matrix|matrix3" >&2; exit 1 ;;
esac
