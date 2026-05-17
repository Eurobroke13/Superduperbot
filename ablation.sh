#!/usr/bin/env bash
# Signal ablation script — runs backtest once per signal with that signal disabled,
# then compares PnL/WR/Sharpe/profit-factor against the baseline.
#
# Usage:
#   chmod +x ablation.sh
#   ./ablation.sh              # full run (slow — ~40 backtests)
#   ./ablation.sh --months 3   # shorter lookback for speed
#
# Results saved to ablation-results.csv. Sort by pnl_delta ascending to find
# removal candidates (signals whose removal doesn't hurt metrics).

MONTHS="${MONTHS:-6}"
if [[ "$*" == *"--months"* ]]; then
  MONTHS=$(echo "$*" | grep -oP '(?<=--months )\d+')
fi

OUTFILE="ablation-results.csv"
BASELINE_FILE=".ablation-baseline.txt"

# All scoreable signals (context-only signals like "volume", "in-HVN" are excluded
# because they don't go through the add() path and can't be disabled individually)
SIGNALS=(
  "ema-ribbon-bull"
  "ema-ribbon-bear"
  "h4-bull"
  "h4-bull-pb"
  "h4-bear"
  "h4-bear-strong"
  "h4-bear-pb"
  "rsi-bull-div"
  "rsi-bear-div"
  "OBV-bull-div"
  "OBV-bear-div"
  "liquidity-bull"
  "trap-bull-confirm"
  "trap-bear-confirm"
  "trap-vol-bull"
  "macd-cross-up"
  "macd-cross-down"
  "stochrsi-oversold"
  "stochrsi-overbought"
  "stochrsi-cross-up"
  "stochrsi-cross-down"
  "TK-bull"
  "TK-bear"
  "above-cloud"
  "below-cloud"
  "chikou-bull"
  "chikou-bear"
  "fisher-oversold"
  "fisher-overbought"
  "above-VWAP"
  "below-VWAP"
  "ribbon-expansion-bull"
  "ribbon-expansion-bear"
  "ribbon-h4-align-bull"
  "ribbon-h4-align-bear"
  "rsi-support-bounce"
  "rsi-resistance-reject"
  "rsi-oversold"
  "rsi-overbought"
  "bb-oversold"
  "bb-overbought"
)

extract_metrics() {
  local output="$1"
  local pnl wr sharpe pf trades
  pnl=$(echo "$output"    | grep -oP 'Total PnL[:\s]+\K[-\d.]+' | head -1)
  wr=$(echo "$output"     | grep -oP 'Win Rate[:\s]+\K[\d.]+' | head -1)
  sharpe=$(echo "$output" | grep -oP 'Sharpe[:\s]+\K[-\d.]+' | head -1)
  pf=$(echo "$output"     | grep -oP 'Profit Factor[:\s]+\K[-\d.]+' | head -1)
  trades=$(echo "$output" | grep -oP 'Total Trades[:\s]+\K\d+' | head -1)
  echo "${pnl:-N/A},${wr:-N/A},${sharpe:-N/A},${pf:-N/A},${trades:-N/A}"
}

echo "Running baseline backtest (--months $MONTHS)..."
BASELINE_OUT=$(node backtest.js --no-db --months "$MONTHS" 2>/dev/null)
BASELINE_METRICS=$(extract_metrics "$BASELINE_OUT")
echo "$BASELINE_METRICS" > "$BASELINE_FILE"
echo "Baseline: $BASELINE_METRICS"

echo "signal,pnl,win_rate,sharpe,profit_factor,trades,pnl_delta,wr_delta" > "$OUTFILE"

BASE_PNL=$(cut -d',' -f1 "$BASELINE_FILE")
BASE_WR=$(cut -d',' -f2 "$BASELINE_FILE")

for sig in "${SIGNALS[@]}"; do
  echo -n "  Testing without: $sig ... "
  OUT=$(DISABLE_SIGNAL="$sig" node backtest.js --no-db --months "$MONTHS" 2>/dev/null)
  METRICS=$(extract_metrics "$OUT")
  SIG_PNL=$(echo "$METRICS" | cut -d',' -f1)
  SIG_WR=$(echo "$METRICS"  | cut -d',' -f2)

  PNL_DELTA="N/A"
  WR_DELTA="N/A"
  if [[ "$BASE_PNL" != "N/A" && "$SIG_PNL" != "N/A" ]]; then
    PNL_DELTA=$(awk "BEGIN {printf \"%.2f\", $SIG_PNL - $BASE_PNL}")
  fi
  if [[ "$BASE_WR" != "N/A" && "$SIG_WR" != "N/A" ]]; then
    WR_DELTA=$(awk "BEGIN {printf \"%.2f\", $SIG_WR - $BASE_WR}")
  fi

  echo "$sig,$METRICS,$PNL_DELTA,$WR_DELTA" >> "$OUTFILE"
  echo "pnl_delta=$PNL_DELTA wr_delta=$WR_DELTA"
done

echo ""
echo "Done. Results in $OUTFILE"
echo "Removal candidates (pnl_delta >= 0, meaning removal doesn't hurt):"
awk -F',' 'NR>1 && $7 != "N/A" && $7+0 >= 0 {print $1, "pnl_delta="$7, "wr_delta="$8}' "$OUTFILE" | sort -t= -k2 -rn
