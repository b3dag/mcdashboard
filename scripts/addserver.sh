#!/bin/bash
# =============================================================================
# addserver.sh — add a new minecraft server to the dashboard
# =============================================================================
#
# Run from anywhere, as your normal user (the same one that runs the dashboard).
#
#   chmod +x addserver.sh
#   ./addserver.sh
#
# It will:
#   - ask you a few questions (server name, MC version, type, ports, RAM)
#   - download the right server jar (vanilla, fabric, or paper)
#   - accept the EULA
#   - first-run the server to generate server.properties
#   - configure RCON, ports, whitelist
#   - generate a strong RCON password
#   - create the systemd unit
#   - add RCON_PASSWORD_<NAME> to /srv/dashboard/.env
#   - add the entry to /srv/dashboard/servers.json
#   - restart the dashboard
#   - print "Start it from the dashboard"
#
# Default port allocation: starts at 25565 for the first server, increments
# for each subsequent one. Same for RCON ports starting at 25575.
# =============================================================================

set -e
set -o pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
info() { echo -e "${BLUE}==>${NC} $1"; }
ok()   { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}!${NC} $1"; }
fail() { echo -e "${RED}✗${NC} $1"; exit 1; }
ask()  { local p="$1" d="$2" v; read -p "$(echo -e ${YELLOW}?${NC} $p ${d:+[$d] })" v; echo "${v:-$d}"; }

# verify a jar file downloaded correctly: exists, non-empty, and starts with PK (zip magic)
verify_jar() {
  local jar="$1"
  [ -f "$jar" ]                || fail "download failed: $jar not created"
  [ -s "$jar" ]                || fail "download failed: $jar is empty"
  local size=$(stat -c %s "$jar")
  [ "$size" -lt 100000 ]       && fail "download too small ($size bytes) — probably an error page, not a jar"
  head -c 2 "$jar" | grep -q "PK" || fail "download isn't a valid jar (no PK header) — got an error page or HTML"
  if [ "$size" -lt 10485760 ]; then
    ok "verified: $(basename $jar) is $((size / 1024))KB"
  else
    ok "verified: $(basename $jar) is $((size / 1024 / 1024))MB"
  fi
}

# ----- safety -----
[ "$EUID" -eq 0 ] && fail "don't run as root. run as the user that owns /srv/dashboard."

DASHBOARD="/srv/dashboard"
MCSERV_ROOT="/srv/mcserv"
[ -f "$DASHBOARD/servers.json" ] || fail "$DASHBOARD/servers.json not found. is the dashboard installed?"
[ -f "$DASHBOARD/.env" ]         || fail "$DASHBOARD/.env not found. run setup.sh first."
command -v java >/dev/null || fail "java not installed. (sudo apt install openjdk-21-jre-headless)"
command -v jq   >/dev/null || { warn "jq not installed, installing..."; sudo apt-get install -y jq >/dev/null; }

clear
echo -e "${BLUE}================================================${NC}"
echo -e "${BLUE}  add a minecraft server                        ${NC}"
echo -e "${BLUE}================================================${NC}"
echo

# ----- ask questions -----
while true; do
  NAME=$(ask "server name (lowercase, a-z 0-9 -, e.g. creative01)" "")
  if [[ "$NAME" =~ ^[a-z0-9-]+$ ]]; then
    if jq -e --arg n "$NAME" '.servers[] | select(.name==$n)' "$DASHBOARD/servers.json" >/dev/null 2>&1; then
      warn "a server named '$NAME' already exists in servers.json. pick another."
    else
      break
    fi
  else
    warn "invalid name. lowercase letters, digits, hyphens only."
  fi
done

DISPLAY=$(ask "display name (shown in UI)" "$NAME")

echo
echo "server type:"
echo "  1) vanilla   — official Mojang server"
echo "  2) fabric    — Fabric mod loader"
echo "  3) paper     — Paper (performance fork of Spigot)"
TYPE=$(ask "choice (1/2/3)" "1")

MC_VERSION=$(ask "minecraft version" "1.21.1")

# ----- choose ports -----
# count existing entries to pick non-colliding default ports
EXISTING_COUNT=$(jq '.servers | length' "$DASHBOARD/servers.json")
DEFAULT_PORT=$((25565 + EXISTING_COUNT))
DEFAULT_RCON=$((25575 + EXISTING_COUNT))

PORT=$(ask "minecraft port" "$DEFAULT_PORT")
RCON_PORT=$(ask "rcon port" "$DEFAULT_RCON")

RAM_MAX=$(ask "max RAM (e.g. 4G, 8G)" "4G")
RAM_MIN=$(ask "min RAM" "2G")

# ----- generate RCON password -----
RCON_PW=$(openssl rand -hex 24 2>/dev/null || head -c 32 /dev/urandom | xxd -p -c 32)
ok "generated rcon password"

echo
echo -e "${GREEN}got it. starting setup — walk away if you want.${NC}"
echo
sleep 1

# ----- create folder -----
FOLDER="$MCSERV_ROOT/$NAME"
info "creating $FOLDER..."
sudo mkdir -p "$FOLDER"
sudo chown -R "$USER:$USER" "$MCSERV_ROOT"
cd "$FOLDER"

# ----- download jar -----
info "downloading server jar..."
case "$TYPE" in
  1) # vanilla
    # Use Mojang's launcher manifest API to find the right URL for the version
    MANIFEST=$(curl -fsSL https://launchermeta.mojang.com/mc/game/version_manifest_v2.json) \
      || fail "couldn't fetch mojang manifest"
    VERSION_URL=$(echo "$MANIFEST" | jq -r --arg v "$MC_VERSION" '.versions[] | select(.id==$v) | .url' | head -1)
    [ -z "$VERSION_URL" ] && fail "minecraft version '$MC_VERSION' not found"
    SERVER_URL=$(curl -fsSL "$VERSION_URL" | jq -r '.downloads.server.url')
    [ -z "$SERVER_URL" ] && fail "couldn't find server jar URL"
    rm -f server.jar
    curl -fL --progress-bar "$SERVER_URL" -o server.jar || fail "vanilla jar download failed"
    verify_jar server.jar
    LAUNCH_JAR="server.jar"
    ok "vanilla $MC_VERSION downloaded"
    ;;
  2) # fabric
    LOADER_VERSION=$(curl -fsSL https://meta.fabricmc.net/v2/versions/loader | jq -r '.[0].version') \
      || fail "couldn't fetch fabric loader versions"
    INSTALLER_VERSION=$(curl -fsSL https://meta.fabricmc.net/v2/versions/installer | jq -r '.[0].version') \
      || fail "couldn't fetch fabric installer versions"
    # Fabric server endpoint format:
    #   /v2/versions/loader/<mc>/<loader>/<installer>/server/jar
    INSTALLER_URL="https://meta.fabricmc.net/v2/versions/loader/$MC_VERSION/$LOADER_VERSION/$INSTALLER_VERSION/server/jar"
    rm -f fabric-server-launch.jar server.jar
    curl -fL --progress-bar "$INSTALLER_URL" -o fabric-server-launch.jar \
      || fail "fabric jar download failed (check that mc version $MC_VERSION exists and is fabric-supported)"
    verify_jar fabric-server-launch.jar
    LAUNCH_JAR="fabric-server-launch.jar"
    ok "fabric $MC_VERSION (loader $LOADER_VERSION) downloaded"
    ;;
  3) # paper
    BUILDS=$(curl -fsSL "https://api.papermc.io/v2/projects/paper/versions/$MC_VERSION/builds" 2>/dev/null) \
      || fail "minecraft version '$MC_VERSION' not supported by paper"
    BUILD=$(echo "$BUILDS" | jq -r '.builds[-1].build')
    JAR_NAME=$(echo "$BUILDS" | jq -r '.builds[-1].downloads.application.name')
    [ -z "$BUILD" ] || [ "$BUILD" = "null" ] && fail "no paper builds found for $MC_VERSION"
    rm -f server.jar
    curl -fL --progress-bar "https://api.papermc.io/v2/projects/paper/versions/$MC_VERSION/builds/$BUILD/downloads/$JAR_NAME" -o server.jar \
      || fail "paper jar download failed"
    verify_jar server.jar
    LAUNCH_JAR="server.jar"
    ok "paper $MC_VERSION build $BUILD downloaded"
    ;;
  *)
    fail "invalid server type"
    ;;
esac

# ----- accept EULA -----
echo "eula=true" > eula.txt
ok "EULA accepted"

# ----- first run to generate server.properties -----
info "first-running the server to generate config files..."
info "(this can take 2-5 minutes for fabric — it downloads minecraft + libraries)"
info "watching for server.properties to appear, then stopping the server..."

# Run server in background, watch for server.properties to appear
java -Xmx"$RAM_MAX" -jar "$LAUNCH_JAR" nogui > /tmp/mcfirstrun.log 2>&1 &
JAVA_PID=$!

# Wait up to 5 minutes for server.properties to appear AND have content
for i in {1..300}; do
  if [ -f server.properties ] && [ -s server.properties ]; then
    sleep 5  # let it finish writing other files
    break
  fi
  if ! kill -0 $JAVA_PID 2>/dev/null; then
    # Java exited — check if properties got generated
    break
  fi
  sleep 1
done

# Stop the java process gracefully
if kill -0 $JAVA_PID 2>/dev/null; then
  kill $JAVA_PID 2>/dev/null
  sleep 2
  kill -9 $JAVA_PID 2>/dev/null || true
fi

if [ ! -f server.properties ]; then
  warn "server.properties not generated. last 30 lines of server output:"
  tail -30 /tmp/mcfirstrun.log | sed 's/^/    /'
  fail "first-run failed. check $FOLDER and /tmp/mcfirstrun.log"
fi
ok "server.properties generated"

# ----- patch server.properties -----
info "configuring server.properties..."
patch_prop() {
  local key="$1" value="$2"
  if grep -q "^$key=" server.properties; then
    sed -i "s|^$key=.*|$key=$value|" server.properties
  else
    echo "$key=$value" >> server.properties
  fi
}
patch_prop "enable-rcon"  "true"
patch_prop "rcon.port"    "$RCON_PORT"
patch_prop "rcon.password" "$RCON_PW"
patch_prop "white-list"   "true"
patch_prop "server-port"  "$PORT"
patch_prop "query.port"   "$PORT"
ok "server.properties configured"

# ----- systemd unit -----
info "creating systemd unit..."
mkdir -p "$HOME/.config/systemd/user"
UNIT_FILE="$HOME/.config/systemd/user/mc-$NAME.service"
cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Minecraft server: $DISPLAY
After=network.target

[Service]
Type=simple
WorkingDirectory=$FOLDER
ExecStart=/usr/bin/java -Xms$RAM_MIN -Xmx$RAM_MAX -jar $LAUNCH_JAR nogui
Restart=on-failure
RestartSec=10
SuccessExitStatus=0 143

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable "mc-$NAME" >/dev/null 2>&1
ok "systemd unit mc-$NAME.service created and enabled"

# ----- env var -----
ENV_NAME="RCON_PASSWORD_$(echo "$NAME" | tr 'a-z-' 'A-Z_')"
info "adding $ENV_NAME to $DASHBOARD/.env..."
if grep -q "^$ENV_NAME=" "$DASHBOARD/.env"; then
  sed -i "s|^$ENV_NAME=.*|$ENV_NAME=$RCON_PW|" "$DASHBOARD/.env"
else
  echo "$ENV_NAME=$RCON_PW" >> "$DASHBOARD/.env"
fi
ok "$ENV_NAME written to .env"

# ----- servers.json -----
info "registering in $DASHBOARD/servers.json..."
TMP=$(mktemp)
jq --arg name "$NAME" \
   --arg display "$DISPLAY" \
   --arg folder "$FOLDER" \
   --arg unit "mc-$NAME.service" \
   --argjson rcon_port $RCON_PORT \
   --arg env "$ENV_NAME" \
   '.servers += [{
     "name": $name,
     "display_name": $display,
     "folder": $folder,
     "systemd_unit": $unit,
     "rcon": {
       "host": "127.0.0.1",
       "port": $rcon_port,
       "password_env": $env
     }
   }]' "$DASHBOARD/servers.json" > "$TMP"

# validate before replacing
if node -e "JSON.parse(require('fs').readFileSync('$TMP'))" 2>/dev/null; then
  mv "$TMP" "$DASHBOARD/servers.json"
  ok "servers.json updated"
else
  rm "$TMP"
  fail "generated servers.json was invalid. nothing changed."
fi

# ----- restart dashboard -----
info "restarting dashboard..."
systemctl --user restart dashboard
sleep 1
if systemctl --user is-active --quiet dashboard; then
  ok "dashboard back up"
else
  warn "dashboard service isn't active. check: journalctl --user -u dashboard --no-pager -n 30"
fi

# ----- done -----
echo
echo -e "${GREEN}================================================${NC}"
echo -e "${GREEN}  '$NAME' is ready                              ${NC}"
echo -e "${GREEN}================================================${NC}"
echo
echo "  type:        $(case $TYPE in 1) echo vanilla;; 2) echo fabric;; 3) echo paper;; esac) $MC_VERSION"
echo "  folder:      $FOLDER"
echo "  port:        $PORT"
echo "  rcon port:   $RCON_PORT"
echo "  systemd:     mc-$NAME.service"
echo
echo "next: log in to your dashboard and click 'start' on '$DISPLAY'."
echo "      (or grant another user a role on this server first via the users page.)"
echo
echo "to connect from minecraft:"
echo "  if you're on the same network: <server-ip>:$PORT"
echo "  if you've set up a public hostname for it, that hostname"
echo
