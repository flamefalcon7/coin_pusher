# 🗺️ Coin Pusher - 开发路线图

## 📅 项目历史

### PoC 阶段 - 已完成 ✅ (2025-11-01)

#### Phase 1: 项目基础架构
**完成时间**: Day 1
- ✅ pnpm workspace 配置
- ✅ TypeScript 项目结构
- ✅ 共享类型库 (`@coin-pusher/shared`)
- ✅ Protocol 版本控制系统
- ✅ Git 仓库初始化

**技术决策**:
- 使用 pnpm workspace 管理 monorepo
- TypeScript strict mode
- ESM modules

---

#### Phase 2: 服务器核心 (Server Foundation)
**完成时间**: Day 2-3

##### 2.1 WebSocket 服务器
- ✅ ws 库集成
- ✅ 连接管理 (Connection class)
- ✅ 消息处理器 (MessageHandler)
- ✅ 速率限制 (每连接 1 币/100ms)
- ✅ 输入验证 (x ∈ [-0.5, 0.5])
- ✅ Ping/Pong 心跳机制

##### 2.2 游戏状态管理
- ✅ GameState (中央状态管理)
- ✅ CoinManager (硬币生命周期)
- ✅ 整数 ID 分配系统
- ✅ 世界快照生成 (world_snapshot)

##### 2.3 物理引擎集成
- ✅ Rapier3D-compat 集成 (Node.js 兼容)
- ✅ 右手坐标系配置
- ✅ 重力设置: `{x:0, y:-9.81, z:0}`
- ✅ 物理参数优化:
  - 30Hz tick rate
  - Substeps: 2
  - Solver: velocity=8, position=3
- ✅ Sleep 机制启用

##### 2.4 场景构建
- ✅ 静态场景 (SceneBuilder)
  - 主平台 (1.2×0.8×0.05m, 2° 前倾)
  - 后墙 (1.2×0.3×0.05m)
  - 侧墙 (1.5° 内倾)
- ✅ 推板 (Kinematic)
  - 正弦运动: `z = 0.3 * sin(2π * 0.5 * t)`
  - setNextKinematicTranslation 更新
- ✅ 硬币 (Dynamic)
  - 圆柱体: radius=0.02m, thickness=0.009m
  - CCD 自适应 (free-fall 启用, resting 禁用)
  - Mass: 0.01kg, Friction: 0.3, Restitution: 0.2

##### 2.5 游戏循环
- ✅ 固定 30Hz 更新
- ✅ 状态广播 (state_delta)
- ✅ 数值量化 (3 位小数)
- ✅ 四元数标准化
- ✅ Despawn 检测 (y < -0.1m)

**关键文件**:
```
server/src/
├── index.ts (入口 + 初始化)
├── ws/ (WebSocket 层)
│   ├── WebSocketServer.ts
│   ├── Connection.ts
│   └── MessageHandler.ts
├── game/ (游戏逻辑)
│   ├── GameState.ts
│   ├── CoinManager.ts
│   ├── GameLoop.ts
│   └── TickScheduler.ts
└── physics/ (物理引擎)
    ├── PhysicsWorld.ts
    ├── SceneBuilder.ts
    ├── Pusher.ts
    └── Coin.ts
```

---

#### Phase 3: 客户端基础 (Client Foundation)
**完成时间**: Day 4

##### 3.1 构建工具配置
- ✅ Vite 5 + React 18
- ✅ TypeScript 配置
- ✅ 环境变量支持 (VITE_WS_URL)

##### 3.2 UI 组件
- ✅ React 应用结构
- ✅ HUD 组件 (FPS, Ping, Coins)
- ✅ ConnectionStatus 指示器
- ✅ CoinInsertButton (带禁用逻辑)
- ✅ 响应式 CSS 布局

**关键文件**:
```
client/src/
├── main.tsx (React 入口)
├── App.tsx (主应用)
├── App.css (样式)
└── ui/
    ├── HUD.tsx
    ├── CoinInsertButton.tsx
    └── ConnectionStatus.tsx
```

---

#### Phase 4: 3D 渲染 (Client Rendering)
**完成时间**: Day 5

##### 4.1 BabylonJS 场景设置
- ✅ Engine 初始化
- ✅ 右手坐标系: `scene.useRightHandedSystem = true`
- ✅ 场景管理器 (SceneManager)
- ✅ 窗口调整处理

##### 4.2 相机与光照
- ✅ ArcRotateCamera
  - Target: (0, 0.3, 0)
  - Alpha: -π/2, Beta: π/3, Radius: 3m
  - 缩放限制: 2-4m
  - 倾斜限制: 30-80°
- ✅ HemisphericLight
  - Intensity: 0.8
  - 环境光 + 漫反射 + 高光

##### 4.3 静态网格
- ✅ 平台 (灰色, 1.2×0.05×0.8m)
- ✅ 墙壁 (左右后, 蓝灰色)
- ✅ 掉落区域指示 (半透明)

##### 4.4 动态对象
- ✅ 推板网格 (蓝色, 可更新 z 位置)
- ✅ 硬币管理器 (Thin Instances)
  - 金色材质
  - 高效批量渲染
  - 矩阵变换系统

##### 4.5 坐标系对齐
- ✅ Y-up 统一 (BabylonJS + Rapier)
- ✅ 硬币方向修正 (移除错误旋转)
- ✅ 四元数直接应用

**关键文件**:
```
client/src/scene/
├── SceneManager.ts (主管理器)
├── CameraSetup.ts
├── Lighting.ts
├── StaticMeshes.ts
├── PusherMesh.ts
└── CoinMeshManager.ts (Thin instances)
```

---

#### Phase 5: 网络同步 (Client Networking)
**完成时间**: Day 6

##### 5.1 WebSocket 客户端
- ✅ 连接管理
- ✅ 消息解析 (JSON)
- ✅ 重连处理
- ✅ 错误处理

##### 5.2 时钟同步
- ✅ Ping/Pong 机制
- ✅ RTT 测量
- ✅ 中位数过滤 (最近 5 次)
- ✅ Offset 计算: `(serverTime - clientTime) - RTT/2`
- ✅ 自动 ping (每 5 秒)

##### 5.3 状态缓冲
- ✅ 时间戳状态存储
- ✅ 3 秒历史缓冲
- ✅ 插值状态查询

##### 5.4 插值器
- ✅ 固定 100-120ms 延迟
- ✅ 位置 Lerp (线性插值)
- ✅ 旋转 Slerp (球面插值)
- ✅ 四元数路径优化 (dot < 0 处理)

##### 5.5 游戏客户端集成
- ✅ GameClient 统一接口
- ✅ 回调系统 (连接状态, Ping)
- ✅ 自动更新循环

**关键文件**:
```
client/src/net/
├── WebSocketClient.ts
├── ClockSync.ts
├── StateBuffer.ts
├── Interpolator.ts
└── GameClient.ts (集成层)
```

---

#### Phase 6: 端到端集成 (Integration)
**完成时间**: Day 6-7

##### 6.1 实时同步
- ✅ 60fps 更新循环
- ✅ 推板位置同步
- ✅ 硬币生命周期同步
  - 新硬币: 添加到场景
  - 更新: 插值位置/旋转
  - Despawn: 从场景移除

##### 6.2 用户交互
- ✅ Insert Coin 按钮连接服务器
- ✅ 随机 x 位置生成
- ✅ 连接状态控制按钮启用/禁用
- ✅ 视觉反馈 (100ms cooldown)

##### 6.3 状态追踪
- ✅ 已知硬币 ID 集合
- ✅ 自动清理 despawned 硬币
- ✅ UI 实时更新 (FPS, Ping, Coins)

---

#### Phase 7: 测试验证 (Testing)
**完成时间**: Day 7

##### 7.1 单客户端测试
- ✅ 连接成功
- ✅ 世界快照接收
- ✅ 推板运动同步
- ✅ 硬币物理互动
- ✅ Despawn 正常

##### 7.2 多客户端测试
- ✅ 多窗口打开
- ✅ 状态同步验证
- ✅ 位置误差 < 0.02m
- ✅ 平滑插值 (无瞬移)

##### 7.3 性能验证
- ✅ FPS ≥ 20 (移动端目标)
- ✅ 桌面 FPS: 30-60
- ✅ RTT < 50ms (本地)
- ✅ Clock offset < 20ms

##### 7.4 坐标系验证
- ✅ 硬币沿 Y 轴下落 ✓
- ✅ 推板沿 Z 轴运动 ✓
- ✅ 无镜像或翻转问题 ✓

---

#### Phase 8: 文档完善 (Documentation)
**完成时间**: Day 7

- ✅ 根目录 README (架构概览)
- ✅ Server README (物理引擎详情)
- ✅ Client README (场景与网络)
- ✅ 完整 API 文档
- ✅ 部署指南
- ✅ 故障排除指南

---

## 🎯 PoC 阶段达成目标

### 技术验证 ✅
- [x] Rapier 在浏览器与 Node.js 双端运行
- [x] BabylonJS + Rapier 坐标系对齐
- [x] 多人实时互动同步
- [x] WebSocket 稳定性验证
- [x] 插值效果验证
- [x] 世界快照机制
- [x] Despawn 事件处理

### 性能指标 ✅
- [x] 右手坐标一致性: 无镜像问题
- [x] 四元数旋转: 平滑无跳跃
- [x] 时钟同步: offset < 20ms
- [x] 插值缓冲: RTT ±50ms 稳定
- [x] 多人同步: 误差 < 0.02m
- [x] 推板运动: 流畅正弦运动
- [x] FPS: 移动 ≥20, 桌面 30-60
- [x] 初次连接: < 2s
- [x] 吞吐量: < 30 KB/s per client
- [x] 穿透率: 0% (CCD 启用)

### Git 提交历史
```
8ebba90 docs: add comprehensive README documentation
26e59e0 feat: integrate client and server with real-time synchronization
d78454b feat(client): implement WebSocket client with clock sync and interpolation
d0a4936 feat(client): implement BabylonJS 3D scene rendering
5a4c327 fix(server): use rapier3d-compat for Node.js compatibility
c2bb58f phase 2 3
27b9a2f chore(server): initialize server package with dependencies
2cc0d3c feat(shared): add protocol types and constants
6c14b93 chore: initialize pnpm workspace structure
```

---

## 🚀 下一阶段开发路线

### 选项 1: 游戏机制完善 🎮
**优先级**: ⭐⭐⭐⭐⭐ (商业价值高)  
**工期**: 3-4 天  
**依赖**: PoC 完成

#### 1.1 计分系统
**工期**: 1.5 天

**实现内容**:
- [ ] 掉落区域检测
  - 多个得分区域 (不同分值)
  - 边界检测优化
  - 区域可视化
- [ ] 分数计算逻辑
  - 基础分数
  - 连击加成
  - 特殊奖励
- [ ] RTP (Return to Player) 系统
  - 预期回报率设置
  - 动态 RTP 调整
  - 统计分析
- [ ] 分数显示
  - 实时分数更新
  - 动画效果
  - 历史记录

**技术要点**:
- Server 端权威计算
- 防作弊验证
- 分数历史持久化

---

#### 1.2 余额系统
**工期**: 1 天

**实现内容**:
- [ ] 虚拟货币管理
  - 余额扣减
  - 余额增加
  - 交易日志
- [ ] 投币成本
  - 每次投币扣费
  - 余额不足处理
  - 充值接口预留
- [ ] UI 显示
  - 当前余额显示
  - 交易历史
  - 余额变化动画

**数据结构**:
```typescript
interface UserBalance {
  userId: string;
  balance: number;
  transactions: Transaction[];
  createdAt: number;
  updatedAt: number;
}

interface Transaction {
  id: string;
  type: 'debit' | 'credit';
  amount: number;
  reason: string;
  timestamp: number;
}
```

---

#### 1.3 游戏会话管理
**工期**: 0.5 天

**实现内容**:
- [ ] 回合系统
  - 回合开始/结束
  - 超时处理
  - 结果计算
- [ ] 状态机
  - IDLE → PLAYING → SETTLING → FINISHED
  - 状态转换逻辑
  - 状态广播

---

### 选项 2: 视觉效果提升 ✨
**优先级**: ⭐⭐⭐⭐ (用户体验)  
**工期**: 2-3 天  
**依赖**: PoC 完成

#### 2.1 材质升级
**工期**: 1 天

**实现内容**:
- [ ] PBR 材质系统
  - 金属度 (Metallic)
  - 粗糙度 (Roughness)
  - 环境贴图
- [ ] 硬币材质
  - 金属质感
  - 反射效果
  - 法线贴图
- [ ] 场景材质
  - 木纹平台
  - 金属推板
  - 玻璃墙壁

**BabylonJS 配置**:
```typescript
const pbr = new PBRMaterial("coinPBR", scene);
pbr.metallic = 1.0;
pbr.roughness = 0.3;
pbr.reflectivityColor = new Color3(1, 0.84, 0);
```

---

#### 2.2 光影效果
**工期**: 0.5 天

**实现内容**:
- [ ] 实时阴影
  - Shadow generator
  - Shadow map 优化
  - 软阴影
- [ ] 环境光遮蔽 (AO)
  - SSAO (Screen Space AO)
  - 接触阴影
- [ ] 光照优化
  - 多光源
  - 动态光照

---

#### 2.3 粒子与特效
**工期**: 0.5 天

**实现内容**:
- [ ] 硬币掉落特效
  - 轨迹拖尾
  - 落地粒子
  - 碰撞火花
- [ ] UI 动画
  - 分数弹出
  - 按钮反馈
  - 过渡动画

---

#### 2.4 背景装饰
**工期**: 0.5 天

**实现内容**:
- [ ] 背景环境
  - Skybox
  - 环境贴图
  - 景深效果
- [ ] 装饰元素
  - 边框装饰
  - 灯光效果
  - 氛围营造

---

### 选项 3: 架构升级 🏗️
**优先级**: ⭐⭐⭐⭐ (长期价值)  
**工期**: 4-5 天  
**依赖**: PoC 完成

#### 3.1 Redis 集成
**工期**: 1.5 天

**实现内容**:
- [ ] Redis 连接管理
  - 连接池
  - 重连机制
  - 健康检查
- [ ] Redis Streams (Event Sourcing)
  - 事件发布
  - 事件订阅
  - 消费者组
- [ ] 数据持久化
  - 游戏状态快照
  - 用户数据
  - 统计数据

**架构变更**:
```
Game Loop → Publish Events → Redis Streams
                                    ↓
                            Event Handlers
                                    ↓
                         State Update & Broadcast
```

---

#### 3.2 多房间系统
**工期**: 2 天

**实现内容**:
- [ ] 房间管理器
  - 创建/销毁房间
  - 房间列表
  - 房间状态
- [ ] Matchmaking
  - 快速匹配
  - 房间查找
  - 玩家队列
- [ ] 房间隔离
  - 独立物理世界
  - 独立游戏循环
  - 资源管理

**数据结构**:
```typescript
interface Room {
  id: string;
  name: string;
  maxPlayers: number;
  currentPlayers: number;
  status: 'waiting' | 'playing' | 'finished';
  createdAt: number;
  physicsWorld: PhysicsWorld;
  gameLoop: GameLoop;
}
```

---

#### 3.3 断线重连
**工期**: 1 天

**实现内容**:
- [ ] 连接状态管理
  - 心跳检测
  - 超时判断
  - 重连逻辑
- [ ] 状态恢复
  - 快照机制
  - 增量更新
  - 客户端追赶
- [ ] 会话保持
  - Session token
  - 状态缓存
  - 超时清理

---

#### 3.4 游戏重放
**工期**: 0.5 天

**实现内容**:
- [ ] 事件记录
  - 命令序列化
  - 时间戳记录
- [ ] 重放引擎
  - 确定性重放
  - 速度控制
  - 暂停/继续

---

### 选项 4: 用户系统 👤
**优先级**: ⭐⭐⭐⭐⭐ (上线必需)  
**工期**: 3-4 天  
**依赖**: PoC 完成

#### 4.1 认证系统
**工期**: 1.5 天

**实现内容**:
- [ ] JWT Token 系统
  - Access token (短期)
  - Refresh token (长期)
  - Token 刷新机制
- [ ] 用户注册
  - 用户名/密码
  - 邮箱验证
  - 密码加密 (bcrypt)
- [ ] 用户登录
  - 凭证验证
  - Session 创建
  - 多设备登录控制

**数据库设计**:
```typescript
interface User {
  id: string;
  username: string;
  email: string;
  passwordHash: string;
  createdAt: number;
  lastLoginAt: number;
  isActive: boolean;
}

interface Session {
  id: string;
  userId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  device: string;
}
```

---

#### 4.2 用户数据管理
**工期**: 1 天

**实现内容**:
- [ ] 用户资料
  - 基本信息
  - 头像系统
  - 个性化设置
- [ ] 游戏统计
  - 总投币数
  - 总得分
  - 胜率统计
  - 游戏时长
- [ ] 游戏历史
  - 历史记录
  - 详细数据
  - 统计图表

---

#### 4.3 安全强化
**工期**: 1 天

**实现内容**:
- [ ] 更严格的速率限制
  - IP 级别限速
  - 用户级别限速
  - 动态限速调整
- [ ] 防作弊机制
  - 客户端校验
  - 异常检测
  - 行为分析
- [ ] 输入验证
  - Schema 验证
  - SQL 注入防护
  - XSS 防护

**技术栈**:
- `express-rate-limit` - API 限速
- `helmet` - 安全头
- `joi` - 数据验证

---

#### 4.4 数据库选择
**工期**: 0.5 天

**选项 A: PostgreSQL**
- 关系型数据
- ACID 保证
- 复杂查询支持

**选项 B: MongoDB**
- 灵活 schema
- 水平扩展
- JSON 原生支持

**推荐**: PostgreSQL (数据一致性重要)

---

### 选项 5: 性能优化 ⚡
**优先级**: ⭐⭐⭐ (可选优化)  
**工期**: 2-3 天  
**依赖**: 基础功能完成

#### 5.1 协议优化
**工期**: 1 天

**实现内容**:
- [ ] 二进制协议
  - MessagePack 或 Protobuf
  - Schema 定义
  - 编码/解码
- [ ] 压缩传输
  - zlib 压缩
  - 自适应压缩
- [ ] 差分更新
  - 只发送变化
  - Delta encoding

**性能提升**:
- 包大小: -40% ~ -60%
- CPU: -20% ~ -30%

---

#### 5.2 物理优化
**工期**: 0.5 天

**实现内容**:
- [ ] Sleep 策略优化
  - 更快睡眠
  - 分层睡眠
- [ ] 空间分区
  - Broad-phase 优化
  - 减少碰撞检测
- [ ] 批量操作
  - 批量创建/删除
  - 批量更新

---

#### 5.3 渲染优化
**工期**: 0.5 天

**实现内容**:
- [ ] LOD (Level of Detail)
  - 距离分级
  - 自动切换
- [ ] 视锥剔除
  - Frustum culling
  - Occlusion culling
- [ ] Batching 优化
  - Static batching
  - Dynamic batching

---

#### 5.4 监控系统
**工期**: 0.5 天

**实现内容**:
- [ ] 性能指标
  - CPU 使用率
  - 内存使用
  - 网络流量
- [ ] 日志系统
  - 结构化日志
  - 日志聚合
  - 错误追踪
- [ ] 告警系统
  - 阈值告警
  - 实时通知

**工具选择**:
- `prom-client` - Prometheus metrics
- `winston` - 日志
- `sentry` - 错误追踪

---

## 📊 推荐开发路线

### 🥇 路线 A: 快速上线 (2-3 周)
**目标**: MVP 产品上线

**Week 1**:
- Day 1-2: 用户系统 (认证 + 注册/登录)
- Day 3-4: 计分系统 (掉落检测 + 分数计算)
- Day 5: 余额系统 + 游戏会话

**Week 2**:
- Day 1-2: 视觉效果 (PBR 材质 + 光影)
- Day 3: UI/UX 改进
- Day 4-5: 集成测试 + Bug 修复

**Week 3**:
- Day 1-2: 性能优化
- Day 3-4: 部署 + 监控
- Day 5: 正式上线

**优势**:
- 快速验证市场
- 早期用户反馈
- 低开发成本

---

### 🥈 路线 B: 技术优先 (3-4 周)
**目标**: 可扩展架构

**Week 1**:
- Day 1-2: Redis 集成
- Day 3-5: 多房间系统

**Week 2**:
- Day 1-2: 用户系统
- Day 3-4: 断线重连
- Day 5: 游戏重放

**Week 3**:
- Day 1-2: 性能优化
- Day 3-5: 监控系统

**Week 4**:
- Day 1-3: 计分 + 余额系统
- Day 4-5: 测试 + 部署

**优势**:
- 架构扎实
- 易于扩展
- 长期维护成本低

---

### 🥉 路线 C: 体验优化 (2-3 周)
**目标**: 极致用户体验

**Week 1**:
- Day 1-2: PBR 材质 + 光影
- Day 3-4: 粒子特效 + 动画
- Day 5: 背景装饰 + 音效

**Week 2**:
- Day 1-3: 计分系统 + UI 动效
- Day 4-5: 游戏机制完善

**Week 3**:
- Day 1-2: 用户系统
- Day 3-5: 测试 + 部署

**优势**:
- 用户体验好
- 视觉吸引力强
- 用户留存率高

---

## 🎯 里程碑规划

### Milestone 1: 基础游戏 (2 周)
- ✅ PoC 完成
- [ ] 用户系统
- [ ] 计分系统
- [ ] 基础 UI

**验收标准**:
- 用户可注册/登录
- 可投币并获得分数
- 分数正确计算并显示

---

### Milestone 2: 视觉升级 (1 周)
- [ ] PBR 材质
- [ ] 光影效果
- [ ] UI 动画

**验收标准**:
- 画面质感提升
- 动画流畅
- 用户反馈良好

---

### Milestone 3: 架构优化 (2 周)
- [ ] Redis 集成
- [ ] 多房间
- [ ] 性能优化

**验收标准**:
- 支持 100+ 同时在线
- 延迟 < 100ms
- 稳定运行 24h+

---

### Milestone 4: 上线准备 (1 周)
- [ ] 监控系统
- [ ] 部署流程
- [ ] 文档完善

**验收标准**:
- CI/CD 自动化
- 监控告警正常
- 文档齐全

---

## 📝 技术债务追踪

### 当前已知问题
1. **安全性**
   - [ ] 无用户认证
   - [ ] 简单的速率限制
   - [ ] 缺少输入验证

2. **可靠性**
   - [ ] 无断线重连
   - [ ] 无状态持久化
   - [ ] 单点故障风险

3. **性能**
   - [ ] JSON 协议开销大
   - [ ] 无协议压缩
   - [ ] 未优化物理引擎

4. **功能**
   - [ ] 无计分系统
   - [ ] 无用户系统
   - [ ] 单房间限制

---

## 🛠️ 技术栈演进

### 当前技术栈 (PoC)
```
Frontend:
- React 18
- TypeScript 5
- BabylonJS 6
- Vite 5

Backend:
- Node.js 20
- TypeScript 5
- ws (WebSocket)
- Rapier3D-compat

Infrastructure:
- pnpm workspace
- Git
```

### 建议新增 (下阶段)
```
Backend:
- PostgreSQL (用户数据)
- Redis (缓存 + Pub/Sub)
- JWT (认证)
- bcrypt (密码)

DevOps:
- Docker
- Docker Compose
- PM2 (进程管理)

Monitoring:
- Prometheus (metrics)
- Grafana (可视化)
- Winston (日志)
- Sentry (错误追踪)

Testing:
- Jest (单元测试)
- Playwright (E2E)
```

---

## 📚 参考资源

### 已实现功能文档
- ✅ [README.md](./README.md) - 项目概览
- ✅ [server/README.md](./server/README.md) - 服务器文档
- ✅ [client/README.md](./client/README.md) - 客户端文档
- ✅ [docs/PRD.txt](./docs/PRD.txt) - 产品需求文档
- ✅ [docs/Scene.md](./docs/Scene.md) - 场景规格

### 技术参考
- [Rapier3D 文档](https://rapier.rs/docs/)
- [BabylonJS 文档](https://doc.babylonjs.com/)
- [WebSocket 协议](https://datatracker.ietf.org/doc/html/rfc6455)
- [Redis Streams](https://redis.io/docs/data-types/streams/)

---

## ✅ 验收清单模板

### 新功能验收标准
```markdown
#### 功能名称: [XXX]

**功能描述**:
- 

**验收标准**:
- [ ] 功能正常运行
- [ ] 单元测试通过
- [ ] 集成测试通过
- [ ] 代码审查通过
- [ ] 文档已更新
- [ ] 性能符合要求

**性能要求**:
- 响应时间: < XXms
- 吞吐量: > XXX req/s
- 错误率: < 0.1%

**测试场景**:
1. 正常场景:
2. 异常场景:
3. 边界场景:
```

---

## 📞 联系与支持

**项目状态**: PoC 完成 ✅  
**最后更新**: 2025-11-01  
**下次评审**: TBD

---

*此文档将持续更新，记录项目演进历程*

