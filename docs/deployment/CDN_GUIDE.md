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

#### 4. 添加域名到 Cloudflare

**重要**: Cloudflare Pages 要求域名必须在 Cloudflare 账户中管理才能添加为自定义域名。

##### 步骤 A: 将域名添加到 Cloudflare

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. 点击右上角 **"Add a site"**
3. 输入你的域名（例如: `seesawsquad.site`）
4. 选择 **Free Plan** (完全免费)
5. Cloudflare 会扫描你现有的 DNS 记录

##### 步骤 B: 更新 Namecheap 的 Nameservers

1. **在 Cloudflare**，你会看到两个 Nameservers，例如：

   ```
   gail.ns.cloudflare.com
   leif.ns.cloudflare.com
   ```

2. **登录 Namecheap**

   - 进入 **Domain List**
   - 找到你的域名
   - 点击 **Manage**

3. **更新 Nameservers**

   - 选择 **Custom DNS**（而不是 "Namecheap BasicDNS"）
   - 将两个 Cloudflare Nameservers 复制进去
   - 保存更改

4. **等待 DNS 传播**（通常 5-30 分钟，最多 24-48 小时）

##### 步骤 C: 配置 DNS 记录

**重要**: 需要手动设置 WebSocket 服务器的 DNS 记录。

1. 在 Cloudflare Dashboard → 你的域名 → **DNS** → **Records**
2. 添加以下记录：

   **WebSocket 服务器 (必须手动添加)**:

   ```
   类型: A
   名称: api
   内容: [你的 Digital Ocean 服务器 IP]
   代理状态: ✅ 代理已开启 (橙色云)
   TTL: 自动
   ```

3. **主域名和 www（自动配置，见步骤 D）**:
   - `yourdomain.com` → Cloudflare Pages 会自动配置
   - `www.yourdomain.com` → Cloudflare Pages 会自动配置

---

**📋 关于其他 DNS 记录类型的说明**:

当你将域名添加到 Cloudflare 后，可能会看到其他类型的 DNS 记录，它们各有用途：

| 记录类型       | 用途                        | 是否需要修改           | 说明                                            |
| -------------- | --------------------------- | ---------------------- | ----------------------------------------------- |
| **A 记录**     | 将域名映射到 IPv4 地址      | ✅ **你的 `api` 记录** | 指向你的服务器 IP，应开启代理（橙色云）         |
| **MX 记录**    | 邮件服务器配置              | ❌ 不需要              | 用于接收邮件，通常为灰色云（DNS only）          |
| **NS 记录**    | 权威 DNS 服务器             | ❌ 不需要              | 指向 Cloudflare Nameservers，由 Cloudflare 管理 |
| **TXT 记录**   | 文本信息（SPF、域名验证等） | ❌ 不需要              | 用于邮件认证或服务验证，灰色云（DNS only）      |
| **CNAME 记录** | 域名别名                    | ⚠️ Pages 可能创建      | Pages 可能自动创建，通常是橙色云                |

**总结**: 对于这个项目，你只需要关心：

- ✅ `api` A 记录（手动添加，指向服务器）
- ✅ `yourdomain.com` 和 `www`（Pages 自动配置）

其他记录通常不需要修改，除非你有特定需求（如设置邮箱）。

##### 步骤 D: 在 Cloudflare 完成设置

1. 回到 Cloudflare Dashboard
2. 点击 **Continue**（Cloudflare 会验证 Nameservers）
3. 设置 SSL/TLS 模式为 **Full (strict)**
4. 确认 DNS 记录已正确配置

##### 步骤 E: 部署 Pages 并添加自定义域名

1. **确保 Pages 项目已部署**:

   - 进入 **Pages** → 你的项目
   - 检查是否有成功的构建和部署
   - 如果没有，手动触发一次部署或等待自动部署完成

2. **添加自定义域名**:

   - 进入 **Pages** → 你的项目 → **Custom domains**
   - 点击 **"Set up a custom domain"**
   - 添加 `seesawsquad.site`
   - 添加 `www.seesawsquad.site`（可选）
   - Cloudflare Pages 会自动：
     - 为这些域名配置 DNS 记录（CNAME 记录）
     - 生成 SSL 证书
     - 启用 HTTPS

3. **验证 DNS 传播**:
   - 等待 5-30 分钟让 DNS 记录生效
   - 访问 `https://seesawsquad.site` 应该看到你的应用

**⚠️ 如果看到 DNS_PROBE_POSSIBLE 错误**:

- 检查 Pages 项目是否已成功部署
- 确认自定义域名已添加到 Pages
- 等待 DNS 传播（最多 24-48 小时）
- 检查 Cloudflare DNS 记录中是否有 `seesawsquad.site` 的 CNAME 记录（Pages 自动创建）

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
客户端: https://seesawsquad.site          (Cloudflare Pages)
WebSocket: wss://api.seesawsquad.site     (Digital Ocean 服务器)
```

**配置步骤**:

1. **在 Cloudflare DNS 添加 A 记录**（**必须手动设置**）:

   - 进入 Cloudflare Dashboard → 你的域名 → **DNS** → **Records**
   - 点击 **Add record**
   - 设置：
     ```
     类型: A
     名称: api
     内容: [你的 Digital Ocean 服务器 IP 地址]
     代理状态: ✅ 代理已开启 (橙色云图标)
     ```
   - 保存

2. **客户端环境变量**（在 Cloudflare Pages 设置）:
   ```
   VITE_WS_URL=wss://api.seesawsquad.site
   ```

**注意事项**:

- ✅ `api` 子域名必须手动添加 A 记录
- ✅ `yourdomain.com` 和 `www.yourdomain.com` 由 Pages 自动配置（不需要手动添加）
- ✅ 确保代理状态为"已开启"（橙色云），这样才有 DDoS 防护和 SSL

**⚠️ 证书警告说明**:

如果看到 **"This hostname is not covered by a certificate"** 警告：

1. **正常情况** - Cloudflare 正在签发证书（通常 5-30 分钟）

   - 等待一段时间后刷新页面
   - 证书会自动签发和部署
   - 不影响实际功能，只是 UI 显示延迟

2. **检查 SSL/TLS 设置**:

   - Cloudflare Dashboard → **SSL/TLS**
   - 确保模式设置为 **Full (strict)**
   - 确保 **"Always Use HTTPS"** 已启用

3. **验证证书**（等待 30 分钟后）:
   - 访问 `https://api.seesawsquad.site`
   - 如果浏览器显示有效证书（绿色锁图标），说明已成功
   - 警告信息可能需要更长时间才会消失

**如果 24 小时后仍然有问题**:

- 检查服务器是否正确响应 HTTP 请求
- 确保服务器端口 3000 已开放防火墙
- **重要**: 如果遇到 **Error 521**，检查 SSL/TLS 模式（见下方说明）

**⚠️ Error 521 解决方案**:

如果访问 `https://api.seesawsquad.site` 看到 **Error 521: Web server is down**：

1. **检查 SSL/TLS 模式** (最常见原因):

   - Cloudflare Dashboard → SSL/TLS → 加密模式
   - 对于**只有 WebSocket 的服务器**（没有 HTTP/HTTPS 网站），应设置为 **"Flexible"**
   - **"Full (strict)"** 要求源服务器有有效 SSL 证书，但纯 WebSocket 服务器没有

2. **为什么需要 Flexible 模式**:

   - ✅ 用户 ↔ Cloudflare: HTTPS/WSS（加密）
   - ✅ Cloudflare ↔ 源服务器: HTTP/WS（内部网络，Cloudflare 会自动处理加密）
   - ✅ 适用于只有 WebSocket 的服务器

3. **验证**:
   - 修改为 Flexible 后等待 1-2 分钟
   - 再次访问 `https://api.seesawsquad.site`
   - 应该可以正常连接 WebSocket

**⚠️ 如果看到 Nginx 欢迎页面**:

如果你访问 `https://api.seesawsquad.site/` 看到 "Welcome to nginx!" 页面：

**情况 A**: 你使用了 `docker-compose.full.yml`（不推荐）

如果你在 VM 上运行了 `docker-compose -f docker-compose.full.yml up -d`：

1. **检查 Nginx 配置是否正确**:

   - Nginx 应该代理到 `server:3000`（WebSocket 服务器）
   - 不应该显示默认欢迎页面
   - 检查 `nginx-docker.conf` 是否正确挂载

2. **推荐方案**: 停止使用 `docker-compose.full.yml`，改用推荐的 `docker-compose.yml`:
   ```bash
   # 在 VM 上执行
   docker-compose -f docker-compose.full.yml down
   docker-compose up -d
   ```
   然后确保：
   - Cloudflare SSL/TLS 模式设为 **Flexible**
   - `api` DNS 记录指向服务器 IP，代理已开启

**情况 B**: 服务器上安装了独立的 Nginx

如果你没有使用 `docker-compose.full.yml` 但看到 nginx 页面：

1. **检查是否有系统级 Nginx 在运行**:

   ```bash
   # 在 VM 上执行
   sudo systemctl status nginx
   docker ps | grep nginx
   ```

2. **停止系统 Nginx**（如果不需要）:

   ```bash
   sudo systemctl stop nginx
   sudo systemctl disable nginx
   ```

3. **确保只有 Docker 容器在运行**:
   - WebSocket 服务器应该直接监听 3000 端口
   - 不需要 Nginx，因为 Cloudflare 已经处理了代理和 SSL

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

**重要**: SSL/TLS 模式取决于你的服务器配置：

#### 情况 1: 只有 WebSocket 服务器（推荐配置）✅

如果你的服务器**只有 WebSocket 服务**（没有 HTTP/HTTPS 网站，如本项目）：

1. 进入 Cloudflare → SSL/TLS
2. 设置：
   - **加密模式**: **Flexible** ✅（不是 Full strict）
   - **自动 HTTPS 重写**: 启用
   - **始终使用 HTTPS**: 启用
   - **最小 TLS 版本**: 1.2

**为什么使用 Flexible**:

- ✅ 用户到 Cloudflare: HTTPS/WSS（完全加密）
- ✅ Cloudflare 到源服务器: HTTP/WS（内部网络，Cloudflare 负责加密）
- ✅ 不需要在源服务器配置 SSL 证书
- ✅ 适合纯 WebSocket 服务器

#### 情况 2: 有 HTTP/HTTPS 网站的服务器

如果你的服务器同时运行 HTTP 网站（如 Nginx + SSL）：

1. 进入 Cloudflare → SSL/TLS
2. 设置：
   - **加密模式**: **Full** 或 **Full (strict)** ✅
   - **自动 HTTPS 重写**: 启用
   - **始终使用 HTTPS**: 启用
   - **最小 TLS 版本**: 1.2

**Full vs Full (strict)**:

- **Full**: Cloudflare 接受任何 SSL 证书（包括自签名）
- **Full (strict)**: 源服务器必须有有效、受信任的 SSL 证书

### 服务器 SSL (如果直接访问)

如果用户可能直接访问服务器 IP（不使用 Cloudflare），需要配置 Let's Encrypt：

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d api.yourdomain.com
```

**但对于纯 WebSocket 服务器，通常不需要这个步骤**，因为：

- 用户通过 Cloudflare 访问（已加密）
- 不需要直接访问服务器 IP

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
- [ ] **`api` 子域名 A 记录已手动添加**（指向服务器 IP）
- [ ] `api` 记录的代理状态为"已开启"（橙色云）
- [ ] DNS 传播完成（24-48 小时）
- [ ] 主域名和 www 由 Pages 自动配置（无需手动添加）

### SSL/TLS

- [ ] **加密模式: Flexible**（对于纯 WebSocket 服务器）
  - ⚠️ 如果是 Full (strict) 且遇到 Error 521，改为 Flexible
- [ ] 自动 HTTPS 重写: 启用
- [ ] 始终使用 HTTPS: 启用

### WebSocket

- [ ] **`api` 子域名 DNS A 记录已添加**（最重要！）
- [ ] `api` 记录 Proxy 已启用（橙色云）
- [ ] 客户端环境变量 `VITE_WS_URL` 已设置

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
