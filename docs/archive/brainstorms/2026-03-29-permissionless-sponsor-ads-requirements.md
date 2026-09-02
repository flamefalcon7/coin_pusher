---
date: 2026-03-29
topic: permissionless-sponsor-ads
status: superseded
reviewed: 2026-09-02
outcome: "Became docs/plans/2026-03-29-003 (partial) and 2026-03-30-001 (completed)."
---

# Permissionless Sponsor Ads

## Problem Frame

The coin pusher game needs a monetization/sponsorship layer. Traditional ad platforms (Google Ad Manager, AdinPlay) are not viable — they restrict Web3/gambling-adjacent content, offer poor fill rates for small sites, and inject low-quality ads that break the toon-shaded aesthetic.

Instead of bolting on external ads, sponsors should become part of the game economy: deposit tokens as reward pools, and earn ad space in return. This aligns sponsor incentives (token distribution) with player incentives (earning diverse rewards).

## Requirements

### Sponsor Onboarding
- R1. Any token with liquidity on a platform-supported chain can be used for sponsorship (permissionless)
- R2. Sponsor deposits tokens into a reward pool via self-serve flow
- R3. Sponsor uploads custom ad creative: image (fixed size) + text/name for ad placements

### In-Game Token Appearance — Mixed Coins
- R4. Sponsor tokens appear as distinct coins on the pusher platform alongside regular coins
- R5. Sponsor coins have unique visual identity: sponsor brand color + logo on coin face (toon-shaded to match aesthetic)
- R6. Sponsor coins are same size as regular coins (0.06m radius), same physics — differentiated only by color + logo
- R7. When sponsor coins are pushed off the front edge, they are distributed as the corresponding sponsor token via the existing heat-based reward system (same distribution logic as regular coins, but the reward is sponsor token instead of play coins)

### In-Game Token Appearance — Bonus Drop Events
- R8. Periodic "Bonus Drop" events rain sponsor tokens from above onto the platform
- R9. Bonus drops have ceremony: announcement banner ("Bonus Drop! Sponsored by [TOKEN]"), VFX rain effect
- R10. Bonus drop frequency and volume are configurable (tied to sponsor deposit size — exact formula deferred)

### Ad Placements — Multi-Tier
- R11. **Back wall (primary)**: Large banner area above pin field — highest visibility, sponsor image + text
- R12. **Side walls (secondary)**: Smaller placements on left/right honeycomb walls
- R13. **Platform surface (tertiary)**: Subtle watermark/logo on play surface, partially occluded by coins
- R14. All placements render sponsor's custom image at fixed dimensions, toon-shaded to match current theme
- R15. Placements update dynamically (no page reload needed) when sponsor rotation changes
- R16. **Mobile/responsive**: No special mobile adaptation for 3D ad placements. On phone portrait (camera pulls back to ~6.5m), back wall ads will be small — acceptable. Primary sponsor exposure on mobile comes from sponsor coins and bonus drop events, which are clearly visible at any camera distance.

### Capacity
- R17. System supports 3-5 simultaneous sponsors. Ad placements rotate or assign by tier among active sponsors.

## Success Criteria
- Sponsor ad placements feel like natural arcade machine decoration, not injected ads
- Sponsor coins are visually distinct but aesthetically consistent with toon shader style
- Bonus drop events create excitement, not annoyance
- Full flow works permissionlessly: deposit token → ads appear → players earn token

## Scope Boundaries
- **Out of scope**: Pricing/allocation mechanism (which sponsor gets which placement tier, rotation logic, deposit-to-exposure formula). Will be designed separately.
- **Out of scope**: On-chain smart contracts for sponsor deposits. Backend API design is in scope; contract design is not.
- **Out of scope**: Sponsor analytics dashboard (impressions, click-through). Future feature.
- **Out of scope**: Content moderation / spam prevention for sponsor creatives. Acknowledge the need, defer solution.
- **Out of scope (v2)**: Slot machine reel integration with sponsor symbols, jackpot wheel sponsor segments. Extend after v1 ad placements are proven.
- **In scope**: Game client rendering, game server sponsor coin mechanics, backend sponsor CRUD API, ad placement system

## Key Decisions
- **Permissionless over curated**: Any token with liquidity qualifies. No manual approval. Rationale: aligns with Web3 ethos, reduces operational overhead.
- **Custom implementation over ad SDK**: No BabylonJS ad SDK exists; traditional platforms reject Web3/gambling. Self-built system gives full creative control.
- **Toon-shader integration**: All sponsor visuals must pass through the existing toon shader pipeline, not be raw textures overlaid on the scene.
- **Dual appearance model**: Both mixed coins (ambient) + bonus drops (event-driven) for maximum flexibility and sponsor value.

## Outstanding Questions

### Deferred to Planning
- [Affects R3][Technical] Determine exact fixed dimensions for sponsor ad images per placement tier (back wall, side walls, platform). Decide based on texture resolution vs. performance tradeoffs in BabylonJS.
- [Affects R10][Needs research] What's the right bonus drop frequency/volume to feel exciting without flooding the platform?
- [Affects R11-R13][Technical] How to render sponsor images as dynamic textures on toon-shaded materials in BabylonJS? (DynamicTexture vs. custom shader approach)
- [Affects R14][Technical] How to theme-adapt sponsor images — apply toon shader post-processing to uploaded PNGs, or require sponsors to upload theme-compatible assets?
- [v2][Technical] How to extend existing slot machine/jackpot wheel systems to include dynamic sponsor symbols?
- [Affects R1][Needs research] How to verify "has liquidity" for a token on supported chains? Which price oracle / DEX API to use?
- [Affects R7][Technical] Token distribution flow: when coin falls off edge, how does the reward attribution work across the existing heat-based distribution system?
- [Affects all][Architecture] Where does sponsor state live — game server, backend Go service, or both? How does sponsor config propagate to active game rooms?

## Next Steps

→ `/ce:plan` for structured implementation planning
