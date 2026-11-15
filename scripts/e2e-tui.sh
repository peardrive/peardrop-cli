#!/usr/bin/env bash
# TUI smoke test: local bootstrapper + `peardrop share` + `peardrop get` in two tmux panes,
# then a byte-for-byte comparison. This exercises the real interface, so it needs tmux and
# a TTY; `npm run e2e` is the headless version that CI uses.
#
#   npm run build && npm run e2e:tui
set -euo pipefail
cd "$(dirname "$0")/.."

PORT=${PEARDROP_E2E_PORT:-49838}
WORK=$(mktemp -d)
SRC="$WORK/src/sample"
OUT="$WORK/out"
PRELOAD=()
[[ "${PEARDROP_E2E_UNFIREWALLED:-1}" == "1" ]] && PRELOAD=(-r ./scripts/e2e-unfirewalled.cjs)

cleanup() {
  tmux kill-session -t pd-e2e-share 2>/dev/null || true
  tmux kill-session -t pd-e2e-get 2>/dev/null || true
  [[ -n "${BOOT_PID:-}" ]] && kill "$BOOT_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$SRC/nested/deeper"
head -c 3000000 /dev/urandom > "$SRC/big.bin"
head -c 700000 /dev/urandom > "$SRC/nested/mid.bin"
echo "hello from peardrop" > "$SRC/nested/deeper/hello.txt"
: > "$SRC/nested/empty.bin"
for i in 1 2 3 4 5; do head -c $((i * 50000)) /dev/urandom > "$SRC/nested/small_$i.bin"; done

node scripts/dev-bootstrap.mjs "$PORT" > "$WORK/boot.log" 2>&1 &
BOOT_PID=$!
sleep 2

CMD="env PEARDROP_HOME=$WORK/home-share node ${PRELOAD[*]} bin/peardrop.mjs share $SRC --bootstrap 127.0.0.1:$PORT"
tmux new-session -d -s pd-e2e-share -x 160 -y 40 "$CMD; sleep 600"

LINK=""
for _ in $(seq 1 60); do
  # the link is wrapped inside the "Sharelink" panel, up to the "run peardrop get" hint line
  LINK=$(tmux capture-pane -p -t pd-e2e-share | awk '/peardrop:\/\//{on=1} /run peardrop get/{on=0} on' | tr -d '│ \n' || true)
  [[ -n "$LINK" ]] && break
  sleep 0.5
done
[[ -z "$LINK" ]] && { echo "no sharelink shown"; tmux capture-pane -p -t pd-e2e-share; exit 1; }
echo "sharelink: $LINK"

CMD="env PEARDROP_HOME=$WORK/home-get node ${PRELOAD[*]} bin/peardrop.mjs get $LINK -o $OUT --bootstrap 127.0.0.1:$PORT"
tmux new-session -d -s pd-e2e-get -x 120 -y 40 "$CMD; sleep 600"

EXPECTED=$(find "$SRC" -type f | wc -l)
for _ in $(seq 1 90); do
  if tmux capture-pane -p -t pd-e2e-get | grep -q "All files received"; then break; fi
  sleep 1
done
tmux capture-pane -p -t pd-e2e-get

FAIL=0
while IFS= read -r file; do
  rel=${file#"$SRC/"}
  if ! cmp -s "$file" "$OUT/sample/$rel"; then echo "MISMATCH $rel"; FAIL=1; fi
done < <(find "$SRC" -type f)

[[ $FAIL == 0 ]] && echo "e2e (tui) OK: $EXPECTED files transferred intact" || { echo "e2e (tui) FAILED"; exit 1; }
