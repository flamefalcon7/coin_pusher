# 闲置连接自动断开功能

## 📋 功能说明

自动检测并断开长时间无活动的 WebSocket 连接，以节省服务器资源并防止连接泄漏。

## ⚙️ 配置参数

在 `shared/src/types.ts` 中的 `NETWORK_CONFIG`：

```typescript
NETWORK_CONFIG = {
  CONNECTION_IDLE_TIMEOUT: 300000,      // 5 分钟 (300000 ms)
  CONNECTION_CHECK_INTERVAL: 30000,     // 30 秒检查一次
}
```

### 参数说明

- **CONNECTION_IDLE_TIMEOUT**: 连接超时时间（毫秒）
  - 默认: 5 分钟
  - 如果连接在此时间内没有任何活动，将被自动断开
  
- **CONNECTION_CHECK_INTERVAL**: 检查间隔（毫秒）
  - 默认: 30 秒
  - 服务器每 30 秒检查一次所有连接的活动状态

## 🔄 工作原理

### 1. 活动跟踪

**连接活动包括**:
- 接收到任何客户端消息（ping, coin_insert）
- 发送消息本身不算活动（只有接收算）

**实现位置**:
```typescript
// server/src/ws/WebSocketServer.ts
ws.on("message", (data: Buffer) => {
  connection.updateActivity(); // 更新活动时间戳
  // ... 处理消息
});
```

### 2. 定期清理

**清理流程**:
1. 每 30 秒执行一次检查
2. 遍历所有连接
3. 检测每个连接的最后活动时间
4. 如果超过 5 分钟无活动，断开连接

**实现位置**:
```typescript
// server/src/ws/WebSocketServer.ts
private cleanupIdleConnections(): void {
  // 检查所有连接
  // 断开超时连接
}
```

### 3. 日志输出

当检测到并断开闲置连接时，服务器会输出日志：

```
⏰ Disconnecting 2 idle connection(s) (no activity for 300s)
   💤 Connection idle for 305s, closing...
   💤 Connection idle for 312s, closing...
   ✅ Cleanup complete (remaining connections: 5)
```

## 🧪 测试方法

### 方法 1: 等待超时（真实测试）

1. **启动服务器**:
```bash
cd server && pnpm dev
```

2. **连接客户端**:
   - 打开游戏页面或测试客户端
   - 连接到服务器

3. **停止活动**:
   - 不要发送任何消息（ping 或 coin_insert）
   - 等待 5 分钟

4. **观察结果**:
   - 服务器日志显示断开连接
   - 客户端收到 WebSocket 关闭事件

### 方法 2: 修改超时时间（快速测试）

临时修改配置进行快速测试：

```typescript
// shared/src/types.ts
export const NETWORK_CONFIG = {
  CONNECTION_IDLE_TIMEOUT: 60000,  // 改为 1 分钟
  CONNECTION_CHECK_INTERVAL: 10000, // 改为 10 秒检查一次
}
```

然后按方法 1 测试，只需等待 1 分钟即可看到效果。

### 方法 3: 使用测试客户端

使用 `test-ws-client.html`:

1. 打开测试客户端
2. 连接到服务器
3. **不要点击任何按钮**
4. 观察浏览器控制台和服务器日志

**预期行为**:
- 客户端: 1 分钟后收到连接关闭事件
- 服务器: 输出断开日志

## 📊 资源节省

### 内存节省

**每个连接占用**:
- WebSocket buffer: ~50 KB
- 状态缓冲: ~100 KB
- Node.js 对象: ~50 KB
- **总计**: ~200 KB/连接

**示例**:
- 10 个闲置连接 = ~2 MB
- 断开后可节省这 2 MB 内存

### CPU 节省

**广播消息**:
- 每 33ms 向所有连接广播 state_delta
- 10 个连接 = 每秒 300 次发送操作
- 断开闲置连接可减少广播开销

### 网络带宽

**节省带宽**:
- 每个连接: ~25 KB/s (下行)
- 10 个闲置连接: ~250 KB/s
- 断开后可节省这部分带宽

## 🔧 自定义配置

### 调整超时时间

根据不同场景调整：

```typescript
// 快速游戏（需要频繁互动）
CONNECTION_IDLE_TIMEOUT: 60000,  // 1 分钟

// 休闲游戏（可长时间观看）
CONNECTION_IDLE_TIMEOUT: 600000, // 10 分钟

// 演示/测试环境
CONNECTION_IDLE_TIMEOUT: 30000,  // 30 秒
```

### 调整检查间隔

```typescript
// 频繁检查（更及时，但 CPU 开销稍高）
CONNECTION_CHECK_INTERVAL: 10000,  // 10 秒

// 标准检查（平衡）
CONNECTION_CHECK_INTERVAL: 30000,  // 30 秒

// 宽松检查（CPU 开销低，但清理稍慢）
CONNECTION_CHECK_INTERVAL: 60000,  // 60 秒
```

## 📝 注意事项

### Ping 作为活动

客户端的 ping 消息（每 5 秒）会被视为活动：
- ✅ 正常游戏的连接不会被断开
- ✅ 即使只是观看游戏，ping 也会保持连接活跃

### 关闭页面

如果用户关闭浏览器标签页：
- WebSocket 会正常关闭
- 连接会从服务器移除
- 不会触发闲置超时（因为连接已关闭）

### 网络中断

如果网络暂时中断：
- 客户端会尝试重连
- 服务器端的旧连接会因无活动而被清理
- 新连接会正常建立

## 🎯 最佳实践

### 推荐配置

**生产环境**:
```typescript
CONNECTION_IDLE_TIMEOUT: 300000,      // 5 分钟
CONNECTION_CHECK_INTERVAL: 30000,     // 30 秒
```

**理由**:
- 5 分钟足够长，不会影响正常用户
- 30 秒检查间隔平衡及时性和性能

### 监控建议

在生产环境中监控：
- 每小时断开的连接数
- 平均连接持续时间
- 如果断开数量异常，考虑调整超时时间

## ✅ 实现检查清单

- [x] Connection 类添加活动跟踪
- [x] WebSocketServer 添加定期清理
- [x] 配置参数添加到 NETWORK_CONFIG
- [x] 日志输出完善
- [x] 优雅关闭（清理定时器）
- [x] 编译验证通过

