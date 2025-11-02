# ⚡ 快速部署指南

## 🎯 5 分钟快速开始

### 前置条件

- [ ] Digital Ocean Droplet (已创建)
- [ ] GitHub 仓库 (已准备)
- [ ] 域名 (NameCheap)
- [ ] Cloudflare 账户 (免费注册)

---

## 📋 部署步骤速查

### 1. 服务器初始化 (5 分钟)

```bash
# SSH 到服务器
ssh root@YOUR_DROPLET_IP

# 快速安装
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs nginx git
sudo npm install -g pm2 pnpm

# 创建应用目录
mkdir -p /var/www/coin-pusher
cd /var/www/coin-pusher
```

### 2. 配置 GitHub Secrets (2 分钟)

在 GitHub 仓库 → Settings → Secrets and variables → Actions 添加：

```
DEPLOY_HOST=YOUR_DROPLET_IP
DEPLOY_USER=root
DEPLOY_KEY=你的SSH私钥
```

### 3. 配置 CI/CD (自动)

首次 push 到 `main` 分支会自动触发部署。

### 4. Cloudflare Pages (3 分钟)

1. Cloudflare Dashboard → Pages → Create project
2. Connect to Git → 选择仓库
3. 构建设置：
   ```
   Build command: cd client && pnpm install && pnpm build
   Output directory: client/dist
   ```
4. 环境变量：
   ```
   VITE_WS_URL=wss://api.yourdomain.com
   ```

### 5. DNS 配置 (5 分钟)

**在 Cloudflare**:
- 添加 A 记录: `api` → YOUR_DROPLET_IP (✅ Proxy)

**在 NameCheap**:
- 更新 NameServers 到 Cloudflare 提供的两个地址

---

## ✅ 验证清单

- [ ] 服务器运行: `pm2 status` 显示 online
- [ ] 网站访问: `https://yourdomain.com` 正常
- [ ] WebSocket: 浏览器 Console 无错误
- [ ] SSL: 显示绿色锁 🔒

---

## 🔧 配置文件位置

所有配置文件都在项目根目录：

```
coin_pusher/
├── ecosystem.config.js      # PM2 配置
├── nginx.conf                # Nginx 配置模板
├── deploy.sh                 # 手动部署脚本
└── .github/workflows/
    ├── deploy.yml            # 服务器部署
    └── deploy-client.yml     # 客户端部署
```

---

## 📝 重要提醒

### ⚠️ 替换域名占位符

在以下文件中替换 `example.com` 为你的实际域名：

1. `.github/workflows/deploy.yml`
   ```yaml
   VITE_WS_URL: wss://api.example.com  # ← 替换
   ```

2. `.github/workflows/deploy-client.yml`
   ```yaml
   VITE_WS_URL: wss://api.example.com  # ← 替换
   ```

3. `nginx.conf`
   ```nginx
   server_name api.example.com;  # ← 替换
   server_name example.com;      # ← 替换
   ```

---

## 🆘 遇到问题？

### 常见问题

1. **502 Bad Gateway**
   ```bash
   pm2 restart coin-pusher-server
   sudo nginx -t
   ```

2. **WebSocket 连接失败**
   - 检查 Cloudflare DNS 记录
   - 确认 Proxy 已启用（橙色云）
   - 检查 Nginx 配置

3. **DNS 不生效**
   - 等待 24-48 小时
   - 清除本地 DNS 缓存
   - 使用 `dig yourdomain.com` 检查

### 详细文档

- 完整部署指南: `docs/deployment/DIGITALOCEAN_DEPLOY.md`
- CDN 配置: `docs/deployment/CDN_GUIDE.md`
- 资源评估: `docs/deployment/CLOUD_RESOURCES.md`

---

## 🎉 完成！

部署成功后，你的游戏应该可以通过 `https://yourdomain.com` 访问了！

