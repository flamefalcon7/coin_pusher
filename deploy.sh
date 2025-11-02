#!/bin/bash

# Manual deployment script for Digital Ocean
# Usage: ./deploy.sh [server_user] [server_host]

set -e

SERVER_USER=${1:-root}
SERVER_HOST=${2:-"YOUR_DROPLET_IP"}

echo "🚀 Starting deployment to $SERVER_USER@$SERVER_HOST"

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Build locally
echo -e "${YELLOW}📦 Building project...${NC}"
pnpm install --frozen-lockfile
pnpm build

# Copy files to server
echo -e "${YELLOW}📤 Copying files to server...${NC}"
scp -r server/dist/* $SERVER_USER@$SERVER_HOST:/var/www/coin-pusher/server/dist/
scp -r client/dist/* $SERVER_USER@$SERVER_HOST:/var/www/coin-pusher/client/dist/
scp -r shared/dist/* $SERVER_USER@$SERVER_HOST:/var/www/coin-pusher/shared/dist/
scp package.json pnpm-lock.yaml pnpm-workspace.yaml $SERVER_USER@$SERVER_HOST:/var/www/coin-pusher/

# Deploy on server
echo -e "${YELLOW}🔧 Installing dependencies and restarting...${NC}"
ssh $SERVER_USER@$SERVER_HOST << 'EOF'
  set -e
  cd /var/www/coin-pusher
  
  echo "📦 Installing dependencies..."
  pnpm install --frozen-lockfile --prod=false
  
  echo "🔄 Restarting PM2..."
  pm2 restart coin-pusher-server || pm2 start ecosystem.config.js
  
  echo "💾 Saving PM2 configuration..."
  pm2 save
  
  echo "📊 PM2 Status:"
  pm2 status
EOF

echo -e "${GREEN}✅ Deployment completed!${NC}"

