Scene.md

# Scene Spec: Coin Pusher (Rev B)

## 1. Global Scene

- **Coordinate System**: Right-handed (explicitly set `scene.useRightHandedSystem = true`), Y-up, Z-forward
- **Unit**: 1 unit = 1 meter
- **Scene Size**: 3m (width) × 2m (depth) × 2m (height)
- **Lighting**: Hemispheric light（PoC：不開即時陰影/鏡面）
- **Physics**: Rapier (gravity: {x: 0, y: -9.81, z: 0}); **substeps = 2**, solver iters: vel=8, pos=3; sleep 啟用
- **Camera**
  - Type: ArcRotateCamera
  - Target: Center of main platform (0, 0.3, 0)
  - Alpha: -Math.PI / 2
  - Beta: Math.PI / 3
  - Radius: 3（行動裝置限制縮放半徑 2–4）
  - Behavior: Fixed angle, slight rotation allowed; mobile 限制縮放/旋轉範圍

---

## 2. Components

### (1) Coin Slots

| Property    | Description                                         |
| ----------- | --------------------------------------------------- |
| Count       | 3                                                   |
| Position    | Top of backboard, centered horizontally             |
| Coordinates | (-0.4, 1.2, -0.7), (0, 1.2, -0.7), (0.4, 1.2, -0.7) |
| Shape       | Cylindrical hole or funnel（出口帶導角）            |
| Drop Target | Onto backboard slope                                |
| Function    | Player inserts coin; spawns new coin at slot center |

---

### (2) Backboard (斜坡)

| Property | Description                                              |
| -------- | -------------------------------------------------------- |
| Shape    | Plane tilted forward                                     |
| Size     | Width: 1.2m, Height: 0.8m                                |
| Position | Centered at (0, 0.8, -0.5)                               |
| Rotation | 20° forward tilt (x-axis rotation)                       |
| Surface  | Optional pins in staggered grid（間距 ≈ 2.2× coin 直徑） |

---

### (3) Main Platform

| Property | Description                                                      |
| -------- | ---------------------------------------------------------------- |
| Shape    | Flat rectangular box                                             |
| Size     | 1.2m (width) × 0.8m (depth) × 0.05m (thickness)                  |
| Position | (0, 0.25, 0)                                                     |
| Edge     | **Front edge slightly down-tilted by 2–3°** to help coin outflow |
| Material | Diffuse gray                                                     |
| Behavior | Static body                                                      |

---

### (4) Pusher Plate

| Property   | Description                                                             |
| ---------- | ----------------------------------------------------------------------- |
| Shape      | Rectangular slab                                                        |
| Size       | 1.1m (width) × 0.7m (depth) × 0.05m (thickness), **edges with chamfer** |
| Position   | (0, 0.3, 0)                                                             |
| Movement   | **Sinusoidal along z**: `z = amplitude * sin(2π * f * t)`               |
| Parameters | Amplitude = 0.3m, Frequency = 0.5Hz                                     |
| Physics    | **Kinematic body** updated via **setNextKinematicTranslation**          |
| Function   | Pushes coins toward front opening                                       |

---

### (5) Side & Back Walls

| Property  | Description                                                   |
| --------- | ------------------------------------------------------------- |
| Shape     | Thin boxes forming U-shape around platform                    |
| Height    | 0.3m                                                          |
| Thickness | 0.05m                                                         |
| Position  | Left (-0.6, 0.4, 0), Right (0.6, 0.4, 0), Back (0, 0.4, -0.4) |
| Tilt      | **Inner tilt 1–2°** to reduce wall-climb flips                |
| Front     | Open (for Drop Zone)                                          |

---

### (6) Drop Zone

| Property | Description                                                            |
| -------- | ---------------------------------------------------------------------- |
| Position | Front of main platform (z ≈ +0.45)                                     |
| Lip      | **Front lip slightly lower than platform by 2–3mm**                    |
| Size     | 1.0m width × 0.2m depth × 0.1m height                                  |
| Behavior | Coins with y < -0.1m detected as “reward”; server broadcasts `despawn` |
| Function | Collects dropped coins; can trigger event later                        |

---

### (7) Coins

| Property       | Description                                                              |
| -------------- | ------------------------------------------------------------------------ |
| Shape          | Cylinder                                                                 |
| Radius         | 0.02m                                                                    |
| Thickness      | **0.008–0.01m（建議；若 0.005m 則需更嚴格 solver/substeps/CCD）**        |
| Mass           | 0.01kg                                                                   |
| Spawn Position | From selected Coin Slot (x, y, z)                                        |
| Material       | Gold-like (for readability)                                              |
| Physics        | Dynamic; **CCD on during free-fall → off when resting/slow on platform** |

---

## 3. Rendering Notes (Mobile-first)

- **Hemispheric light only**（PoC 無實時陰影/鏡面）
- **Coins 使用 thin instances** 減少 draw calls（物理仍為多剛體）
- HUD/幾何使用低面數網格；相機縮放/旋轉範圍限制以避免暈眩
- 可加簡單 AO/顏色區分以增加可讀性

---

## 4. Physics Interaction Matrix (with indicative coefficients)

| Object A | Object B  | Interaction / Params                                  |
| -------- | --------- | ----------------------------------------------------- |
| Coin     | Coin      | friction 0.25–0.35, restitution 0.15–0.25             |
| Coin     | Pusher    | sliding contact, friction ≈ 0.5                       |
| Coin     | Platform  | resting support, friction ≈ 0.35, restitution 0.1–0.2 |
| Coin     | Wall      | bounce w/ low restitution, prevent outflow            |
| Coin     | Drop Zone | On y < -0.1 ⇒ remove / server `despawn`               |
| Any      | Any       | sleep threshold enabled to reduce solver load         |

---

## 5. Optional Extensions

- Add pins on backboard（staggered grid；間距 ≈ 2.2× coin 直徑）增加隨機性
- 簡易接觸陰影或 blob shadow 作為視覺近似
- Presentation mode：慢速自動環繞相機（desktop），mobile 保持固定角
