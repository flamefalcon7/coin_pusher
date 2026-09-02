---
date: 2026-04-20
topic: stacked-coins-rising-platform
status: abandoned
reviewed: 2026-09-02
outcome: "Never started (no commits, no branch, none of the planned files exist). Dropped by owner 2026-09-02. PLATFORM.TILT_ANGLE premise was already dead config."
---

# Stacked Coins with Rising Platform

## Problem Frame

玩家在推幣機平台上看到高高的硬幣堆疊會產生「想推倒它」的衝動，這是推幣機的核心吸引力之一。但目前在已有硬幣的平台上生成堆疊時，由於平台 2° 前傾和推桿持續擺動，堆疊會立即倒塌，無法達到預期的視覺誘惑效果。

## Requirements

**平台物理調整**
- R1. 移除平台 2° 前傾（`TILT_ANGLE: 2` → `0`），使堆疊能穩定站立
- R2. 評估移除前傾後對正常硬幣流動的影響，必要時調整其他參數（摩擦力、推桿振幅等）補償

**推桿凹槽**
- R3. 推桿中央加入半圓形凹槽，使推桿正常擺動時繞過堆疊位置
- R4. 凹槽使用精確圓弧碰撞（Rapier compound collider，6-8 個 cuboid 沿弧線排列）
- R5. 前端渲染對應的半圓凹槽推桿模型（BabylonJS CSG 或自定義幾何體）
- R6. 凹槽大小需配合堆疊直徑，堆疊不被推桿觸碰但周圍硬幣正常推動

**升降平台**
- R7. 平台表面指定位置（推桿前方中央、凹槽正下方）可升起一塊小平台
- R8. 小平台升起時自然推開周圍的現有硬幣，清出堆疊空間
- R9. 堆疊硬幣在升起的小平台上生成，確保穩定
- R10. 生成完畢後小平台降回主平台表面，堆疊融入主平台

**堆疊硬幣**
- R11. 堆疊由真實物理硬幣組成（非純視覺），被推倒後掉落前緣即算玩家得分
- R12. 堆疊通過事件觸發生成（具體觸發事件待定）

## Success Criteria

- 堆疊在平台上能穩定存在，直到被玩家硬幣或 super push 碰觸才倒塌
- 推桿正常擺動不會碰到堆疊
- 升降平台的升起/降下動畫流暢自然，不會穿模
- 移除前傾後正常遊戲的硬幣流動性不明顯退化
- 凹槽區域的硬幣能透過玩家投幣自然落下，不形成永久死區

## Scope Boundaries

- 不含堆疊觸發事件的具體設計（哪個事件觸發、頻率、獎勵數量等）— 獨立設計
- 不含堆疊硬幣的特殊視覺效果（光效、粒子等）— 可後續加強
- 不修改 super push 機制 — 它可以直接推倒堆疊，這是預期行為

## Key Decisions

- **移除前傾而非降低:** 使用者明確要求移除，需在 planning 階段驗證 0° 是否可行，否則退回 0.5°~1°
- **精確圓弧碰撞:** 使用 compound collider（6-8 cuboid）而非簡單 V 形缺口，運算成本可忽略
- **真實物理硬幣:** 堆疊不是視覺誘餌，推倒即得分，玩家激勵明確
- **升降平台機制:** 比黑洞/傳送門更自然直覺，視覺上合理解釋空間清理

## Dependencies / Assumptions

- Rapier kinematic body 支援 compound collider（已確認支援）
- Rapier trimesh 不支援 kinematic body，因此圓弧必須用 compound 近似
- 現有 `StackSpawner.ts` 已有 tower/pyramid/wall 等堆疊模式可復用

## Outstanding Questions

### Deferred to Planning
- [Affects R2][Needs research] 移除 2° 前傾後，硬幣流動性退化多少？是否需要調整摩擦力或推桿振幅補償？
- [Affects R4][Technical] 圓弧 compound collider 最佳 cuboid 數量和角度排列
- [Affects R6][Technical] 凹槽半徑應該多大？需配合堆疊模式（tower vs pyramid）的底面積
- [Affects R7][Technical] 升降平台的物理實現方式（kinematic body + 動畫曲線）
- [Affects R9][Technical] 堆疊硬幣生成後的穩定性策略（kinematic freeze → 碰觸後轉 dynamic，或純物理自然穩定）

## Next Steps

-> `/ce:plan` 進行結構化實作規劃（觸發事件獨立設計，不阻擋本功能開發）
