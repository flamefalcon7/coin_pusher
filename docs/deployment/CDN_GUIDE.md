# 🌐 CDN 配置指南

## 📋 为什么需要 CDN？

### 优势

1. **性能提升**

   - 静态文件缓存到全球边缘节点
   - 减少服务器带宽压力
   - 降低延迟（就近访问）

2. **成本节省**

   - 静态文件不占用服务器带宽
   - 减少服务器负载
   - 免费 CDN 选项（Cloudflare）

3. **可靠性**
   - DDoS 防护
   - 自动故障转移
   - 高可用性

### 架构方案

```
用户请求
   ↓
Cloudflare CDN (边缘节点)
   ├─ 静态文件 (HTML/CSS/JS) ← 缓存
   └─ API 请求 → Digital Ocean 服务器
                    └─ WebSocket 连接
```

## 🎯 推荐方案: Cloudflare

### 为什么选择 Cloudflare？

✅ **完全免费** (Free Plan)
✅ **全球 CDN** (200+ 边缘节点)
✅ **DDoS 防护**
✅ **自动 SSL 证书**
✅ **WebSocket 支持**
✅ **易于配置**

---

## 📦 方案 A: Cloudflare Pages (推荐)

### 适用于

- React/Vite 客户端应用
- 需要自动构建和部署
- GitHub 集成

### 配置步骤

#### 1. 创建 Cloudflare Pages 项目

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 进入 **Pages** → **Create a project**
3. 选择 **Connect to Git**
4. 授权 GitHub 并选择仓库

#### 2. 构建配置

```
Framework preset: Vite
Build command: pnpm install && cd shared && pnpm build && cd ../client && pnpm build
Build output directory: client/dist
Root directory: /
```

**重要**: 由于是 monorepo 结构，需要先构建 `shared` 包，再构建 `client`。`shared` 包包含 TypeScript 类型定义，必须在 `client` 构建前编译完成。

#### 3. 环境变量

在 Pages 设置 → **Environment variables** 添加：

```
VITE_WS_URL=wss://api.yourdomain.com
```

#### 4. 自定义域名

在 Pages 设置 → **Custom domains**：

- 添加: `yourdomain.com`
- 添加: `www.yourdomain.com`

Cloudflare 会自动：

- 配置 DNS 记录
- 生成 SSL 证书
- 启用 HTTPS

### 优点

✅ 完全免费
✅ 自动部署（Git push）
✅ 全球 CDN
✅ 自动 HTTPS
✅ 预览部署
✅ 回滚功能

---

## 📦 方案 B: Cloudflare + Nginx (灵活方案)

### 适用于

- 需要更多控制
- 静态文件部署在同一服务器
- 不想使用 Pages

### 配置步骤

#### 1. 在服务器部署静态文件

```bash
# 构建客户端
cd client && pnpm build

# 复制到 Nginx 目录
sudo cp -r dist/* /var/www/coin-pusher/client/dist/
```

#### 2. 配置 Nginx

见 `nginx.conf` 文件中的静态文件服务器配置。

#### 3. 配置 Cloudflare

1. 添加 DNS A 记录：

   - `yourdomain.com` → 服务器 IP
   - `www.yourdomain.com` → 服务器 IP

2. 启用 Proxy (橙色云)

3. SSL/TLS 设置：
   - 加密模式: **Full (strict)**

### 优点

✅ 完全控制
✅ 单服务器部署
✅ Cloudflare 保护

### 缺点

⚠️ 需要手动部署静态文件
⚠️ 占用服务器带宽（虽然 Cloudflare 会缓存）

---

## 🔧 方案 C: Cloudflare Workers + R2 (高级)

### 适用于

- 大规模应用
- 需要更多边缘计算
- 成本预算充足（虽然 Free Plan 也足够）

### 配置（可选）

如果未来需要更多功能，可以考虑：

- Cloudflare Workers: 边缘函数
- Cloudflare R2: 对象存储

---

## 🌐 WebSocket 配置

### 重要: WebSocket 需要通过 Cloudflare

Cloudflare **支持 WebSocket**，但需要正确配置。

### 选项 1: 使用单独子域名（推荐）

```
客户端: https://yourdomain.com
WebSocket: wss://api.yourdomain.com
```

**配置**:

1. 在 Cloudflare DNS 添加：

   - `api` → A 记录 → 服务器 IP → ✅ Proxy

2. 客户端环境变量：
   ```
   VITE_WS_URL=wss://api.yourdomain.com
   ```

### 选项 2: 使用路径（需要额外配置）

```
客户端: https://yourdomain.com
WebSocket: wss://yourdomain.com/ws
```

需要在 Cloudflare 设置 Transform Rules：

- When: `http.request.uri.path starts_with "/ws"`
- Then: Set `WebSocket: On`

**推荐选项 1**，更简单且清晰。

---

## 🔒 SSL/TLS 配置

### Cloudflare SSL 设置

1. 进入 Cloudflare → SSL/TLS
2. 设置：
   - **加密模式**: Full (strict) ✅
   - **自动 HTTPS 重写**: 启用
   - **始终使用 HTTPS**: 启用
   - **最小 TLS 版本**: 1.2

### 服务器 SSL (如果直接访问)

如果用户可能直接访问服务器 IP（不使用 Cloudflare），需要配置 Let's Encrypt：

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d api.yourdomain.com
```

---

## 📊 缓存策略

### Cloudflare 自动缓存

Cloudflare 会自动缓存：

- 静态文件 (JS/CSS/图片)
- HTML (可配置)

### 自定义缓存规则（可选）

在 Cloudflare → **Rules** → **Page Rules**：

```
规则 1: 缓存静态文件
URL: yourdomain.com/*.js
设置:
- Cache Level: Cache Everything
- Edge Cache TTL: 1 month

规则 2: 缓存 CSS
URL: yourdomain.com/*.css
设置:
- Cache Level: Cache Everything
- Edge Cache TTL: 1 month
```

### HTML 缓存

**不缓存 HTML**（确保用户获得最新版本）：

```
URL: yourdomain.com/index.html
设置:
- Cache Level: Bypass
```

或使用版本化文件名（Vite 已自动处理）：

- `index-abc123.js` → 可以缓存

---

## 🚀 性能优化

### 1. 启用 Brotli 压缩

Cloudflare 自动启用，无需配置。

### 2. HTTP/2 和 HTTP/3

Cloudflare 自动支持，无需配置。

### 3. 最小化文件

Vite 构建已自动优化：

- 代码压缩
- Tree-shaking
- 代码分割

### 4. 图片优化（未来）

如果有图片，可以使用：

- Cloudflare Images
- WebP 格式
- 懒加载

---

## 🔍 监控和统计

### Cloudflare Analytics

Cloudflare 提供免费统计：

- 访问量
- 带宽使用
- 请求来源
- 性能指标

访问: Cloudflare Dashboard → Analytics

### 自定义监控（可选）

如果需要在应用中集成：

- Google Analytics
- Plausible Analytics (隐私友好)
- Cloudflare Web Analytics (免费)

---

## 📝 CDN 检查清单

### Cloudflare Pages 配置

- [ ] 项目已创建
- [ ] GitHub 仓库已连接
- [ ] 构建配置正确
- [ ] 环境变量已设置
- [ ] 自定义域名已添加
- [ ] SSL 证书已生效

### DNS 配置

- [ ] NameServer 已更新到 Cloudflare
- [ ] DNS 记录已配置
- [ ] Proxy 已启用（橙色云）
- [ ] DNS 传播完成（24-48 小时）

### SSL/TLS

- [ ] 加密模式: Full (strict)
- [ ] 自动 HTTPS 重写: 启用
- [ ] 始终使用 HTTPS: 启用

### WebSocket

- [ ] 子域名配置 (api.yourdomain.com)
- [ ] DNS A 记录已添加
- [ ] Proxy 已启用
- [ ] 客户端环境变量已更新

### 验证

- [ ] 网站可通过 HTTPS 访问
- [ ] WebSocket 连接成功
- [ ] 静态文件加载正常
- [ ] 无混合内容警告

---

## 💰 成本

### Cloudflare Free Plan

✅ **完全免费**，包括：

- 无限带宽
- DDoS 防护
- SSL 证书
- CDN 加速
- 基础分析

### 升级选项（可选）

如果需要更多功能：

- **Pro Plan**: $20/月
  - 更多页面规则
  - 高级缓存
  - 图像优化
- **Business Plan**: $200/月
  - 更高优先级支持
  - 更多高级功能

**对于本项目，Free Plan 完全足够！**

---

## 🎯 总结

**推荐配置**:

1. ✅ 客户端: Cloudflare Pages
2. ✅ WebSocket: api.yourdomain.com (Cloudflare Proxy)
3. ✅ DNS: NameCheap → Cloudflare NameServers
4. ✅ SSL: Cloudflare 自动

**成本**: 完全免费 ✅

**优势**:

- 全球 CDN 加速
- 自动部署
- DDoS 防护
- 免费 SSL

这就是为什么推荐使用 Cloudflare 的原因！
