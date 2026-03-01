#!/usr/bin/env bash
# One-time provisioning for the Game server droplet.
# Run as root on a fresh Ubuntu 22.04+ droplet.
set -euo pipefail

APP_DIR="/opt/coin_pusher"
DEPLOY_USER="deploy"

echo "=== 1. Install Docker ==="
if ! command -v docker &>/dev/null; then
  apt-get update
  apt-get install -y ca-certificates curl gnupg
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  echo "Docker already installed, skipping."
fi

echo "=== 2. Create deploy user ==="
if ! id "$DEPLOY_USER" &>/dev/null; then
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
  usermod -aG docker "$DEPLOY_USER"
  mkdir -p /home/$DEPLOY_USER/.ssh
  cp /root/.ssh/authorized_keys /home/$DEPLOY_USER/.ssh/authorized_keys
  chown -R $DEPLOY_USER:$DEPLOY_USER /home/$DEPLOY_USER/.ssh
  chmod 700 /home/$DEPLOY_USER/.ssh
  chmod 600 /home/$DEPLOY_USER/.ssh/authorized_keys
  echo "Created user '$DEPLOY_USER' with docker access."
else
  echo "User '$DEPLOY_USER' already exists, skipping."
fi

echo "=== 3. Create .env ==="
if [ ! -f "$APP_DIR/.env" ]; then
  cat > "$APP_DIR/.env" <<'ENVEOF'
# NATS URL pointing to services machine via VPC private IP.
# Replace 10.x.x.x with your services machine's private IP.
NATS_URL=nats://10.x.x.x:4222
ENVEOF
  chmod 600 "$APP_DIR/.env"
  echo "Created .env — edit NATS_URL with the services machine private IP."
else
  echo ".env already exists, skipping."
fi

echo "=== 4. Start game server ==="
cd "$APP_DIR"
docker compose -f docker-compose.game.yml up -d --build

echo "=== 5. Configure UFW firewall ==="
if command -v ufw &>/dev/null; then
  ufw allow 22/tcp
  ufw --force enable
  echo "UFW enabled: allowing SSH (22) only."
else
  echo "UFW not found, skipping firewall setup."
fi

echo ""
echo "=== Setup complete ==="
docker compose -f docker-compose.game.yml ps
echo ""
echo "Next steps:"
echo "  1. Edit $APP_DIR/.env — set NATS_URL to services machine private IP"
echo "  2. Add GitHub Actions secrets: DEPLOY_GAME_HOST, DEPLOY_GAME_USER, DEPLOY_GAME_KEY"
