# 📊 带宽使用分析和优化指南

## 🔍 当前情况分析

根据你提供的 Droplet 带宽数据：

```
Inbound:  16.5 KB/s  ✅ (合理)
Outbound: 1.21 MB/s  ⚠️ (偏高，需要分析)
```

### 带宽使用评估

#### ✅ Inbound (16.5 KB/s) - **合理**

- 客户端发送的消息：
  - `ping` (每 5 秒): ~0.1 KB
  - `coin_insert` (偶尔): ~0.05 KB
- 单个用户 inbound: **< 1 KB/s**
- 多个用户 inbound: **合理范围**

#### ⚠️ Outbound (1.21 MB/s) - **需要分析**

根据项目配置：

- **Tick Rate**: 30 Hz (每秒 30 次更新)
- **单用户下行**: ~25 KB/s (MessagePack 优化后)
- **预期用户数**: 1.21 MB/s ÷ 25 KB/s ≈ **48 个并发用户**

**可能原因**：

1. **多用户同时在线** ✅ (如果确实有 40-50 个用户)
2. **硬币数量过多** ⚠️ (每个硬币增加 ~28 bytes/update)
3. **消息未压缩** ⚠️ (检查是否使用 MessagePack)
4. **连接未清理** ⚠️ (僵尸连接占用带宽)

---

## 📈 带宽计算

### 单用户带宽消耗

```
每个 state_delta 消息:
├─ Header: ~20 bytes (MessagePack)
├─ 每个硬币: ~28 bytes (pos[3] + rot[4] = 7 floats)
└─ Pusher: ~5 bytes

示例:
├─ 10 硬币: ~20 + (10 × 28) + 5 = 305 bytes
├─ 50 硬币: ~20 + (50 × 28) + 5 = 1,425 bytes
└─ 100 硬币: ~20 + (100 × 28) + 5 = 2,825 bytes

带宽 @ 30Hz:
├─ 10 硬币: 305 × 30 = 9,150 bytes/s ≈ 8.9 KB/s
├─ 50 硬币: 1,425 × 30 = 42,750 bytes/s ≈ 41.7 KB/s
└─ 100 硬币: 2,825 × 30 = 84,750 bytes/s ≈ 82.7 KB/s
```

### 多用户带宽消耗

```
服务器总带宽 = 单用户带宽 × 用户数

当前情况:
├─ Outbound: 1.21 MB/s = 1,240 KB/s
├─ 假设 50 硬币/用户:
│  └─ 41.7 KB/s × 用户数 = 1,240 KB/s
│  └─ 用户数 ≈ 30 用户
├─ 假设 100 硬币/用户:
│  └─ 82.7 KB/s × 用户数 = 1,240 KB/s
│  └─ 用户数 ≈ 15 用户
```

**结论**:

- 如果有 **15-30 个活跃用户**，每个房间有 **50-100 个硬币**，这个带宽是合理的
- 如果只有 **1-5 个用户**，带宽偏高，需要优化

---

## 🐛 Lag 问题诊断

### 可能原因

#### 1. **带宽瓶颈** ⚠️

```
DigitalOcean Droplet 带宽限制:
├─ Basic Plan: 1-2 TB/月 (突发可到 ~500 Mbps)
├─ 当前: 1.21 MB/s ≈ 9.68 Mbps ✅ (远低于限制)
└─ 不是带宽瓶颈

但可能的原因:
├─ 多个 Droplet 共享带宽池
├─ 突发流量限制
└─ 网络延迟高 (距离远)
```

#### 2. **延迟问题** ⚠️

检查项目：

- 浏览器显示 **Ping** 值（HUD 组件）
- 如果 Ping > 100ms，可能导致 lag
- 如果 Ping > 200ms，明显 lag

**优化方案**:

- 使用 **Cloudflare** 代理（降低延迟）
- 选择离用户更近的数据中心

#### 3. **服务器 CPU 负载高** ⚠️

```
物理引擎计算:
├─ 30 Hz tick rate
├─ 50 硬币: ~25% CPU
├─ 100 硬币: ~50% CPU
└─ 200+ 硬币: > 70% CPU ⚠️

检查方法:
ssh 到服务器运行:
  top
  htop

观察:
├─ Node.js 进程 CPU 使用率
└─ 如果 > 70%，是瓶颈
```

#### 4. **硬币数量过多** ⚠️

```
每个硬币:
├─ 物理计算: CPU 消耗
├─ 网络传输: 带宽消耗 (28 bytes/tick)
└─ 客户端渲染: FPS 下降

建议:
├─ 限制同时存在硬币数 (如 100 个)
├─ 更快的 despawn 机制
└─ 硬币合并 (未来优化)
```

#### 5. **客户端渲染性能** ⚠️

检查浏览器：

- **FPS** (HUD 显示)
- 如果 FPS < 30，是客户端问题
- 打开 **DevTools → Performance** 分析

**常见原因**:

- 低端设备
- 浏览器版本过旧
- 其他标签页占用资源

---

## 🔧 优化建议

### 立即优化

#### 1. **添加诊断日志**

在服务器添加带宽和性能监控：

```typescript
// 在 GameLoop.tick() 中添加
const messageSize = msgpack.encode(stateDelta).length;
const coinCount = updates.length;
console.log(
  `📊 Tick ${this.gameState.getTick()}: ${coinCount} coins, ${messageSize} bytes`
);
```

#### 2. **限制硬币数量**

```typescript
// 在 CoinManager 添加最大硬币数限制
const MAX_COINS = 100;

spawnCoin(x: number): number | null {
  if (this.gameState.getAllCoins().size >= MAX_COINS) {
    console.warn('Max coins reached, cannot spawn');
    return null;
  }
  // ... existing code
}
```

#### 3. **优化 despawn 速度**

调整 `COIN_CONFIG.DESPAWN_Y` 值，让硬币更快消失：

```typescript
DESPAWN_Y: -0.05, // 改为 -0.05 (原来是 -0.1)
```

#### 4. **检查僵尸连接**

服务器会自动清理 5 分钟未活动的连接，但可以检查：

```bash
# 在服务器上查看 Docker 日志
docker logs coin-pusher-server --tail 100 | grep "connection"
```

### 长期优化

#### 1. **差分更新 (Delta Compression)**

只发送**改变的位置**，而不是所有硬币：

```typescript
// 只发送位置变化 > 阈值 的硬币
const THRESHOLD = 0.01; // 1cm

updates.push({
  id,
  pos: newPos,
  rot: newRot,
  // 只在变化大时包含
});
```

#### 2. **降低 Tick Rate (可选)**

如果延迟可以接受，降低到 20Hz：

```typescript
TICK_RATE: 20, // 从 30 降到 20
```

带宽减少: 1.21 MB/s → ~0.8 MB/s

#### 3. **使用 Cloudflare 代理**

**强烈推荐** - 见 `CDN_GUIDE.md`:

- ✅ 降低延迟 (边缘节点)
- ✅ DDoS 防护
- ✅ 带宽优化
- ✅ 免费 SSL

---

## 📊 诊断检查清单

### 服务器端

- [ ] 查看服务器日志，确认连接数
- [ ] 检查 CPU 使用率 (`top` 或 `htop`)
- [ ] 确认 MessagePack 正确使用（查看日志）
- [ ] 检查活跃硬币数量（添加日志）
- [ ] 验证 despawn 机制工作正常

### 客户端

- [ ] 检查浏览器 HUD 显示的 **Ping** 值
- [ ] 检查浏览器 HUD 显示的 **FPS** 值
- [ ] 打开 DevTools → Network → WS，查看消息频率
- [ ] 检查是否有错误消息（Console）

### 网络

- [ ] 确认使用 Cloudflare 代理（如果配置了）
- [ ] 测试不同地区的延迟
- [ ] 检查是否有防火墙限制

---

## 🎯 快速诊断命令

### 在服务器上运行

```bash
# 1. 查看 Docker 容器状态
docker ps

# 2. 查看服务器日志
docker logs coin-pusher-server --tail 50 -f

# 3. 检查 CPU/内存使用
docker stats coin-pusher-server

# 4. 查看网络连接数
netstat -an | grep :3000 | wc -l

# 5. 实时监控带宽 (需要安装 iftop)
sudo apt install iftop
sudo iftop -i eth0
```

### 在浏览器中

```javascript
// 在浏览器 Console 中运行
// 查看 WebSocket 消息统计
let msgCount = 0;
let totalBytes = 0;

const ws = document.querySelector("canvas").__gameClient?.wsClient?.ws;
if (ws) {
  const originalOnMessage = ws.onmessage;
  ws.onmessage = (event) => {
    msgCount++;
    totalBytes += event.data.byteLength || event.data.length;
    console.log(
      `Messages: ${msgCount}, Total: ${(totalBytes / 1024).toFixed(2)} KB`
    );
    originalOnMessage.call(ws, event);
  };
}
```

---

## 📝 预期带宽值

### 正常情况（单用户）

```
活跃硬币: 10-20 个
├─ Outbound: 8-17 KB/s
└─ Inbound: < 1 KB/s

活跃硬币: 50 个
├─ Outbound: ~42 KB/s
└─ Inbound: < 1 KB/s

活跃硬币: 100 个
├─ Outbound: ~83 KB/s
└─ Inbound: < 1 KB/s
```

### 多用户情况

```
10 用户 × 20 硬币 = 200 KB/s ✅
20 用户 × 50 硬币 = 834 KB/s ✅
30 用户 × 50 硬币 = 1.25 MB/s ⚠️ (接近你的值)
```

---

## ✅ 总结

### 你的带宽是否合理？

**如果**:

- ✅ 有 **15-30 个活跃用户**
- ✅ 每个房间有 **50-100 个硬币**
- ✅ **1.21 MB/s** 是合理的

**如果**:

- ⚠️ 只有 **1-5 个用户**
- ⚠️ 硬币数 **< 50 个**
- ⚠️ **1.21 MB/s** 偏高，需要优化

### Lag 问题排查顺序

1. **检查 Ping** (HUD 显示) - 如果 > 200ms，是网络问题
2. **检查 FPS** (HUD 显示) - 如果 < 30，是客户端性能问题
3. **检查服务器 CPU** (`docker stats`) - 如果 > 70%，是服务器瓶颈
4. **检查硬币数量** (添加日志) - 如果 > 100，需要限制
5. **检查连接数** (服务器日志) - 如果有僵尸连接，需要清理

### 推荐优化

1. ✅ **使用 Cloudflare** (见 `CDN_GUIDE.md`) - 降低延迟，免费
2. ✅ **添加硬币数量限制** - 防止过多硬币
3. ✅ **添加诊断日志** - 了解具体情况
4. ✅ **优化 despawn 速度** - 更快清理硬币

---

需要我帮你添加这些优化吗？
