#!/usr/bin/env bash
# perf-probe ファイル境界スケーリング測定
#
# 同じ baseline-N10 相当のファイルを M=1/5/10/25/47 ファイル並べて連結実行し、
# bun runner 自体に「ファイル数 × ファイル数」の overhead があるか確認する。
# 47 は manager/ の `*.test.ts` ファイル数と合わせる。
#
# 使い方: cd skills/cmux-team/manager && bash perf-probe/measure-many-files.sh <out-dir>

set -uo pipefail

OUT="${1:?out-dir is required}"
mkdir -p "$OUT"
LOG_DIR="$OUT/raw-logs"
mkdir -p "$LOG_DIR"

MANY_DIR="perf-probe/many"
mkdir -p "$MANY_DIR"
rm -f "$MANY_DIR"/*.probe.ts

# 47 ファイルまで生成 (2 桁 zero-pad で固定)
for i in $(seq 1 47); do
  idx=$(printf "%02d" "$i")
  cat <<EOF > "$MANY_DIR/many-${idx}.probe.ts"
// AUTO-GENERATED — many-${idx}
import { test, expect } from "bun:test";
$(for j in $(seq 1 10); do echo "test(\"many-${idx}-${j}\", () => { expect(1).toBe(1); });"; done)
EOF
done

MANY_TSV="$OUT/many-files.tsv"
echo -e "M_files\twall_ms\tbun_summary" > "$MANY_TSV"

run_many() {
  local m="$1"
  local files=()
  for i in $(seq 1 "$m"); do
    local idx
    idx=$(printf "%02d" "$i")
    files+=("./$MANY_DIR/many-${idx}.probe.ts")
  done
  local log="$LOG_DIR/many-M${m}.log"
  echo "==> M=${m}" >&2
  local start end ec summary
  start=$(gdate +%s%3N)
  gtimeout --kill-after=10 300 bun test --reporter=dots --timeout 10000 "${files[@]}" > "$log" 2>&1
  ec=$?
  end=$(gdate +%s%3N)
  local wall=$((end - start))
  summary=$(grep -E "^Ran [0-9]+ test" "$log" | tail -1 | tr '\n' ' ' | sed 's/[[:space:]]*$//')
  if [ -z "$summary" ]; then
    summary="(no summary; ec=$ec)"
  fi
  echo -e "${m}\t${wall}\t${summary}" >> "$MANY_TSV"
}

for m in 1 5 10 25 47; do
  run_many "$m"
done

# 念のため 47 ファイル × 各 N=20 でもう少し負荷を上げて見る
# (N=20 にすれば本物テストの 1300 tests に近づく → 47 * 20 = 940 tests)
MANY_DIR2="perf-probe/many20"
mkdir -p "$MANY_DIR2"
rm -f "$MANY_DIR2"/*.probe.ts
for i in $(seq 1 47); do
  idx=$(printf "%02d" "$i")
  cat <<EOF > "$MANY_DIR2/many-${idx}.probe.ts"
// AUTO-GENERATED — many20-${idx}
import { test, expect } from "bun:test";
$(for j in $(seq 1 20); do echo "test(\"many20-${idx}-${j}\", () => { expect(1).toBe(1); });"; done)
EOF
done

run_many2() {
  local m="$1"
  local files=()
  for i in $(seq 1 "$m"); do
    local idx
    idx=$(printf "%02d" "$i")
    files+=("./$MANY_DIR2/many-${idx}.probe.ts")
  done
  local log="$LOG_DIR/many20-M${m}.log"
  echo "==> M20=${m}" >&2
  local start end ec summary
  start=$(gdate +%s%3N)
  gtimeout --kill-after=10 300 bun test --reporter=dots --timeout 10000 "${files[@]}" > "$log" 2>&1
  ec=$?
  end=$(gdate +%s%3N)
  local wall=$((end - start))
  summary=$(grep -E "^Ran [0-9]+ test" "$log" | tail -1 | tr '\n' ' ' | sed 's/[[:space:]]*$//')
  if [ -z "$summary" ]; then
    summary="(no summary; ec=$ec)"
  fi
  echo -e "M20-${m}\t${wall}\t${summary}" >> "$MANY_TSV"
}
for m in 1 5 10 25 47; do
  run_many2 "$m"
done

echo "DONE."
