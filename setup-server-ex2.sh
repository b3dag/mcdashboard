#!/bin/bash
# =============================================================================
# setup.sh — one-shot installer for the brotalius minecraft dashboard
# =============================================================================
#
# Run this on a fresh Debian box as your normal user (NOT root).
#
#   curl -fsSL https://raw.githubusercontent.com/b3dag/mcdashboard/main/setup.sh | bash
#
# Or if you've already cloned the repo:
#
#   chmod +x setup.sh && ./setup.sh
#
# At the end you'll have:
#   - all packages installed
#   - dashboard cloned, configured, and running on 127.0.0.1:8080
#   - your super-operator account created
#   - cloudflared installed (you finish the tunnel auth in 2 commands)
#   - ttyd installed and running
# =============================================================================

set -e

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
info() { echo -e "${BLUE}==>${NC} $1"; }
ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; exit 1; }
ask()  { local p="$1" d="$2" v; read -p "$(echo -e ${YELLOW}?${NC} $p ${d:+[default: $d] })" v; echo "${v:-$d}"; }

# ----- safety -----
[ "$EUID" -eq 0 ] && fail "don't run as root. run as your normal user, sudo is used where needed."
command -v sudo >/dev/null || fail "sudo is required."

clear
echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}  brotalius minecraft dashboard — lazy setup    ${NC}"
echo -e "${BLUE}================================================${NC}"
echo
echo "this will install everything and get you running."
echo "it'll ask you a few questions up front, then do the rest by itself."
echo
read -p "press enter to begin..."
echo

# ----- 1. ASK ALL QUESTIONS UP FRONT (so you can walk away) -----
info "answer these and i'll do the rest by myself"
echo

# repo location
REPO_URL=$(ask "git repo URL" "https://github.com/b3dag/mcdashboard")
INSTALL_DIR="/srv/dashboard"

# super-operator
SUPER_USER=$(ask "super-operator username" "admin")
while true; do
  read -s -p "$(echo -e ${YELLOW}?${NC} super-operator password [6+ chars]: )" SUPER_PASS; echo
  [ ${#SUPER_PASS} -ge 6 ] && break
  warn "too short. try again."
done
read -s -p "$(echo -e ${YELLOW}?${NC} confirm password: )" SUPER_PASS2; echo
[ "$SUPER_PASS" = "$SUPER_PASS2" ] || fail "passwords don't match."

# tunnel
echo
read -p "$(echo -e ${YELLOW}?${NC} set up cloudflare tunnel? [Y/n] )" -n 1 -r DO_TUNNEL; echo
DO_TUNNEL=${DO_TUNNEL:-Y}
if [[ $DO_TUNNEL =~ ^[Yy]$ ]]; then
  TUNNEL_NAME=$(ask "tunnel name" "mc-dash")
  TUNNEL_HOSTNAME=$(ask "public hostname (e.g. dash.example.com)" "")
  [ -z "$TUNNEL_HOSTNAME" ] && fail "hostname required for tunnel setup."
fi

# ttyd
echo
read -p "$(echo -e ${YELLOW}?${NC} install in-browser terminal \(ttyd\)? [Y/n] )" -n 1 -r DO_TTYD; echo
DO_TTYD=${DO_TTYD:-Y}

echo
echo -e "${GREEN}got it. you can walk away now — i'll run unattended.${NC}"
echo
sleep 2

# ----- 2. SYSTEM PACKAGES -----
info "installing system packages..."
sudo apt-get update -qq
sudo apt-get install -y -qq curl git openjdk-21-jre-headless sqlite3 build-essential >/dev/null
ok "system packages installed"

# ----- 3. NODE.JS 20 -----
info "installing node.js 20..."
if ! command -v node >/dev/null || [ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null
  sudo apt-get install -y -qq nodejs >/dev/null
fi
ok "node.js $(node --version)"

# ----- 4. LINGERING -----
info "enabling systemd lingering..."
sudo loginctl enable-linger "$USER" >/dev/null 2>&1 || true
ok "lingering enabled"

# ----- 5. CLONE REPO -----
info "setting up $INSTALL_DIR..."
sudo mkdir -p "$INSTALL_DIR"
sudo chown -R "$USER:$USER" "$INSTALL_DIR"
if [ ! -f "$INSTALL_DIR/package.json" ]; then
  git clone "$REPO_URL" "$INSTALL_DIR" 2>&1 | sed 's/^/    /'
fi
[ -f "$INSTALL_DIR/package.json" ] || fail "repo clone failed."
ok "repo at $INSTALL_DIR"

cd "$INSTALL_DIR"

# ----- 6. NPM INSTALL -----
info "installing dashboard dependencies (this takes a bit)..."
npm install --silent 2>&1 | tail -3 | sed 's/^/    /'
ok "npm dependencies installed"

# ----- 7. .env -----
info "configuring .env..."
if [ ! -f .env ]; then
  if [ -f .env.example ]; then
    cp .env.example .env
  else
    touch .env
  fi
fi
SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
if grep -q "^SESSION_SECRET=" .env; then
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=$SECRET|" .env
else
  echo "SESSION_SECRET=$SECRET" >> .env
fi
ok "SESSION_SECRET generated"

# ----- 8. SUPER-OPERATOR -----
info "creating super-operator '$SUPER_USER'..."
# pipe password into create-user.js (it prompts twice for confirm)
printf '%s\n%s\n' "$SUPER_PASS" "$SUPER_PASS" | node scripts/create-user.js "$SUPER_USER" --super >/dev/null 2>&1 \
  || warn "user may already exist — skipping"
ok "super-operator ready"

# ----- 9. DASHBOARD SERVICE -----
info "installing dashboard systemd service..."
mkdir -p "$HOME/.config/systemd/user"
if [ -f systemd/dashboard.service ]; then
  cp systemd/dashboard.service "$HOME/.config/systemd/user/"
  systemctl --user daemon-reload
  systemctl --user enable --now dashboard >/dev/null 2>&1
  sleep 1
  if systemctl --user is-active --quiet dashboard; then
    ok "dashboard running on 127.0.0.1:8080"
  else
    warn "dashboard service installed but not active. check: systemctl --user status dashboard"
  fi
else
  warn "systemd/dashboard.service not in repo — skipping"
fi

# ----- 10. CLOUDFLARED -----
if [[ $DO_TUNNEL =~ ^[Yy]$ ]]; then
  info "installing cloudflared..."
  if ! command -v cloudflared >/dev/null; then
    sudo mkdir -p --mode=0755 /usr/share/keyrings
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
    echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
    sudo apt-get update -qq && sudo apt-get install -y -qq cloudflared >/dev/null
  fi
  ok "cloudflared installed"

  # write the config now so user only has to do tunnel login + create
  mkdir -p "$HOME/.cloudflared"
  cat > "$HOME/.cloudflared/config.yml" <<EOF
# tunnel id and credentials-file get filled in after you create the tunnel
# tunnel: <tunnel-id>
# credentials-file: $HOME/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: $TUNNEL_HOSTNAME
    service: http://127.0.0.1:8080
  - service: http_status:404
EOF
  ok "cloudflared config template at ~/.cloudflared/config.yml"
fi

# ----- 11. TTYD -----
if [[ $DO_TTYD =~ ^[Yy]$ ]]; then
  info "installing ttyd (in-browser terminal)..."
  if ! command -v ttyd >/dev/null; then
    curl -fsSL https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64 -o /tmp/ttyd
    sudo mv /tmp/ttyd /usr/local/bin/ttyd
    sudo chmod +x /usr/local/bin/ttyd
  fi

  if [ -f systemd/ttyd.service ]; then
    cp systemd/ttyd.service "$HOME/.config/systemd/user/"
    systemctl --user daemon-reload
    systemctl --user enable --now ttyd >/dev/null 2>&1
  fi

  if ! grep -q "^TERMINAL_ENABLED=true" .env; then
    echo "TERMINAL_ENABLED=true" >> .env
    systemctl --user restart dashboard >/dev/null 2>&1
  fi
  ok "ttyd installed and running"
fi

# ----- DONE -----
echo
echo -e "${GREEN}================================================${NC}"
echo -e "${GREEN}  setup complete                                ${NC}"
echo -e "${GREEN}================================================${NC}"
echo
echo "the dashboard is running locally:    http://127.0.0.1:8080"
echo "log in as:                           $SUPER_USER"
echo

if [[ $DO_TUNNEL =~ ^[Yy]$ ]]; then
  echo -e "${YELLOW}two things you have to do for the tunnel${NC} (cloudflared needs your browser):"
  echo
  echo "  1. authenticate (opens a browser link):"
  echo "       cloudflared tunnel login"
  echo
  echo "  2. create the tunnel and route DNS:"
  echo "       cloudflared tunnel create $TUNNEL_NAME"
  echo "       cloudflared tunnel route dns $TUNNEL_NAME $TUNNEL_HOSTNAME"
  echo
  echo "  3. fill in the tunnel id in ~/.cloudflared/config.yml,"
  echo "     then copy the systemd unit and start it:"
  echo "       cp $INSTALL_DIR/systemd/cloudflared.service ~/.config/systemd/user/"
  echo "       sed -i \"s|run brotalius-dash|run $TUNNEL_NAME|\" ~/.config/systemd/user/cloudflared.service"
  echo "       systemctl --user daemon-reload"
  echo "       systemctl --user enable --now cloudflared"
  echo
  echo "  then visit:  https://$TUNNEL_HOSTNAME"
fi

echo
echo "to add a minecraft server, see README.md → 'adding a new minecraft server'."
echo
