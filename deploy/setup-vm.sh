#!/usr/bin/env bash
# One-time setup of the paper trader on a fresh Debian/Ubuntu VM (made for a Google Cloud e2-micro, works on any small Linux VM).
#   curl -fsSL https://raw.githubusercontent.com/westly2818/paper-t/main/deploy/setup-vm.sh -o setup-vm.sh && bash setup-vm.sh
# If the GitHub repo is private, download this file to the VM another way and run:  REPO_URL=https://<user>:<read-only-token>@github.com/westly2818/paper-t.git bash setup-vm.sh
# Safe to run again: it updates the code and keeps your .env.
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/westly2818/paper-t.git}"
APP=/opt/paper-trader
USER_NAME=papertrader

echo "== 1/5 packages and Node 20"
sudo apt-get update -y
sudo apt-get install -y curl git ca-certificates
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

echo "== 2/5 service user and code in $APP"
id "$USER_NAME" >/dev/null 2>&1 || sudo useradd --system --home "$APP" --shell /usr/sbin/nologin "$USER_NAME"
if [ -d "$APP/.git" ]; then
  sudo -u "$USER_NAME" git -C "$APP" pull --ff-only || true
else
  sudo rm -rf "$APP"
  sudo git clone "$REPO_URL" "$APP"
  sudo chown -R "$USER_NAME:$USER_NAME" "$APP"
fi

echo "== 3/5 settings file"
if [ ! -f "$APP/.env" ]; then
  sudo tee "$APP/.env" >/dev/null <<'EOF'
# Fill in the values, then: sudo systemctl restart paper-trader
MODE=live
PORT=3000
# Same database as before (Upstash): copy the two values from your PC's .env file
UPSTASH_REDIS_REST_URL=
UPSTASH_REDIS_REST_TOKEN=
# Same Gemini key as before (news check and mover scanner); either name works
LLM_API_KEY_FREE=
# Password for the dashboard (user name is admin). Choose a long one.
DASH_PASSWORD=
EOF
  sudo chown "$USER_NAME:$USER_NAME" "$APP/.env"; sudo chmod 600 "$APP/.env"
  NEED_ENV=1
fi

echo "== 4/5 service that starts on boot and restarts if it crashes"
sudo tee /etc/systemd/system/paper-trader.service >/dev/null <<EOF
[Unit]
Description=Paper trader (paper trading only, no broker orders)
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
WorkingDirectory=$APP
ExecStart=/usr/bin/node --env-file=$APP/.env server.js
Restart=always
RestartSec=5
# the bot saves its state when it is stopped; give it time
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable paper-trader >/dev/null

echo "== 5/5 start"
if [ "${NEED_ENV:-0}" = "1" ]; then
  echo
  echo "STOP: fill in the settings first:   sudo nano $APP/.env"
  echo "Then start it:                      sudo systemctl restart paper-trader"
else
  sudo systemctl restart paper-trader
  sleep 3
  sudo systemctl --no-pager --lines=5 status paper-trader || true
fi
echo
echo "Watch the log:   sudo journalctl -u paper-trader -f"
echo "Check it runs:   curl -s http://localhost:3000/health   (should print: ok)"
echo "Update later:    bash $APP/deploy/setup-vm.sh"
