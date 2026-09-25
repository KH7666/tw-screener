#!/bin/bash
# ─────────────────────────────────────────────────────────────
# 台股即時行情中繼伺服器 — Oracle Cloud 主機初始化腳本
# 用法：建立主機時貼到「進階選項 → 管理 → 初始化指令碼（cloud-init）」
# 適用：Canonical Ubuntu 22.04 / 24.04（AMD 或 Ampere 皆可）
# 完成後網址會寫在 /opt/twss/URL（格式 https://<公用 IP>，憑證由 Let's Encrypt 直接簽給 IP）
# ─────────────────────────────────────────────────────────────
set -eux
REPO="https://github.com/KH7666/tw-screener.git"
exec > >(tee -a /var/log/twss-setup.log) 2>&1

timedatectl set-timezone Asia/Taipei
export DEBIAN_FRONTEND=noninteractive
APT="apt-get -o DPkg::Lock::Timeout=900"   # 開機時系統自動更新可能佔住 apt，最多等 15 分鐘
$APT update
$APT install -y python3-venv python3-pip git curl gnupg debian-keyring debian-archive-keyring apt-transport-https netfilter-persistent

# Caddy：自動申請 HTTPS 憑證（網頁在 https 上，WebSocket 必須是 wss）
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
$APT update
$APT install -y caddy

# Oracle 的 Ubuntu 映像預設用 iptables 擋掉 22 以外的連入：80/443 必須插在 REJECT 規則「之前」才會生效
N=$(iptables -L INPUT -n --line-numbers | awk '$2=="REJECT"{print $1; exit}')
N=${N:-1}
iptables -I INPUT "$N" -m state --state NEW -p tcp --dport 443 -j ACCEPT
iptables -I INPUT "$N" -m state --state NEW -p tcp --dport 80 -j ACCEPT
netfilter-persistent save

# 程式
id twss || useradd -r -m -d /opt/twss -s /usr/sbin/nologin twss
[ -d /opt/twss/app ] || git clone --depth 1 "$REPO" /opt/twss/app
python3 -m venv /opt/twss/venv
/opt/twss/venv/bin/pip install -U pip
/opt/twss/venv/bin/pip install -r /opt/twss/app/relay/requirements.txt
mkdir -p /var/lib/twss
chown -R twss:twss /opt/twss /var/lib/twss

cat > /etc/systemd/system/twss-relay.service <<'EOF'
[Unit]
Description=TW stock realtime relay
After=network-online.target
Wants=network-online.target

[Service]
User=twss
WorkingDirectory=/opt/twss/app
Environment=DATA_DIR=/var/lib/twss
ExecStart=/opt/twss/venv/bin/uvicorn relay.server:app --host 127.0.0.1 --port 8000 --proxy-headers --forwarded-allow-ips=127.0.0.1
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

# 每 10 分鐘檢查 GitHub repo：有新 commit 就自動套用（遠端維護不需 SSH）
cat > /opt/twss/update.sh <<'EOF'
#!/bin/bash
set -e
cd /opt/twss/app
sudo -u twss git fetch -q --depth 1 origin main
if [ "$(sudo -u twss git rev-parse HEAD)" != "$(sudo -u twss git rev-parse FETCH_HEAD)" ]; then
  sudo -u twss git reset -q --hard FETCH_HEAD
  /opt/twss/venv/bin/pip install -q -r relay/requirements.txt
  /opt/twss/render-caddy.sh
  systemctl restart twss-relay
  echo "$(date '+%F %T') 已更新到 $(sudo -u twss git rev-parse --short HEAD)" >> /var/log/twss-update.log
else
  /opt/twss/render-caddy.sh
fi
EOF
chmod +x /opt/twss/update.sh
cat > /etc/systemd/system/twss-update.service <<'EOF'
[Unit]
Description=Update TW stock relay from GitHub
[Service]
Type=oneshot
ExecStart=/opt/twss/update.sh
EOF
cat > /etc/systemd/system/twss-update.timer <<'EOF'
[Unit]
Description=Check GitHub for relay updates every 10 minutes
[Timer]
OnBootSec=5min
OnUnitActiveSec=10min
[Install]
WantedBy=timers.target
EOF

# HTTPS：Caddy 以 repo 的 deploy/Caddyfile.tmpl 產生設定，直接為公用 IP 申請憑證（不需網域）
cat > /opt/twss/render-caddy.sh <<'EOF'
#!/bin/bash
set -e
IP=$(curl -s --max-time 10 https://ifconfig.me || curl -s --max-time 10 https://api.ipify.org)
[ -n "$IP" ] || exit 1
NEW=$(sed "s/{IP}/$IP/g" /opt/twss/app/deploy/Caddyfile.tmpl)
if [ "$NEW" != "$(cat /etc/caddy/Caddyfile 2>/dev/null)" ]; then
  echo "$NEW" > /etc/caddy/Caddyfile
  systemctl reload caddy || systemctl restart caddy
fi
echo "https://$IP" > /opt/twss/URL
EOF
chmod +x /opt/twss/render-caddy.sh
/opt/twss/render-caddy.sh

systemctl daemon-reload
systemctl enable --now twss-relay twss-update.timer
systemctl restart caddy
echo "完成：$(cat /opt/twss/URL)"
