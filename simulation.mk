# ─────────────────────────────────────────────────────────────────────
# Monte Carlo RTP Simulation
# ─────────────────────────────────────────────────────────────────────
#
# Usage:  make -f simulation.mk <target>
#
# CLI Parameters:
#   --trials, -n <N>          跑幾次獨立試驗，越多 CI 越窄               (default: 100)
#   --coins <N>               每次試驗玩家投入硬幣數（不含 warmup/bonus）  (default: 200)
#   --interval <ticks>        每隔幾 tick 投一枚幣（60=2s @30Hz）         (default: 60)
#   --warmup <N>              試驗前 hex-packed 預填平台的硬幣數           (default: 80)
#   --settle <ticks>          warmup 後讓物理穩定的 tick 數（300=10s）     (default: 300)
#   --abilities <spec>        技能：all / none / 逗號分隔                  (default: none)
#                             可選: tornado,explosion,lightning,shock,superPush
#   --ability-interval <t>    每隔幾 tick 隨機發動一次技能（150=5s）       (default: 150)
#   --max-bonus-depth <N>     bonus 幣遞迴觸發 slot 的深度上限            (default: 5)
#   --drain-timeout <ticks>   投完幣後最多再等幾 tick 讓幣落下（3000=100s）(default: 3000)
#
# Output:
#   進度/摘要 → stderr    JSON 報告 → stdout
# ─────────────────────────────────────────────────────────────────────

SIM_CMD := cd game/server && pnpm exec tsx src/simulation/run.ts

# ── Baseline (no abilities) ──────────────────────────────────────────

## 基準測試：100 trials, 200 coins, 無技能
sim-baseline:
	$(SIM_CMD) --trials 100 --coins 200

## 快速冒煙測試（3 trials）
sim-smoke:
	$(SIM_CMD) --trials 3 --coins 50 --warmup 30 --settle 100

## 投入大量硬幣測試, all skills, warmup 300, settle 300
sim-many-coins-all-skills:
	$(SIM_CMD) --trials 3 --coins 1000 --abilities all --warmup 300 --settle 300

## 大量測試：500 trials（需要較長時間）
sim-large:
	$(SIM_CMD) --trials 500 --coins 200

# ── With abilities ───────────────────────────────────────────────────

## 全技能測試
sim-abilities-all:
	$(SIM_CMD) --trials 100 --coins 200 --abilities all

## 只測 tornado + superPush
sim-abilities-push:
	$(SIM_CMD) --trials 100 --coins 200 --abilities tornado,superPush

## 只測 explosion + lightning
sim-abilities-blast:
	$(SIM_CMD) --trials 100 --coins 200 --abilities explosion,lightning

# ── Comparison (baseline vs all abilities) ───────────────────────────

## 跑 baseline + all abilities 比較，結果存到 results/
sim-compare:
	@mkdir -p results
	@echo "▶ Running baseline..."
	$(SIM_CMD) --trials 100 --coins 200 > results/baseline.json 2> results/baseline.log
	@echo "▶ Running with all abilities..."
	$(SIM_CMD) --trials 100 --coins 200 --abilities all > results/abilities.json 2> results/abilities.log
	@echo ""
	@echo "── Baseline ──"
	@grep "RTP:" results/baseline.log
	@echo "── All Abilities ──"
	@grep "RTP:" results/abilities.log
	@echo ""
	@echo "JSON reports saved to results/"

# ── Custom ───────────────────────────────────────────────────────────

## 自訂參數範例（可用環境變數覆蓋）
TRIALS   ?= 100
COINS    ?= 200
WARMUP   ?= 80
SETTLE   ?= 300
ABILITIES ?= none

sim-custom:
	$(SIM_CMD) --trials $(TRIALS) --coins $(COINS) --warmup $(WARMUP) --settle $(SETTLE) --abilities $(ABILITIES)

# ── Help ─────────────────────────────────────────────────────────────

sim-help:
	$(SIM_CMD) --help

.PHONY: sim-baseline sim-smoke sim-large sim-abilities-all sim-abilities-push sim-abilities-blast sim-compare sim-custom sim-help
