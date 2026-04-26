#!/usr/bin/env bash
# perf-probe 追加測定: listener 系軸 + cross-file 累積実験
#
# 使い方: cd skills/cmux-team/manager && bash perf-probe/measure-extra.sh <out-dir>

set -uo pipefail

OUT="${1:?out-dir is required}"
mkdir -p "$OUT"
LOG_DIR="$OUT/raw-logs"
mkdir -p "$LOG_DIR"

EXTRA_TSV="$OUT/extra.tsv"
echo -e "label\twall_ms\tbun_summary" > "$EXTRA_TSV"

run_one() {
  local label="$1"
  shift
  local files=("$@")
  local log="$LOG_DIR/extra-${label}.log"
  echo "==> ${label}" >&2
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
  echo -e "${label}\t${wall}\t${summary}" >> "$EXTRA_TSV"
}

# listener 系の単独
for n in 10 50 200; do
  run_one "single-listener-leak-N${n}" "./perf-probe/eventbus-listener-leak-N${n}.probe.ts"
done
for n in 10 50 200; do
  run_one "single-listener-emit-N${n}" "./perf-probe/eventbus-listener-emit-N${n}.probe.ts"
done

# 連結: 8 軸 × N=200 全部
ALL200=()
for axis in baseline eventbus eventbus-emit eventbus-listener-leak eventbus-listener-emit sqlite-close sqlite-leak spawn; do
  ALL200+=("./perf-probe/${axis}-N200.probe.ts")
done
run_one "all8-N200" "${ALL200[@]}"

# 連結: listener-leak と listener-emit を N=200 で 2 ファイル並べる
run_one "listener-leak-then-emit-N200" \
  "./perf-probe/eventbus-listener-leak-N200.probe.ts" \
  "./perf-probe/eventbus-listener-emit-N200.probe.ts"

# 累積効果テスト: listener-emit-N200 を同じファイルで 1 ファイルだけ走らせる vs
# listener-leak-N200 で listener を貯めた直後に listener-emit-N200 を走らせる差。
# 既に上で取れているので不要。

# cross-file 累積: listener-emit を 4 ファイル連結 (N=200 を 4 連)
# 同じ N=200 ファイルを 4 度指定すると bun は 1 度しか読まない（substring + path 重複は重複なし）
# のでファイルを 4 種類用意したい → 別軸 4 種を全部 listener-emit にする手もあるが、
# generate の変更は最小限にして N=10/50/200 を連結する形を取る。
run_one "listener-emit-N10+50+200" \
  "./perf-probe/eventbus-listener-emit-N10.probe.ts" \
  "./perf-probe/eventbus-listener-emit-N50.probe.ts" \
  "./perf-probe/eventbus-listener-emit-N200.probe.ts"

run_one "listener-leak-N10+50+200" \
  "./perf-probe/eventbus-listener-leak-N10.probe.ts" \
  "./perf-probe/eventbus-listener-leak-N50.probe.ts" \
  "./perf-probe/eventbus-listener-leak-N200.probe.ts"

echo "DONE."
