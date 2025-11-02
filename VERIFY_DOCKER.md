# 🧪 Docker 本地验证指南

## ✅ 当前状态

Docker Compose 已在本地成功启动：

- ✅ 容器状态: **healthy**
- ✅ WebSocket 端口: **3000**
- ✅ 物理引擎: 已初始化
- ✅ 游戏循环: 30Hz 运行中
- ✅ 闲置超时: 已启用

---

## 📋 本地验证步骤

### 方法 1: 使用测试页面（推荐）

1. **打开测试页面**:

   ```
   file:///Users/rickyeh/flamefalcon/coin_pusher/test-docker.html
   ```

2. **点击按钮测试**:

   - `Test Connection (Port 3000)` - 应该看到：

     - ✅ Connected successfully!
     - 📥 Received: world_snapshot
     - 🎉 Docker container is working correctly!

   - `Insert Test Coin` - 应该看到：
     - 📤 Sent: coin_insert at x=...
     - 📥 Received: state_delta

3. **预期结果**:
   - 所有日志显示为绿色（成功）
   - 收到持续的 state_delta 消息（每 33ms）
   - Pusher Z 值在变化

---

### 方法 2: 使用浏览器控制台

1. 打开浏览器（任意页面）
2. 按 F12 打开控制台
3. 粘贴以下代码：

```javascript
// 导入 MessagePack
const script = document.createElement("script");
script.type = "module";
script.textContent = `
  import * as msgpack from 'https://cdn.jsdelivr.net/npm/@msgpack/msgpack@3.1.2/+esm';
  
  const ws = new WebSocket('ws://localhost:3000');
  ws.binaryType = 'arraybuffer';
  
  ws.onopen = () => console.log('✅ Connected!');
  
  ws.onmessage = (event) => {
    const msg = msgpack.decode(new Uint8Array(event.data));
    console.log('📥', msg.op, msg);
  };
  
  ws.onerror = (err) => console.error('❌', err);
  
  window.testWs = ws;
  console.log('WebSocket stored in window.testWs');
`;
document.head.appendChild(script);
```

4. 应该看到：
   - ✅ Connected!
   - 📥 world_snapshot {...}
   - 📥 state_delta {...} (持续接收)

---

### 方法 3: 使用 Docker 日志

查看服务器日志中的连接信息：

```bash
# 实时日志
docker-compose logs -f server

# 应该看到（当有客户端连接时）:
# ✅ New connection (total: 1)
# 📸 Sent world snapshot to new connection (11 bodies)
```

---

### 方法 4: 使用命令行工具

如果安装了 `wscat`:

```bash
# 安装 wscat (如果没有)
npm install -g wscat

# 连接测试
wscat -c ws://localhost:3000

# 应该看到连接成功，并收到二进制消息
```

---

## 🎮 验证游戏功能

### 测试完整游戏

1. **启动客户端**（在另一个终端）:

   ```bash
   cd client
   pnpm dev
   ```

2. **打开浏览器**:

   ```
   http://localhost:5173
   ```

3. **验证功能**:
   - ✅ 连接状态显示 "Connected"
   - ✅ Ping 显示延迟（< 5ms 本地）
   - ✅ 推板在移动
   - ✅ 点击 "Insert Coin" 可以插入硬币
   - ✅ 硬币掉落并与推板互动

---

## 📊 Docker 资源监控

### 查看容器资源使用

```bash
docker stats coin-pusher-server
```

**预期值**:

- CPU: 5-15% (闲置)，30-50% (10+ 硬币)
- 内存: 150-250 MB
- 网络: 进/出持续有数据流动

### 查看镜像大小

```bash
docker images coin_pusher_server
```

**预期大小**: ~150-200 MB（Alpine 基础镜像）

---

## ✅ 验证检查清单

### Docker 基础

- [ ] 容器状态为 `healthy`
- [ ] 端口 3000 可访问
- [ ] 日志无错误信息
- [ ] 健康检查通过

### WebSocket 连接

- [ ] 测试页面可以连接
- [ ] 收到 world_snapshot
- [ ] 持续收到 state_delta（每 33ms）
- [ ] 可以发送 coin_insert

### 游戏功能

- [ ] 客户端可以连接
- [ ] 推板在移动
- [ ] 可以插入硬币
- [ ] 硬币物理模拟正常
- [ ] FPS 稳定（60fps）

### 性能

- [ ] CPU 使用合理（< 50%）
- [ ] 内存使用正常（< 300 MB）
- [ ] 无内存泄漏
- [ ] 消息延迟低（< 5ms 本地）

---

## 🐛 常见问题

### 问题 1: 端口被占用

```bash
# 错误: bind: address already in use
# 解决: 停止占用端口的进程
docker-compose down
# 或检查其他进程
lsof -i :3000
```

### 问题 2: 容器 unhealthy

```bash
# 查看详细日志
docker-compose logs server

# 检查健康检查
docker inspect coin-pusher-server | grep -A 10 Health
```

### 问题 3: 无法连接 WebSocket

```bash
# 检查容器网络
docker network ls
docker network inspect coin_pusher_default

# 检查端口映射
docker ps
```

---

## 🚀 部署到 VM

验证成功后，在 VM 上执行：

```bash
# 1. 拉取最新代码
cd ~/coin_pusher
git pull origin main

# 2. 停止旧容器（如果有）
docker-compose down

# 3. 启动新容器
docker-compose up -d

# 4. 查看状态
docker-compose ps
docker-compose logs -f server
```

---

## 📝 后续步骤

本地验证成功后：

1. **推送代码到 GitHub**:

   ```bash
   git push origin main
   ```

2. **在 VM 上更新**:

   ```bash
   cd ~/coin_pusher
   git pull origin main
   docker-compose up -d --build
   ```

3. **配置 Cloudflare**:
   - DNS: api.yourdomain.com → VM IP
   - 客户端环境变量: VITE_WS_URL=wss://api.yourdomain.com

---

## 🎉 完成！

本地验证通过后，Docker 部署就可以正式用于生产了。
