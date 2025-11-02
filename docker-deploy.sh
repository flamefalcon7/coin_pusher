#!/bin/bash

# Docker deployment script for Coin Pusher
# Usage: ./docker-deploy.sh [server_user] [server_host]

set -e

SERVER_USER=${1:-root}
SERVER_HOST=${2:-"YOUR_DROPLET_IP"}

echo "🐳 Starting Docker deployment to $SERVER_USER@$SERVER_HOST"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Deploy via SSH
echo -e "${YELLOW}📤 Deploying to server...${NC}"
ssh $SERVER_USER@$SERVER_HOST << 'EOF'
  set -e
  
  cd /var/www/coin_pusher
  
  echo "📥 Pulling latest code..."
  git pull origin main
  
  echo "⏸️  Stopping current containers..."
  docker-compose down
  
  echo "🔨 Building new Docker image..."
  docker-compose build --no-cache server
  
  echo "▶️  Starting containers..."
  docker-compose up -d
  
  echo "🏥 Waiting for health check..."
  sleep 10
  
  echo "📊 Container status:"
  docker-compose ps
  
  echo "🧹 Cleaning up old images..."
  docker image prune -f
  
  echo "📝 Recent logs:"
  docker-compose logs --tail 20 server
EOF

echo -e "${GREEN}✅ Deployment completed!${NC}"

# Show status
echo -e "${YELLOW}📊 Checking deployment status...${NC}"
ssh $SERVER_USER@$SERVER_HOST "docker ps --filter name=coin-pusher-server"

echo -e "${GREEN}🎉 Docker deployment successful!${NC}"

