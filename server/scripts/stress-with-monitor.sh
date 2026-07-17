#!/usr/bin/env bash
# 压测 + WSL 资源采样一体跑
# 用法:
#   bash scripts/stress-with-monitor.sh submit 100 300
#   bash scripts/stress-with-monitor.sh same-week 100 5
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-submit}"
A="${2:-100}"
B="${3:-300}"
DONE="/tmp/worktime-stress.done"
rm -f "$DONE"

node scripts/monitor-wsl.mjs --until-file "$DONE" 1 &
MON_PID=$!

cleanup() { touch "$DONE" 2>/dev/null || true; wait "$MON_PID" 2>/dev/null || true; }
trap cleanup EXIT

case "$MODE" in
  submit)
    node scripts/stress-timesheet-submit.mjs "$A" "$B"
    ;;
  same-week)
    WEEK_START="${WEEK_START:-2037-01-05}" node scripts/stress-same-week-submit.mjs "$A" "$B"
    ;;
  *)
    echo "未知模式: $MODE (submit|same-week)"
    exit 1
    ;;
esac
