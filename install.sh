#!/usr/bin/env bash
set -euo pipefail

# ITCake Install Script
# Interactive installer for self-hosted deployment on Debian/Ubuntu

CYAN='\033[0;36m'
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

echo -e "${CYAN}"
echo "  ___ _____ ____      _        "
echo " |_ _|_   _/ ___|__ _| | _____ "
echo "  | |  | || |   / _\` | |/ / _ \\"
echo "  | |  | || |__| (_| |   <  __/"
echo " |___| |_| \\____|\\__,_|_|\\_\\___|"
echo -e "${NC}"
echo ""
echo "Invoicing · Ticketing · Uptime Monitoring"
echo "=========================================="
echo ""

# Check prerequisites
check_command() {
    if ! command -v "$1" &>/dev/null; then
        echo -e "${RED}Error: $1 is not installed.${NC}"
        return 1
    fi
}

echo "Checking prerequisites..."
check_command node || { echo "Install Node.js 20+ first: https://nodejs.org/"; exit 1; }
check_command npm || { echo "npm not found"; exit 1; }

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
    echo -e "${RED}Node.js 20+ required. Current: $(node -v)${NC}"
    exit 1
fi

echo -e "${GREEN}Node.js $(node -v) detected${NC}"

# Install Puppeteer system dependencies (Debian/Ubuntu) for PDF generation
if [ -f /etc/debian_version ] && ! dpkg -s libgbm1 &>/dev/null 2>&1; then
    echo ""
    echo "Installing Puppeteer system dependencies (PDF generation)..."
    sudo apt-get update -qq
    sudo apt-get install -y -qq libgbm1 libnss3 libatk1.0-0 libatk-bridge2.0-0 \
        libcups2 libxdamage1 libxrandr2 libpango-1.0-0 libcairo2 libasound2 \
        libxshmfence1 2>/dev/null || {
        echo -e "${RED}Warning: Could not install Puppeteer dependencies. PDF generation may not work.${NC}"
        echo "See: https://pptr.dev/troubleshooting#chrome-doesnt-launch-on-linux"
    }
fi

# Configuration
echo ""
echo "Configuration"
echo "-------------"

read -rp "Host [127.0.0.1]: " HOST
HOST="${HOST:-127.0.0.1}"
if ! [[ "$HOST" =~ ^[a-zA-Z0-9.:]+$ ]]; then
    echo -e "${RED}Error: Invalid host (only alphanumeric, dots, colons allowed)${NC}"
    exit 1
fi

read -rp "Port [3000]: " PORT
PORT="${PORT:-3000}"
if ! [[ "$PORT" =~ ^[0-9]+$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then
    echo -e "${RED}Error: Port must be a number between 1 and 65535${NC}"
    exit 1
fi

read -rp "Data directory [data]: " DATA_DIR
DATA_DIR="${DATA_DIR:-data}"
# Sanitize: reject paths with shell metacharacters, directory traversal, or control chars
if [[ "$DATA_DIR" =~ [[:space:]\$\`\"\'\;\|\&\>\<\(\)\{\}] ]] || [[ "$DATA_DIR" == *..* ]] || [[ "$DATA_DIR" =~ $'\n' ]] || [[ "$DATA_DIR" =~ $'\r' ]]; then
    echo -e "${RED}Error: Data directory must not contain spaces, '..',  or shell metacharacters${NC}"
    exit 1
fi

# Create .env
echo ""
OVERWRITE_ENV=""
if [ -f .env ]; then
    read -rp "Existing .env found. Overwrite? [y/N]: " OVERWRITE_ENV
    if [[ "${OVERWRITE_ENV,,}" != "y" ]]; then
        echo "Keeping existing .env"
    else
        cp .env ".env.backup.$(date +%Y%m%d%H%M%S)"
        echo -e "${GREEN}Backed up existing .env${NC}"
    fi
fi
if [ ! -f .env ] || [[ "${OVERWRITE_ENV,,}" == "y" ]]; then
echo "Creating .env file..."
SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
read -rp "Public URL for CSRF protection (e.g., https://invoices.example.com) []: " ORIGIN_URL
if [[ -n "$ORIGIN_URL" ]] && ! [[ "$ORIGIN_URL" =~ ^https?://[a-zA-Z0-9._:/-]+$ ]]; then
    echo -e "${RED}Error: Invalid origin URL (must be http:// or https:// with safe characters)${NC}"
    exit 1
fi

{
    printf 'DATABASE_PATH=%s/itcake.db\n' "${DATA_DIR}"
    printf 'DATA_DIR=%s\n' "${DATA_DIR}"
    printf 'HOST=%s\n' "${HOST}"
    printf 'PORT=%s\n' "${PORT}"
    echo 'NODE_ENV=production'
    printf 'SESSION_SECRET=%s\n' "${SESSION_SECRET}"
    [[ -n "${ORIGIN_URL}" ]] && printf 'ORIGIN=%s\n' "${ORIGIN_URL}"
} > .env
chmod 600 .env
echo -e "${GREEN}.env created (permissions: 600)${NC}"
fi

# Create data directories
echo "Creating data directories..."
mkdir -p "${DATA_DIR}"/{uploads,backups}

# Install dependencies
echo ""
echo "Installing dependencies..."
npm ci

# Build
echo ""
echo "Building application..."
npm run build

echo ""
echo -e "${GREEN}Build successful!${NC}"

# Optional: Caddy reverse proxy
echo ""
read -rp "Set up Caddy reverse proxy? [y/N]: " SETUP_CADDY
if [[ "${SETUP_CADDY,,}" == "y" ]]; then
    read -rp "Domain name (e.g., invoices.example.com): " DOMAIN
    if ! [[ "$DOMAIN" =~ ^[a-zA-Z0-9.-]+$ ]]; then
        echo -e "${RED}Error: Invalid domain name${NC}"
        exit 1
    fi

    if command -v caddy &>/dev/null; then
        CADDY_FILE="/etc/caddy/Caddyfile"
        echo ""
        echo "Adding to ${CADDY_FILE}:"
        CADDY_BLOCK="${DOMAIN} {
    reverse_proxy localhost:${PORT}
}"
        echo "$CADDY_BLOCK"
        echo ""
        read -rp "Write to ${CADDY_FILE}? [y/N]: " WRITE_CADDY
        if [[ "${WRITE_CADDY,,}" == "y" ]]; then
            echo "$CADDY_BLOCK" | sudo tee -a "$CADDY_FILE" > /dev/null
            sudo systemctl reload caddy
            echo -e "${GREEN}Caddy configured for ${DOMAIN}${NC}"
            # Set ORIGIN for CSRF protection if not already configured
            if ! grep -q '^ORIGIN=' .env 2>/dev/null; then
                echo "ORIGIN=https://${DOMAIN}" >> .env
                echo -e "${GREEN}ORIGIN set to https://${DOMAIN} in .env${NC}"
            fi
        fi
    else
        echo -e "${RED}Caddy not installed. Install it: https://caddyserver.com/docs/install${NC}"
    fi
fi

# Optional: systemd service
echo ""
read -rp "Create systemd service? [y/N]: " SETUP_SYSTEMD
if [[ "${SETUP_SYSTEMD,,}" == "y" ]]; then
    APP_DIR="$(pwd)"
    NODE_BIN="$(command -v node)"
    SERVICE_FILE="/etc/systemd/system/itcake.service"

    echo "Creating ${SERVICE_FILE}..."
    sudo tee "$SERVICE_FILE" > /dev/null << EOF
[Unit]
Description=ITCake
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} ${APP_DIR}/build/index.js
Restart=on-failure
RestartSec=5
EnvironmentFile=${APP_DIR}/.env

[Install]
WantedBy=multi-user.target
EOF

    sudo systemctl daemon-reload
    sudo systemctl enable itcake
    sudo systemctl start itcake
    echo -e "${GREEN}Service created and started${NC}"
fi

echo ""
echo -e "${GREEN}ITCake installed successfully!${NC}"
echo ""
echo "To start manually:"
echo "  NODE_ENV=production node build/index.js"
echo ""
echo "Access at: http://${HOST}:${PORT}"
echo ""
echo "First visit will show the setup wizard."
