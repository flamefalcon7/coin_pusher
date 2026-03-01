#!/usr/bin/env bash
# One-time server provisioning script for DigitalOcean droplet.
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
  # Copy root authorized_keys so the same SSH key works for deploy user
  cp /root/.ssh/authorized_keys /home/$DEPLOY_USER/.ssh/authorized_keys
  chown -R $DEPLOY_USER:$DEPLOY_USER /home/$DEPLOY_USER/.ssh
  chmod 700 /home/$DEPLOY_USER/.ssh
  chmod 600 /home/$DEPLOY_USER/.ssh/authorized_keys
  echo "Created user '$DEPLOY_USER' with docker access."
else
  echo "User '$DEPLOY_USER' already exists, skipping."
fi

#echo "=== 3. Clone repo ==="
#if [ ! -d "$APP_DIR" ]; then
#  git clone https://github.com/flamefalcon/coin_pusher.git "$APP_DIR"
#  chown -R $DEPLOY_USER:$DEPLOY_USER "$APP_DIR"
#else
#  echo "Repo already cloned at $APP_DIR, pulling latest."
#  cd "$APP_DIR" && git pull origin main
#fi

echo "=== 4. Create .env ==="
if [ ! -f "$APP_DIR/.env" ]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  # Generate a random DB password
  DB_PASS=$(openssl rand -base64 24)
  sed -i "s#CHANGE_ME#$DB_PASS#" "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
  echo "Created .env with generated DB password."
else
  echo ".env already exists, skipping."
fi

echo "=== 5. Generate JWT signing key ==="
KEYS_DIR="$APP_DIR/backend/zarf/keys"
if [ ! -f "$KEYS_DIR/default.pem" ]; then
  mkdir -p "$KEYS_DIR"
  openssl genrsa -traditional -out "$KEYS_DIR/default.pem" 2048
  chmod 600 "$KEYS_DIR/default.pem"
  echo "Generated RSA key at $KEYS_DIR/default.pem."
else
  echo "JWT key already exists, skipping."
fi

echo "=== 6. Generate TLS cert for nginx ==="
TLS_DIR="$APP_DIR/deploy/nginx/certs"
if [ ! -f "$TLS_DIR/origin.crt" ] || [ ! -f "$TLS_DIR/origin.key" ]; then
  mkdir -p "$TLS_DIR"
  openssl req -x509 -nodes -newkey rsa:2048 \
    -keyout "$TLS_DIR/origin.key" \
    -out "$TLS_DIR/origin.crt" \
    -sha256 -days 365 \
    -subj "/CN=api.local"
  chmod 600 "$TLS_DIR/origin.key"
  chmod 644 "$TLS_DIR/origin.crt"
  echo "Generated self-signed TLS cert for nginx at $TLS_DIR."
  echo "Replace with Cloudflare Origin Certificate for Full (strict)."
else
  echo "TLS cert already exists, skipping."
fi

echo "=== 7. Start services ==="
cd "$APP_DIR"
docker compose -f docker-compose.services.yml up -d --build

echo "=== 8. Run DB migrations ==="
sleep 5
docker compose -f docker-compose.services.yml exec backend /bin/admin migrate

echo "=== 9. Configure UFW firewall ==="
if command -v ufw &>/dev/null; then
  ufw allow 22/tcp
  ufw allow 80/tcp
  ufw allow 443/tcp
  # Allow NATS from game machine via VPC private IP.
  # Replace 10.x.x.x with your game machine's private IP.
  # ufw allow from 10.x.x.x to any port 4222
  ufw --force enable
  echo "UFW enabled: allowing SSH (22), HTTP (80), and HTTPS (443)."
  echo "NOTE: Uncomment and edit the NATS rule above for game machine access."
else
  echo "UFW not found, skipping firewall setup."
fi

echo ""
echo "=== Setup complete ==="
echo "Services running:"
docker compose -f docker-compose.services.yml ps
echo ""
echo "Next steps:"
echo "  1. Point Cloudflare DNS 'api' A record to this server's IP"
echo "  2. Set Cloudflare SSL mode to Full (or Full strict after replacing cert with Origin CA cert)"
echo "  3. Connect GitHub repo to Cloudflare Pages for frontend"
echo "  4. Set VITE_WS_URL=wss://api.<your-domain>/ws in Cloudflare Pages env"
echo "  5. Add GitHub Actions secrets: DEPLOY_SERVICES_HOST, DEPLOY_SERVICES_USER, DEPLOY_SERVICES_KEY"
echo "  6. Run deploy/setup-game.sh on the game machine"
echo "  7. Add UFW rule: ufw allow from <game-private-ip> to any port 4222"
