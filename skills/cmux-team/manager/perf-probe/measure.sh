#!/usr/bin/env bash
# perf-probe 測定スクリプト
#
# 使い方: cd skills/cmux-team/manager && bash perf-probe/measure.sh <out-dir>
#
# - 各 .probe.ts を単独で実行し ms 単位で計測
# - 6 軸 × N=50 の連結実行を計測
# - 6 軸 × N=10 / N=200 の連結実行も計測
# - 結果は <out-dir>/single.tsv（軸 / N / wall_ms / bun_summary）と
#   <out-dir>/concat.tsv に書き出す

set -uo pipefail

OUT="${1:?out-dir is required}"
mkdir -p "$OUT"

LOG_DIR="$OUT/raw-logs"
mkdir -p "$LOG_DIR"

SINGLE_TSV="$OUT/single.tsv"
CONCAT_TSV="$OUT/concat.tsv"

echo -e "axis\tN\twall_ms\tbun_summary" > "$SINGLE_TSV"
echo -e "label\twall_ms\tbun_summary" > "$CONCAT_TSV"

AXES=(baseline eventbus eventbus-emit sqlite-close sqlite-leak spawn)
SIZES=(10 50 200)

run_single() {
  local axis="$1"
  local n="$2"
  local file="perf-probe/${axis}-N${n}.probe.ts"
  local log="$LOG_DIR/single-${axis}-N${n}.log"
  echo "==> single ${axis} N=${n}" >&2
  local start end ec summary
  start=$(gdate +%s%3N)
  gtimeout --kill-after=5 60 bun test --reporter=dots --timeout 10000 "./${file}" > "$log" 2>&1
  ec=$?
  end=$(gdate +%s%3N)
  local wall=$((end - start))
  summary=$(grep -E "^Ran [0-9]+ test" "$log" | tail -1 | tr '\n' ' ' | sed 's/[[:space:]]*$//')
  if [ -z "$summary" ]; then
    summary="(no summary line; ec=$ec)"
  fi
  echo -e "${axis}\t${n}\t${wall}\t${summary}" >> "$SINGLE_TSV"
}

run_concat() {
  local label="$1"
  shift
  local files=("$@")
  local log="$LOG_DIR/concat-${label}.log"
  echo "==> concat ${label} (${#files[@]} files)" >&2
  local start end ec summary
  start=$(gdate +%s%3N)
  gtimeout --kill-after=10 300 bun test --reporter=dots --timeout 10000 "${files[@]}" > "$log" 2>&1
  ec=$?
  end=$(gdate +%s%3N)
  local wall=$((end - start))
  summary=$(grep -E "^Ran [0-9]+ test" "$log" | tail -1 | tr '\n' ' ' | sed 's/[[:space:]]*$//')
  if [ -z "$summary" ]; then
    summary="(no summary line; ec=$ec)"
  fi
  echo -e "${label}\t${wall}\t${summary}" >> "$CONCAT_TSV"
}

echo "## single runs"
for axis in "${AXES[@]}"; do
  for n in "${SIZES[@]}"; do
    run_single "$axis" "$n"
  done
done

echo "## concat runs"
for n in "${SIZES[@]}"; do
  files=()
  for axis in "${AXES[@]}"; do
    files+=("./perf-probe/${axis}-N${n}.probe.ts")
  done
  run_concat "all-N${n}" "${files[@]}"
done

# 個別仮説の追加: 同じ軸を N=50 で 6 ファイル連結したら？ (重複読み込みではないが、
# 軸内累積が線形か超線形か見たい)
for axis in "${AXES[@]}"; do
  files=("./perf-probe/${axis}-N10.probe.ts" "./perf-probe/${axis}-N50.probe.ts" "./perf-probe/${axis}-N200.probe.ts")
  run_concat "${axis}-N10+50+200" "${files[@]}"
done

echo "DONE. results in $OUT"
