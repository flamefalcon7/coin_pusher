---
module: game-client
date: 2026-07-03
problem_type: ui_bug
component: sponsor-ads
tags:
  - sponsor
  - billboard
  - babylonjs
  - createplane
  - backface-culling
  - dynamictexture
  - inverty
  - camera-fov
  - never-verified-visually
root_cause: three_stacked_rendering_bugs_feature_never_eyeballed
resolution_type: code_fix
related_components:
  - SponsorAdPlacements
  - ToonMaterial
  - StaticMeshes
---

# Sponsor ad billboard never rendered — three stacked client bugs

## Symptoms

- Sponsor campaigns created via API produced sponsor coins and bonus drops, but **no 3D ad
  billboard ever appeared** on the back wall (primary tier), side walls, or platform.
- No console errors, no failed network requests once creatives loaded — the feature failed
  silently. The ad image was fetched with HTTP 200 and a texture was created; nothing showed.
- The feature shipped in v1 (2026-03-29) and was never seen working. Nobody noticed because
  the backend also never populates `placement_tier` (see Watch items), so the render branch
  never executed in normal operation either.

## Root-cause chain (three independent bugs, all required fixing)

1. **Plane positioned outside the wall (and outside the camera frustum).**
   `SponsorAdPlacements.createBackWallAd` placed the plane at local `y = 1.4` on
   `backWallGroup`. The back wall box is 2 m tall and **centered on the group origin**
   (`SCENE_CONFIG.BACK_WALL: HEIGHT 2, POSITION.y 0.5`), so the wall's top edge is local
   `+1.0`. The billboard floated 0.4 m above the wall, above the camera's view.
   → Fixed: `y = 0.7` (plane is 0.5 m tall; top lands at +0.95, just under the wall top).

2. **Plane backface-culled — it faces away from the camera.**
   BabylonJS `CreatePlane` front face looks toward **−Z**: v6.49
   `planeBuilder.js` `CreatePlaneVertexData` pushes `normals.push(0, 0, -1.0)` for every
   vertex (read from `node_modules/.pnpm/@babylonjs+core@6.49.0/.../Builders/planeBuilder.js`
   per D-002 house rule). The camera sits at +Z looking toward −Z, so it sees the culled back
   face. Even at a correct position the plane was invisible.
   → Fixed: `plane.rotation.y = Math.PI`.

3. **Creative orientation: upside down + mirrored.**
   Two compounding effects once the plane became visible:
   - `dt.update(false)` — the first argument of `DynamicTexture.update()` is `invertY`.
     Passing `false` skips the canvas(Y-down)→GL(Y-up) flip, so the creative renders
     **vertically flipped**.
   - The 180° Y-rotation from fix 2 **mirrors the texture horizontally**.
   → Fixed: draw the creative pre-mirrored into the DynamicTexture
   (`ctx.translate(256,0); ctx.scale(-1,1); drawImage(...)`) and call `dt.update(true)`.

### Misdiagnosis worth recording

Attempting to cancel the horizontal mirror with `plane.scaling.x = -1` (on top of
`rotation.y = π`) did **not** produce an upright image — Babylon's negative-determinant
handling flips winding/culling and the net result was a 180°-rotated creative. UV-space
compensation (mirrored canvas draw) is the reliable fix; avoid transform gymnastics.

## Diagnostics that worked

- **Contrast probe:** set the placeholder material to saturated magenta. Placeholder
  invisible → position/culling problem, not texture pipeline. After each fix the probe
  showed exactly which layer was still broken (magenta visible → texture mirrored →
  upside down).
- **Read the library source, not docs** (D-002): the `(0,0,-1)` normals and the
  `update(invertY)` signature were both confirmed directly in the pinned
  `@babylonjs/core@6.49` source.
- **MutationObserver probe** for the bonus-drop banner (3 s auto-dismiss makes
  screenshot-based verification racy):
  `new MutationObserver(...)` on `document.body` recording added nodes, then trigger the
  event. Confirmed the banner fires even when screenshots keep missing it.
- **Manual NATS injection** to drive the whole flow without backend schedulers
  (none exist yet):
  ```bash
  docker run --rm --network coin_pusher_coin-pusher-network natsio/nats-box:latest \
    nats pub -s nats://nats:4222 game.main.sponsor_config \
    '{"op":"sponsor_config","sponsors":[{"id":"<campaign-uuid>","brand_name":"...","token_symbol":"...","brand_color":"#FF6B35","logo_url":"http://localhost:4000/uploads/sponsors/<id>/<file>.png","ad_image_url":"http://localhost:4000/uploads/sponsors/<id>/<file>.png","placement_tier":"primary"}]}'
  # quota (1 coin/~5 s):    game.main.cmd.sponsor_quota  {"quota_id":"<uuid>","sponsor_id":"<uuid>","coin_count":30}
  # bonus drop:             game.main.cmd.sponsor_bonus  {"op":"bonus_drop","sponsor_id":"<uuid>","sponsor_name":"...","token_symbol":"...","coin_count":20}
  ```

## Why it was never caught

The backend never sends `placement_tier` (not in the on-connect `sponsor_config` from
`ws/handler.go`, not settable via the create API), and the client renders a billboard **only**
when the tier matches — so in any real environment the buggy code path never ran. The feature
was verified by "compiles + coins spawn", never by eyeballing the billboard. This is exactly
the failure class the GPU smoke-screenshot ritual (docs/solutions/workflow/) exists for:
**a plane can exist, be enabled, and still be unseeable (out of frustum / backface / alpha).**

## Watch items (found during acceptance, not yet fixed)

- **Side-wall (`secondary`) and platform (`tertiary`) planes very likely have the same
  facing/orientation bugs** — untested; verify with the magenta-placeholder probe before
  selling those tiers.
- **`placement_tier` is never populated by the backend** — no tier column, no assignment
  logic; the relay passes it through if present, which is how acceptance bypassed it.
- **Relative asset URLs break on split origins**: client does `img.src = logo_url` with a
  path like `/uploads/...`, resolved against the *client* origin. Prod is CF Pages (client)
  + droplet (backend) → guaranteed 404. `/uploads` already sends correct CORS headers
  (`Access-Control-Allow-Origin` echo + `Vary: Origin`), so absolute URLs are sufficient.
- **No production trigger path at all**: `IssueQuota`, `PublishQuota`, `PublishConfig`,
  `PublishBonusDrop` have zero callers outside tests. Campaigns silently do nothing without
  an operator/scheduler.
- **Upload dir permissions**: backend container runs as `appuser` with a non-writable
  workdir → `mkdir uploads: permission denied` (HTTP 500) on first upload. The prod
  persistent-volume mount must be writable by `appuser`.
- Bonus-drop banner color is hardcoded `#4ECDC4` in `App.tsx` instead of `msg.brand_color`
  (known v1 limitation, documented in the technical guide).
