# 🚀 Digital Ocean 部署指南

## 📋 概述

本指南将带你完成从本地开发到 Digital Ocean 生产环境的完整部署流程。

## 🏗️ 架构方案

```
┌─────────────────────────┐
│  Cloudflare CDN         │
│  - 静态文件托管          │
│  - DDoS 防护            │
│  - SSL 证书             │
│  成本: 免费              │
└──────────┬──────────────┘
           │ HTTPS
┌──────────▼──────────────┐
│  Digital Ocean Droplet   │
│  - Node.js 服务器        │
│  - PM2 进程管理          │
│  - Nginx 反向代理        │
│  成本: $12-24/月         │
└─────────────────────────┘
           │
┌──────────▼──────────────┐
│  NameCheap DNS           │
│  - A Record → Droplet IP │
│  - CNAME → Cloudflare    │
└─────────────────────────┘
```

## ✅ 部署前准备

### 1. 需要的账户

- ✅ Digital Ocean 账户
- ✅ GitHub 账户（用于 CI/CD）
- ✅ NameCheap 账户（已有域名）
- ✅ Cloudflare 账户（免费 CDN）

### 2. 准备信息

- 域名名称（例如：example.com）
- Digital Ocean API Token
- SSH 密钥对

---

## 📦 步骤 1: 创建 Digital Ocean Droplet

### 1.1 登录 Digital Ocean

访问 [Digital Ocean](https://www.digitalocean.com/)

### 1.2 创建 Droplet

**配置选择**:

```
- Image: Ubuntu 22.04 LTS
- Plan: Basic
  └─ Regular (Shared CPU)
     └─ $12/月: 2 GB RAM / 1 vCPU
     └─ $24/月: 4 GB RAM / 2 vCPU (推荐，如果 > 100 用户)
- Region: 选择最接近用户的区域
  └─ 亚洲: Singapore / Bangalore
  └─ 美国: New York / San Francisco
  └─ 欧洲: London / Frankfurt
- Authentication: SSH Keys (推荐)
  └─ 添加你的公钥
- Hostname: coin-pusher-server
```

### 1.3 记录服务器信息

保存以下信息：

```
- Droplet IP: xxx.xxx.xxx.xxx
- Root 密码: (如果使用密码认证)
```

---

## 🔐 步骤 2: 服务器初始设置

### 2.1 SSH 连接到服务器

```bash
ssh root@YOUR_DROPLET_IP
```

### 2.2 更新系统

```bash
apt update && apt upgrade -y
```

### 2.3 创建非 root 用户（可选但推荐）

```bash
adduser deploy
usermod -aG sudo deploy
su - deploy
```

### 2.4 安装 Node.js 20

```bash
# 使用 NodeSource 安装 Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# 验证安装
node --version  # 应该显示 v20.x.x
npm --version
```

### 2.5 安装 PM2

```bash
sudo npm install -g pm2
```

### 2.6 安装 Nginx

```bash
sudo apt install -y nginx
sudo systemctl enable nginx
sudo systemctl start nginx
```

### 2.7 安装 Git

```bash
sudo apt install -y git
```

### 2.8 安装 pnpm

```bash
sudo npm install -g pnpm
```

---

## 🌐 步骤 3: 配置 Cloudflare CDN

### 3.1 创建 Cloudflare 账户

访问 [Cloudflare](https://dash.cloudflare.com/sign-up)

### 3.2 添加网站

1. 点击 "Add a Site"
2. 输入你的域名
3. 选择 Free Plan
4. 按照提示完成验证

### 3.3 更新 DNS 记录

Cloudflare 会扫描现有 DNS 记录。你需要：

**删除或修改**:

- 所有 A 记录（临时）

**等待 Cloudflare 配置完成后，在步骤 7 会添加正确的记录**

### 3.4 更新 NameServer

Cloudflare 会提供两个 NameServer，例如：

```
lara.ns.cloudflare.com
andres.ns.cloudflare.com
```

在 NameCheap 中更新：

1. 登录 NameCheap
2. 进入域名管理
3. 找到 "Nameservers" 部分
4. 选择 "Custom DNS"
5. 输入 Cloudflare 提供的两个 NameServer
6. 保存

**注意**: DNS 更新可能需要 24-48 小时生效，通常几分钟到几小时。

---

## 🔧 步骤 4: 配置服务器应用

### 4.1 创建应用目录

```bash
mkdir -p /var/www/coin-pusher
cd /var/www/coin-pusher
```

### 4.2 克隆代码（或使用 CI/CD）

**方式 A: 手动克隆（测试用）**

```bash
git clone https://github.com/YOUR_USERNAME/coin_pusher.git .
```

**方式 B: 使用 CI/CD（推荐，见步骤 5）**
先跳过，等 CI/CD 配置完成后会自动部署

### 4.3 安装依赖

```bash
pnpm install --frozen-lockfile
```

### 4.4 构建项目

```bash
pnpm build
```

### 4.5 创建环境变量文件

```bash
nano /var/www/coin-pusher/server/.env
```

内容：

```bash
PORT=3000
NODE_ENV=production
```

### 4.6 配置 PM2

创建 PM2 配置文件：

```bash
nano /var/www/coin-pusher/ecosystem.config.js
```

内容见 `ecosystem.config.js` 文件（会在下一步创建）

---

## 🔄 步骤 5: 配置 CI/CD (GitHub Actions)

### 5.1 创建 GitHub Actions 工作流

在项目中创建 `.github/workflows/deploy.yml`（见下一步）

### 5.2 添加 GitHub Secrets

在 GitHub 仓库设置中添加：

1. 进入仓库 → Settings → Secrets and variables → Actions
2. 添加以下 Secrets：

```
DEPLOY_HOST: YOUR_DROPLET_IP
DEPLOY_USER: root (或 deploy)
DEPLOY_KEY: 你的 SSH 私钥内容
```

**获取 SSH 私钥**:

```bash
# 在本地机器
cat ~/.ssh/id_rsa
# 复制整个内容（包括 -----BEGIN 和 -----END）
```

### 5.3 推送代码触发部署

```bash
git add .
git commit -m "Add deployment config"
git push origin main
```

首次推送后，GitHub Actions 会自动：

1. 构建项目
2. 测试
3. SSH 到服务器
4. 拉取最新代码
5. 安装依赖
6. 构建
7. 重启 PM2

---

## 🌐 步骤 6: 配置 Nginx

### 6.1 创建 Nginx 配置

```bash
sudo nano /etc/nginx/sites-available/coin-pusher
```

配置文件内容见 `nginx.conf`（会在下一步创建）

### 6.2 启用配置

```bash
sudo ln -s /etc/nginx/sites-available/coin-pusher /etc/nginx/sites-enabled/
sudo nginx -t  # 测试配置
sudo systemctl reload nginx
```

### 6.3 配置防火墙

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
sudo ufw status
```

---

## 🔗 步骤 7: 配置 DNS 记录

### 7.1 在 Cloudflare 添加 DNS 记录

进入 Cloudflare Dashboard → 你的域名 → DNS → Records

**添加记录**:

| Type  | Name | Content         | Proxy      | TTL  |
| ----- | ---- | --------------- | ---------- | ---- |
| A     | @    | YOUR_DROPLET_IP | ✅ Proxied | Auto |
| A     | api  | YOUR_DROPLET_IP | ✅ Proxied | Auto |
| CNAME | www  | example.com     | ✅ Proxied | Auto |

**说明**:

- `@` = 根域名 (example.com)
- `api` = WebSocket 服务器 (api.example.com)
- `www` = www 子域名 (www.example.com)
- **Proxy (橙色云)**: 启用 Cloudflare CDN 和 DDoS 防护

### 7.2 SSL/TLS 设置

进入 Cloudflare → SSL/TLS:

- **加密模式**: Full (strict) ✅
- **自动 HTTPS 重写**: 启用
- **始终使用 HTTPS**: 启用

---

## 📦 步骤 8: 部署客户端到 Cloudflare Pages

### 8.1 连接 GitHub 仓库

1. 进入 Cloudflare Dashboard → Pages
2. 点击 "Create a project" → "Connect to Git"
3. 选择你的 GitHub 仓库

### 8.2 构建设置

```
Framework preset: Vite
Build command: cd client && pnpm install && pnpm build
Build output directory: client/dist
Root directory: /
```

### 8.3 环境变量

在 Pages 设置中添加：

```
VITE_WS_URL=wss://api.example.com
```

### 8.4 自定义域名

在 Pages 设置 → Custom domains:

- 添加: `example.com`
- 添加: `www.example.com`

Cloudflare 会自动配置 DNS 和 SSL。

---

## ✅ 步骤 9: 验证部署

### 9.1 检查服务器

```bash
# SSH 到服务器
ssh root@YOUR_DROPLET_IP

# 检查 PM2
pm2 status
pm2 logs

# 检查 Nginx
sudo systemctl status nginx
sudo nginx -t
```

### 9.2 检查网站

1. 访问 `https://example.com` - 应该看到游戏
2. 打开浏览器 DevTools → Console
3. 检查是否有 WebSocket 连接错误
4. 检查网络请求是否通过 HTTPS

### 9.3 测试 WebSocket

使用测试工具或直接在浏览器控制台：

```javascript
const ws = new WebSocket("wss://api.example.com");
ws.onopen = () => console.log("Connected!");
```

---

## 🔍 故障排查

### 问题 1: 502 Bad Gateway

**原因**: Nginx 无法连接到 Node.js

**解决**:

```bash
# 检查 PM2 是否运行
pm2 status

# 检查端口是否监听
sudo netstat -tlnp | grep 3000

# 重启服务
pm2 restart coin-pusher-server
sudo systemctl reload nginx
```

### 问题 2: WebSocket 连接失败

**原因**: Cloudflare 可能需要额外配置

**解决**:

1. Cloudflare → Rules → Transform Rules
2. 创建规则：
   - When: `http.request.uri.path starts_with "/ws"`
   - Then: Set `WebSocket: On`

或使用单独的 WebSocket 子域名（推荐）

### 问题 3: DNS 不生效

**原因**: DNS 传播延迟

**解决**:

```bash
# 检查 DNS
dig example.com
nslookup example.com

# 等待 24-48 小时
# 或清除本地 DNS 缓存
```

### 问题 4: 403 Forbidden

**原因**: 文件权限问题

**解决**:

```bash
sudo chown -R www-data:www-data /var/www/coin-pusher/client/dist
sudo chmod -R 755 /var/www/coin-pusher/client/dist
```

---

## 📊 监控和维护

### PM2 监控

```bash
# 查看状态
pm2 status

# 查看日志
pm2 logs coin-pusher-server

# 查看资源使用
pm2 monit

# 保存配置（自动启动）
pm2 save
pm2 startup
```

### Nginx 日志

```bash
# 访问日志
sudo tail -f /var/log/nginx/access.log

# 错误日志
sudo tail -f /var/log/nginx/error.log
```

### 服务器监控

Digital Ocean 提供基础监控：

- CPU 使用率
- 内存使用率
- 带宽使用

访问: Droplet → Monitoring

---

## 🔄 更新部署

### 手动更新

```bash
ssh root@YOUR_DROPLET_IP
cd /var/www/coin-pusher
git pull origin main
pnpm install --frozen-lockfile
pnpm build
pm2 restart coin-pusher-server
```

### 自动更新（CI/CD）

推送代码到 `main` 分支，GitHub Actions 会自动：

1. 构建
2. 测试
3. 部署
4. 重启服务

---

## 💰 成本总结

| 组件     | 服务                        | 成本/月    |
| -------- | --------------------------- | ---------- |
| 服务器   | Digital Ocean Droplet (2GB) | $12        |
| CDN      | Cloudflare Pages            | 免费       |
| DNS      | NameCheap (已购买)          | $0         |
| SSL      | Cloudflare (自动)           | 免费       |
| **总计** |                             | **$12/月** |

升级到 4GB Droplet: **$24/月**

---

## 📝 部署检查清单

### 服务器设置

- [ ] Digital Ocean Droplet 创建
- [ ] Node.js 20 安装
- [ ] PM2 安装
- [ ] Nginx 安装
- [ ] Git 安装
- [ ] pnpm 安装
- [ ] 防火墙配置

### 应用部署

- [ ] 代码部署
- [ ] 依赖安装
- [ ] 构建成功
- [ ] PM2 配置
- [ ] 环境变量设置
- [ ] 服务运行正常

### 网络配置

- [ ] Cloudflare 配置
- [ ] NameServer 更新
- [ ] DNS 记录配置
- [ ] SSL 证书生效
- [ ] Nginx 反向代理
- [ ] WebSocket 代理工作

### CDN 配置

- [ ] Cloudflare Pages 部署
- [ ] 构建配置正确
- [ ] 环境变量设置
- [ ] 自定义域名绑定
- [ ] HTTPS 启用

### 验证测试

- [ ] 网站可访问 (HTTPS)
- [ ] WebSocket 连接成功
- [ ] 游戏正常运行
- [ ] 日志无错误
- [ ] 性能正常

---

## 🎉 完成！

部署完成后，你的游戏应该可以通过 `https://example.com` 访问了！

如有问题，参考故障排查部分或查看日志。
