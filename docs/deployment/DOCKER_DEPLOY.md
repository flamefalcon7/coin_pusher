# 🐳 Docker 部署指南

使用 Docker/Docker Compose 可以大幅简化部署流程，提供环境一致性和易于扩展的优势。

## 📋 概述

### Docker 方案优势

✅ **环境一致性** - 开发、测试、生产环境完全相同  
✅ **简化部署** - 一条命令完成部署  
✅ **易于扩展** - 轻松横向扩展  
✅ **快速回滚** - 保留多个版本的镜像  
✅ **隔离性** - 不污染宿主机环境  
✅ **资源控制** - 可限制 CPU/内存使用

### 架构

```
┌──────────────────────────────┐
│  Cloudflare CDN (静态文件)    │
└──────────────┬───────────────┘
               │ HTTPS
┌──────────────▼───────────────┐
│  Nginx Container (80/443)    │
│  - 反向代理                   │
│  - SSL 终止                   │
└──────────────┬───────────────┘
               │
┌──────────────▼───────────────┐
│  Server Container (3000)     │
│  - Node.js 20                │
│  - Rapier Physics            │
│  - WebSocket                 │
└──────────────────────────────┘
```

---

## 🚀 快速开始

### 前置要求

- ✅ Docker Engine 20.10+
- ✅ Docker Compose 2.0+
- ✅ Git

### 安装 Docker（Digital Ocean Droplet）

```bash
# 更新系统
sudo apt update && sudo apt upgrade -y

# 安装 Docker
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# 添加用户到 docker 组（可选）
sudo usermod -aG docker $USER
newgrp docker

# 安装 Docker Compose
sudo curl -L "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# 验证安装
docker --version
docker-compose --version
```

---

## 📦 部署步骤

### 方案 A: 仅部署服务器（推荐）

客户端使用 Cloudflare Pages，服务器使用 Docker。

#### 1. 克隆代码

```bash
mkdir -p /var/www
cd /var/www
git clone https://github.com/YOUR_USERNAME/coin_pusher.git
cd coin_pusher
```

#### 2. 构建并启动

```bash
# 构建镜像
docker build -t coin-pusher-server .

# 启动容器
docker run -d \
  --name coin-pusher-server \
  --restart unless-stopped \
  -p 3000:3000 \
  -e NODE_ENV=production \
  coin-pusher-server

# 查看日志
docker logs -f coin-pusher-server
```

#### 3. 使用 Docker Compose（推荐，更简单）

项目已包含 `docker-compose.yml`，直接使用：

```bash
docker-compose up -d
```

此配置文件仅包含服务器容器，适用于与 Cloudflare Pages 配合使用。

---

### 方案 B: 完整部署（服务器 + Nginx）⚠️ 不推荐

**注意**: 此方案仅在特殊需求时使用（见[配置文件选择](#-docker-compose-配置文件选择)）。推荐使用方案 A + Cloudflare Pages。

包含 Nginx 反向代理和静态文件服务。

#### 1. 构建客户端

```bash
# 在本地或 CI/CD 中构建
cd client
pnpm install
pnpm build
```

#### 2. 启动完整栈

使用 `docker-compose.full.yml`：

```bash
docker-compose -f docker-compose.full.yml up -d
```

这会启动：

- Server 容器（端口 3000，内部）
- Nginx 容器（端口 80, 443，暴露给外部）

Nginx 配置文件使用项目中的 `nginx-docker.conf`。

---

## 🔄 CI/CD 集成

### GitHub Actions 自动部署

更新 `.github/workflows/deploy-docker.yml`:

```yaml
name: Deploy with Docker

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Deploy to server
        uses: appleboy/ssh-action@master
        with:
          host: ${{ secrets.DEPLOY_HOST }}
          username: ${{ secrets.DEPLOY_USER }}
          key: ${{ secrets.DEPLOY_KEY }}
          script: |
            cd /var/www/coin_pusher
            git pull origin main
            docker-compose down
            docker-compose build --no-cache
            docker-compose up -d
            docker system prune -f
```

---

## 📊 管理命令

### 常用命令

```bash
# 查看运行状态
docker-compose ps

# 查看日志
docker-compose logs -f server

# 重启服务
docker-compose restart server

# 停止所有服务
docker-compose down

# 停止并删除数据卷
docker-compose down -v

# 更新并重启
git pull
docker-compose up -d --build

# 查看资源使用
docker stats coin-pusher-server
```

### 清理命令

```bash
# 删除未使用的镜像
docker image prune -a

# 删除未使用的容器
docker container prune

# 完全清理（谨慎使用）
docker system prune -a --volumes
```

---

## 🔧 配置和环境变量

### 创建 `.env` 文件

```bash
# Server
NODE_ENV=production
PORT=3000

# Logging
LOG_LEVEL=info

# 如果需要其他配置
# REDIS_URL=redis://redis:6379
# DATABASE_URL=postgresql://...
```

### 使用环境变量

在 `docker-compose.yml` 中：

```yaml
services:
  server:
    env_file:
      - .env
    # 或
    environment:
      - NODE_ENV=${NODE_ENV:-production}
      - PORT=${PORT:-3000}
```

---

## 📈 监控和日志

### 查看日志

```bash
# 实时日志
docker-compose logs -f

# 只看 server
docker-compose logs -f server

# 最近 100 行
docker-compose logs --tail=100 server

# 带时间戳
docker-compose logs -f --timestamps server
```

### 资源监控

```bash
# 实时资源使用
docker stats

# 单个容器
docker stats coin-pusher-server
```

### 日志管理

Docker 日志会自动轮转（配置在 `docker-compose.yml` 中）：

```yaml
logging:
  driver: "json-file"
  options:
    max-size: "10m" # 单文件最大 10MB
    max-file: "3" # 保留 3 个文件
```

---

## 🔄 更新和回滚

### 更新流程

```bash
# 1. 拉取最新代码
git pull origin main

# 2. 重新构建
docker-compose build --no-cache server

# 3. 重启服务（零停机）
docker-compose up -d --no-deps server

# 4. 清理旧镜像
docker image prune -f
```

### 回滚到上一个版本

```bash
# 1. 查看历史镜像
docker images

# 2. 停止当前容器
docker-compose down

# 3. 使用旧镜像启动
docker run -d --name coin-pusher-server -p 3000:3000 coin-pusher-server:old-tag

# 或回滚 Git 代码后重新构建
git checkout <previous-commit>
docker-compose up -d --build
```

### 版本标记

```bash
# 构建时打标签
docker build -t coin-pusher-server:v1.0.0 .
docker build -t coin-pusher-server:latest .

# 推送到 Docker Hub (可选)
docker tag coin-pusher-server:latest username/coin-pusher-server:latest
docker push username/coin-pusher-server:latest
```

---

## 🎯 生产优化

### 多阶段构建（已实现）

`Dockerfile` 使用多阶段构建：

- Stage 1: 构建 shared
- Stage 2: 构建 server
- Stage 3: 生产镜像（仅包含运行时）

优势：

- 镜像体积小（~150MB vs ~500MB）
- 不包含开发依赖
- 构建层缓存优化

### 健康检查

已在 `Dockerfile` 和 `docker-compose.yml` 中配置：

```yaml
healthcheck:
  test:
    [
      "CMD",
      "node",
      "-e",
      "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})",
    ]
  interval: 30s
  timeout: 3s
  retries: 3
  start_period: 10s
```

需要在服务器添加健康检查端点：

```typescript
// server/src/index.ts
app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});
```

### 资源限制

在 `docker-compose.yml` 中添加：

```yaml
services:
  server:
    deploy:
      resources:
        limits:
          cpus: "1.0"
          memory: 512M
        reservations:
          cpus: "0.5"
          memory: 256M
```

---

## 🔐 安全最佳实践

### 1. 使用非 root 用户

更新 `Dockerfile`:

```dockerfile
# Create app user
RUN addgroup -g 1001 -S nodejs && adduser -S nodejs -u 1001

# Change ownership
RUN chown -R nodejs:nodejs /app

# Switch to nodejs user
USER nodejs
```

### 2. 最小化镜像

- ✅ 使用 Alpine 基础镜像
- ✅ 多阶段构建
- ✅ 只安装生产依赖
- ✅ 删除不必要的文件

### 3. 扫描漏洞

```bash
# 使用 Docker Scout
docker scout cves coin-pusher-server

# 使用 Trivy
trivy image coin-pusher-server
```

### 4. 环境变量安全

```bash
# 不要在 Dockerfile 中硬编码密钥
# 使用 .env 文件（加入 .gitignore）
# 或使用 Docker secrets
```

---

## 🚢 水平扩展

### 使用 Docker Swarm（简单）

```bash
# 初始化 Swarm
docker swarm init

# 部署服务（3 个副本）
docker stack deploy -c docker-compose.yml coin-pusher

# 扩展
docker service scale coin-pusher_server=5
```

### 使用 Kubernetes（高级）

如果需要更强大的编排，可以迁移到 Kubernetes。

---

## 📝 对比：Docker vs 传统部署

| 特性           | Docker 部署      | 传统部署      |
| -------------- | ---------------- | ------------- |
| **环境一致性** | ✅ 完全一致      | ⚠️ 可能不同   |
| **部署时间**   | ✅ 1-2 分钟      | ⚠️ 5-10 分钟  |
| **依赖管理**   | ✅ 容器内隔离    | ⚠️ 全局安装   |
| **回滚速度**   | ✅ 秒级          | ⚠️ 分钟级     |
| **资源隔离**   | ✅ 完全隔离      | ❌ 共享资源   |
| **学习曲线**   | ⚠️ 需要学 Docker | ✅ 熟悉的工具 |
| **资源开销**   | ⚠️ 稍高 (~50MB)  | ✅ 最小       |
| **调试难度**   | ⚠️ 稍难          | ✅ 直接       |

---

## 📁 Docker Compose 配置文件选择

### `docker-compose.yml` (推荐) ✅

**使用场景**: 默认配置，99% 情况使用

```
架构:
Cloudflare Pages (客户端) → VM:3000 (服务器容器)
```

**优点**:

- ✅ 最简单，少一个组件（少一个故障点）
- ✅ 延迟最低（直接连接，无代理层）
- ✅ Cloudflare 已处理 SSL、CDN、DDoS 防护
- ✅ 适合单服务器部署

**部署命令**:

```bash
docker-compose up -d
```

**更新命令**:

```bash
git pull && docker-compose up -d --build
```

---

### `docker-compose.full.yml` (不推荐) ⚠️

**为什么不推荐**:

- ❌ 多一层 Nginx 代理（增加延迟 +1-2ms）
- ❌ 占用额外内存（~50MB Nginx 容器）
- ❌ 增加复杂度（多一个组件需维护）
- ❌ Cloudflare 已提供 Nginx 的大部分功能

**未来可能需要使用的场景**:

1. **多服务器负载均衡** - 需要 Nginx 分发流量到多个服务器实例
2. **微服务架构** - 需要路由不同路径到不同服务 (`/game`, `/chat`, `/api`)
3. **不想使用 Cloudflare Pages** - 需要在同一服务器部署客户端静态文件
4. **更细粒度控制** - 需要 Nginx 级别的速率限制、日志、Header 操作

**如果必须使用**:

```bash
docker-compose -f docker-compose.full.yml up -d
```

---

## 🎯 推荐部署方案

### 小规模（1-100 用户）

```
Docker 单容器 + Cloudflare Pages
成本: $12/月
```

**配置文件**: `docker-compose.yml`

**优点**:

- 简单易管理
- 快速部署
- 环境一致
- 最低延迟

**部署命令**:

```bash
docker-compose up -d
```

### 中规模（100-500 用户）

```
Docker Compose (Server) + Cloudflare
成本: $12/月
```

**配置文件**: `docker-compose.yml` (仍然使用简化版)

**优点**:

- 保持简单
- Cloudflare 处理所有边缘功能
- 易于扩展

**部署命令**:

```bash
docker-compose up -d
```

**如果未来需要负载均衡**:

```bash
# 升级到多服务器架构
docker-compose -f docker-compose.full.yml up -d
```

### 大规模（500+ 用户）

```
Docker Swarm 或 Kubernetes
成本: $150+/月
```

**优点**:

- 自动扩展
- 高可用性
- 负载均衡

---

## 💰 成本对比

| 方案                      | 服务器      | 额外成本 | 总成本/月 |
| ------------------------- | ----------- | -------- | --------- |
| **Docker 单容器**         | $12 (2GB)   | $0       | **$12**   |
| **Docker + Nginx**        | $12 (2GB)   | $0       | **$12**   |
| **Docker Swarm (3 节点)** | $36 (3×2GB) | $0       | **$36**   |

Docker 本身不增加成本，反而提高效率！

---

## 📚 相关命令参考

### Dockerfile 命令

```bash
# 构建
docker build -t coin-pusher-server .

# 指定标签
docker build -t coin-pusher-server:v1.0 .

# 不使用缓存
docker build --no-cache -t coin-pusher-server .

# 查看构建历史
docker history coin-pusher-server
```

### Docker Compose 命令

```bash
# 启动（后台）
docker-compose up -d

# 查看状态
docker-compose ps

# 查看日志
docker-compose logs -f

# 停止
docker-compose stop

# 停止并删除
docker-compose down

# 重启单个服务
docker-compose restart server

# 重新构建并启动
docker-compose up -d --build
```

---

## ✅ 部署检查清单

### Docker 环境

- [ ] Docker Engine 安装
- [ ] Docker Compose 安装
- [ ] 用户加入 docker 组

### 代码准备

- [ ] Git clone 完成
- [ ] Dockerfile 存在
- [ ] docker-compose.yml 配置正确
- [ ] .dockerignore 配置

### 构建和运行

- [ ] `docker build` 成功
- [ ] `docker-compose up` 成功
- [ ] 容器健康检查通过
- [ ] 端口 3000 可访问

### 网络配置

- [ ] Cloudflare DNS 配置
- [ ] 防火墙规则设置
- [ ] SSL 证书配置（如需要）

### 监控和日志

- [ ] 日志轮转配置
- [ ] 资源监控设置
- [ ] 告警配置（可选）

---

## 🎉 总结

### Docker 部署的核心优势

1. **一条命令部署**

   ```bash
   docker-compose up -d
   ```

2. **一条命令更新**

   ```bash
   git pull && docker-compose up -d --build
   ```

3. **一条命令回滚**
   ```bash
   docker-compose down && docker-compose up -d
   ```

### 相比传统部署节省的时间

| 任务         | 传统部署   | Docker 部署 | 节省    |
| ------------ | ---------- | ----------- | ------- |
| **初次部署** | 15-20 分钟 | 3-5 分钟    | **75%** |
| **更新部署** | 5-10 分钟  | 1-2 分钟    | **80%** |
| **回滚**     | 10-15 分钟 | 30 秒       | **95%** |

**推荐使用 Docker！** 🐳
