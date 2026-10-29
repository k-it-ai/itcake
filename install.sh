#!/usr/bin/env bash
set -euo pipefail

# ITCake Install Script
# Interactive installer for self-hosted deployment on Debian/Ubuntu

CYAN='\033[0;36m'
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

# Lowercase helper. macOS ships bash 3.2, which has no ${var,,} expansion;
# the installer must run there too, so use tr instead.
lower() {
    printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

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
check_command node || { echo "Install Node.js 22.17+ first: https://nodejs.org/"; exit 1; }
check_command npm || { echo "npm not found"; exit 1; }

if ! node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 17) ? 0 : 1)'; then
    echo -e "${RED}Node.js 22.17+ required. Current: $(node -v)${NC}"
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

normalize_origin() {
    node -e '
const raw = (process.argv[1] || "").trim();
const fail = (message) => { console.error(message); process.exit(1); };
if (!raw) fail("A public URL is required.");
let url;
try { url = new URL(raw); } catch { fail("Enter a full URL such as https://invoices.example.com."); }
if (url.protocol !== "http:" && url.protocol !== "https:") fail("Only http:// and https:// URLs are supported.");
if (url.username || url.password) fail("The URL must not contain a username or password.");
if (url.search || url.hash) fail("The URL must not contain a query string or fragment.");
if (raw.endsWith("/")) fail("Remove the trailing slash: " + url.origin);
if (url.pathname !== "/") fail("Use an origin only, without a path: " + url.origin);
const loopback = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(url.hostname.toLowerCase());
if (url.protocol === "http:" && !loopback) fail("Production requires HTTPS. Use an https:// URL (http:// is allowed only for localhost).");
process.stdout.write(url.origin);
' "$1" 2>&1
}

env_value() {
    local key="$1" value
    value="$(grep -E "^${key}=" .env 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
    value="${value%\"}"
    value="${value#\"}"
    printf '%s' "$value"
}

set_env_value() {
    local key="$1" value="$2" tmp
    if grep -qE "^${key}=" .env 2>/dev/null; then
        tmp="$(mktemp)"
        sed "s|^${key}=.*|${key}=${value}|" .env > "$tmp"
        cat "$tmp" > .env
        rm -f "$tmp"
    else
        printf '%s=%s\n' "$key" "$value" >> .env
    fi
}

absolute_path() {
    if [[ "$1" = /* ]]; then
        printf '%s' "$1"
    else
        printf '%s/%s' "$(pwd)" "$1"
    fi
}

OVERWRITE_ENV=""
KEEP_ENV=false
if [ -f .env ]; then
    read -rp "Existing .env found. Overwrite? [y/N]: " OVERWRITE_ENV
    if [ "$(lower "$OVERWRITE_ENV")" != "y" ]; then
        KEEP_ENV=true
        echo "Keeping existing .env"
    else
        cp .env ".env.backup.$(date +%Y%m%d%H%M%S)"
        echo -e "${GREEN}Backed up existing .env${NC}"
    fi
fi

if [ "$KEEP_ENV" = true ]; then
    # Reuse the deployed configuration instead of the answers to prompts that
    # are irrelevant when .env is kept. This also keeps Caddy and systemd in
    # sync with the paths the app actually uses.
    HOST="$(env_value HOST)"; HOST="${HOST:-127.0.0.1}"
    PORT="$(env_value PORT)"; PORT="${PORT:-3000}"
    DATA_DIR="$(env_value DATA_DIR)"; DATA_DIR="${DATA_DIR:-data}"
    DATA_DIR_ABS="$(absolute_path "$DATA_DIR")"
    ORIGIN_URL="$(env_value ORIGIN)"
    PUPPETEER_CACHE_DIR="$(env_value PUPPETEER_CACHE_DIR)"

    if [ -z "$PUPPETEER_CACHE_DIR" ]; then
        PUPPETEER_CACHE_DIR="${DATA_DIR_ABS}/puppeteer"
        printf '\nPUPPETEER_CACHE_DIR=%s\n' "$PUPPETEER_CACHE_DIR" >> .env
        echo -e "${GREEN}Added PUPPETEER_CACHE_DIR to .env${NC}"
    else
        PUPPETEER_CACHE_DIR="$(absolute_path "$PUPPETEER_CACHE_DIR")"
    fi

    # Production now requires a dedicated field-encryption key. Older .env files
    # only have SESSION_SECRET; generate one so upgrades do not fail to start.
    FIELD_ENCRYPTION_KEY_VALUE="$(env_value FIELD_ENCRYPTION_KEY)"
    if [ -z "$FIELD_ENCRYPTION_KEY_VALUE" ]; then
        FIELD_ENCRYPTION_KEY_VALUE=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
        printf '\nFIELD_ENCRYPTION_KEY=%s\n' "$FIELD_ENCRYPTION_KEY_VALUE" >> .env
        echo -e "${GREEN}Added FIELD_ENCRYPTION_KEY to .env${NC}"
    fi

    while true; do
        if [ -z "$ORIGIN_URL" ]; then
            echo ""
            echo -e "${YELLOW}Existing .env has no ORIGIN. Production requires it.${NC}"
            read -rp "Public URL: " ORIGIN_URL
        fi
        if NORMALIZED_ORIGIN="$(normalize_origin "$ORIGIN_URL")"; then
            if [ "$NORMALIZED_ORIGIN" != "$(env_value ORIGIN)" ]; then
                set_env_value ORIGIN "$NORMALIZED_ORIGIN"
                echo -e "${GREEN}ORIGIN set to ${NORMALIZED_ORIGIN} in .env${NC}"
            fi
            ORIGIN_URL="$NORMALIZED_ORIGIN"
            break
        fi
        echo -e "${RED}Error: ${NORMALIZED_ORIGIN}${NC}"
        ORIGIN_URL=""
    done
    chmod 600 .env
else
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
    DATA_DIR_ABS="$(absolute_path "$DATA_DIR")"
    PUPPETEER_CACHE_DIR="${DATA_DIR_ABS}/puppeteer"

    echo "Creating .env file..."
    SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    FIELD_ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    echo ""
    echo "Public URL (required). This is the exact URL users open in the browser."
    echo "  Behind HTTPS:      ${GREEN}https://invoices.example.com${NC}"
    echo "  Local test only:   ${GREEN}http://127.0.0.1:${PORT}${NC}"
    while true; do
        read -rp "Public URL: " ORIGIN_URL
        if NORMALIZED_ORIGIN="$(normalize_origin "$ORIGIN_URL")"; then
            ORIGIN_URL="$NORMALIZED_ORIGIN"
            break
        fi
        echo -e "${RED}Error: ${NORMALIZED_ORIGIN}${NC}"
    done

    {
        printf 'DATABASE_PATH=%s/itcake.db\n' "${DATA_DIR_ABS}"
        printf 'DATA_DIR=%s\n' "${DATA_DIR_ABS}"
        printf 'PUPPETEER_CACHE_DIR=%s\n' "${PUPPETEER_CACHE_DIR}"
        printf 'HOST=%s\n' "${HOST}"
        printf 'PORT=%s\n' "${PORT}"
        echo 'NODE_ENV=production'
        printf 'SESSION_SECRET=%s\n' "${SESSION_SECRET}"
        printf 'FIELD_ENCRYPTION_KEY=%s\n' "${FIELD_ENCRYPTION_KEY}"
        printf 'ORIGIN=%s\n' "${ORIGIN_URL}"
    } > .env
    chmod 600 .env
    echo -e "${GREEN}.env created (permissions: 600)${NC}"
fi

# Create data directories
echo "Creating data directories..."
mkdir -p "${DATA_DIR}"/{uploads,backups,agent-binaries,recordings}

# Install dependencies
echo ""
echo "Installing dependencies..."
if ! PUPPETEER_CACHE_DIR="${PUPPETEER_CACHE_DIR}" npm ci; then
    echo -e "${RED}Error: npm ci failed.${NC}"
    echo "On a minimal Debian/Ubuntu image, install the build toolchain and retry:"
    echo "  sudo apt-get install -y build-essential python3"
    echo "better-sqlite3 compiles from source when no prebuilt binary is available."
    exit 1
fi

# Chromium is required for invoice/proposal PDF rendering. npm ci normally
# downloads it, but make it explicit so a skipped postinstall cannot leave
# PDF generation broken.
echo ""
echo "Installing Chromium for PDF rendering..."
mkdir -p "${PUPPETEER_CACHE_DIR}"
PUPPETEER_CACHE_DIR="${PUPPETEER_CACHE_DIR}" npx puppeteer browsers install chrome

# Build
echo ""
echo "Building application..."
npm run build

echo ""
echo -e "${GREEN}Build successful!${NC}"

# Optional: Caddy reverse proxy
echo ""
read -rp "Set up Caddy reverse proxy? [y/N]: " SETUP_CADDY
if [ "$(lower "$SETUP_CADDY")" == "y" ]; then
    read -rp "Domain name (e.g., invoices.example.com): " DOMAIN
    if ! [[ "$DOMAIN" =~ ^[a-zA-Z0-9.-]+$ ]]; then
        echo -e "${RED}Error: Invalid domain name${NC}"
        exit 1
    fi

    if command -v caddy &>/dev/null; then
        CADDY_FILE="/etc/caddy/Caddyfile"
        if [[ "$HOST" == "0.0.0.0" || "$HOST" == "127.0.0.1" || "$HOST" == "localhost" ]]; then
            PROXY_TARGET="127.0.0.1:${PORT}"
        elif [[ "$HOST" == "::1" ]]; then
            PROXY_TARGET="[::1]:${PORT}"
        else
            PROXY_TARGET="${HOST}:${PORT}"
        fi
        echo ""
        echo "Adding to ${CADDY_FILE}:"
        CADDY_BLOCK="${DOMAIN} {
    reverse_proxy ${PROXY_TARGET}
}"
        echo "$CADDY_BLOCK"
        echo ""
        read -rp "Write to ${CADDY_FILE}? [y/N]: " WRITE_CADDY
        if [ "$(lower "$WRITE_CADDY")" == "y" ]; then
            sudo mkdir -p "$(dirname "$CADDY_FILE")"
            if sudo test -f "$CADDY_FILE" && sudo grep -qF "${DOMAIN} {" "$CADDY_FILE"; then
                echo "Caddyfile already has a block for ${DOMAIN}; not appending."
            else
                echo "$CADDY_BLOCK" | sudo tee -a "$CADDY_FILE" > /dev/null
            fi
            sudo systemctl reload caddy
            echo -e "${GREEN}Caddy configured for ${DOMAIN}${NC}"

            # Caddy serves https://DOMAIN, so that must be the canonical origin;
            # a mismatched ORIGIN rejects every mutating request with 403.
            if [ "$ORIGIN_URL" != "https://${DOMAIN}" ]; then
                echo -e "${YELLOW}Updating ORIGIN from ${ORIGIN_URL} to https://${DOMAIN} to match Caddy${NC}"
                set_env_value ORIGIN "https://${DOMAIN}"
                ORIGIN_URL="https://${DOMAIN}"
            fi

            # Only the reverse proxy can reach a loopback HOST, so trusting its
            # X-Forwarded-For is safe and restores real client IPs for rate
            # limiting and audit logs.
            if [[ "$HOST" == "127.0.0.1" || "$HOST" == "localhost" || "$HOST" == "::1" ]]; then
                if [ "$(env_value ADDRESS_HEADER)" != "X-Forwarded-For" ]; then
                    set_env_value ADDRESS_HEADER "X-Forwarded-For"
                    echo -e "${GREEN}ADDRESS_HEADER=X-Forwarded-For set in .env${NC}"
                fi
            else
                echo -e "${YELLOW}HOST=${HOST} is reachable directly. Bind to 127.0.0.1 before exposing the service through Caddy.${NC}"
            fi
        fi
    else
        echo -e "${RED}Caddy not installed. Install it: https://caddyserver.com/docs/install${NC}"
    fi
fi

# Optional: systemd service
echo ""
read -rp "Create systemd service? [y/N]: " SETUP_SYSTEMD
if [ "$(lower "$SETUP_SYSTEMD")" == "y" ]; then
    APP_DIR="$(pwd)"
    NODE_BIN="$(command -v node)"
    SERVICE_FILE="/etc/systemd/system/itcake.service"

    # systemd unit path settings do not accept shell-style quotes. Reject
    # whitespace early instead of writing a unit that systemd cannot parse.
    if [[ "$APP_DIR" == *[[:space:]]* || "$NODE_BIN" == *[[:space:]]* ]]; then
        echo -e "${RED}Error: install and Node paths must not contain whitespace.${NC}"
        exit 1
    fi

    # Ubuntu 24.04 restricts unprivileged user namespaces with AppArmor. Chromium's
    # renderer sandbox needs them; attach an unconfined profile that grants only
    # the userns permission. On systems without AppArmor the profile is skipped
    # (Debian 12 and Ubuntu 22.04 allow user namespaces by default).
    APPARMOR_DIRECTIVE=""
    if [ -d /etc/apparmor.d ] && command -v apparmor_parser >/dev/null 2>&1; then
        APPARMOR_FILE="/etc/apparmor.d/itcake"
        echo "Installing AppArmor profile for Chromium user namespaces..."
        sudo tee "$APPARMOR_FILE" > /dev/null << 'EOF'
include <tunables/global>

profile itcake flags=(unconfined) {
  userns,
  include if exists <local/itcake>
}
EOF
        if sudo apparmor_parser -r "$APPARMOR_FILE"; then
            APPARMOR_DIRECTIVE="AppArmorProfile=itcake"
            echo -e "${GREEN}AppArmor profile loaded${NC}"
        else
            sudo rm -f "$APPARMOR_FILE"
            echo -e "${YELLOW}Warning: could not load the AppArmor profile; PDF generation may fail on Ubuntu 24.04.${NC}"
        fi
    fi

    echo "Creating ${SERVICE_FILE}..."
    # Warn if installing as root — the service will run as root unless the
    # user changes User= manually. For production, run install.sh as a
    # dedicated unprivileged user (e.g. `sudo useradd --system itcake`).
    INSTALL_USER="$(whoami)"
    if [ "$INSTALL_USER" = "root" ]; then
        echo -e "${YELLOW}WARNING: install.sh is running as root.${NC}"
        echo -e "${YELLOW}The systemd unit will run ITCake as root unless you change User=.${NC}"
        echo -e "${YELLOW}Recommended: run as a dedicated unprivileged user.${NC}"
    fi
    sudo tee "$SERVICE_FILE" > /dev/null << EOF
[Unit]
Description=ITCake
After=network.target

[Service]
Type=simple
User=${INSTALL_USER}
WorkingDirectory=${APP_DIR}
ExecStart="${NODE_BIN}" "${APP_DIR}/build/index.js"
Restart=on-failure
RestartSec=5
EnvironmentFile=${APP_DIR}/.env
${APPARMOR_DIRECTIVE}
# Give Chromium and Node a writable home inside DATA_DIR; ProtectHome below
# makes the real home read-only.
Environment="HOME=${DATA_DIR_ABS}"

# Hardening directives. Each one narrows the kernel-level capability the
# service has if it is ever exploited (RCE in Puppeteer, sanitize-html, etc.).
NoNewPrivileges=true
UMask=0077
ProtectSystem=strict
# read-only (not true): install.sh is often run from a user's home directory,
# and ProtectHome=true would hide both the app and the Chromium cache.
ProtectHome=read-only
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
ProtectProc=invisible
# AF_NETLINK is used by Chromium to watch network-interface changes.
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
MemoryDenyWriteExecute=false
SystemCallArchitectures=native
# Do NOT blanket-restrict namespaces or syscall groups here. Chromium's
# renderer sandbox (required — PUPPETEER_NO_SANDBOX is refused in production)
# creates user, PID and network namespaces and calls setuid/setrlimit inside
# them. RestrictNamespaces=true or SystemCallFilter=~@privileged @resources
# makes PDF generation fail with "No usable sandbox!".
ReadWritePaths=${DATA_DIR_ABS}

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
echo "  node --env-file=.env build/index.js"
echo ""
echo "Access at: ${ORIGIN_URL}"
echo ""
echo "First visit will show the setup wizard."
if [[ "$ORIGIN_URL" == http://127.0.0.1* || "$ORIGIN_URL" == http://localhost* || "$ORIGIN_URL" == "http://[::1]"* ]]; then
    echo -e "${YELLOW}This is a local-only http:// URL. Put HTTPS in front before exposing it remotely.${NC}"
fi
