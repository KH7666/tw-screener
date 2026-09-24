#!/bin/bash
# ─────────────────────────────────────────────────────────────
# 台股即時行情中繼伺服器 — Oracle Cloud 主機初始化腳本
# 用法：建立主機時貼到「進階選項 → 管理 → 初始化指令碼（cloud-init）」
# 適用：Canonical Ubuntu 22.04 / 24.04（AMD 或 Ampere 皆可）
# 完成後網址會寫在 /opt/twss/URL（格式 https://<IP 以 - 連接>.sslip.io）
# ─────────────────────────────────────────────────────────────
set -eux
REPO="https://github.com/KH7666/tw-screener.git"
exec > >(tee -a /var/log/twss-setup.log) 2>&1

timedatectl set-timezone Asia/Taipei
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y python3-venv python3-pip git curl gnupg debian-keyring debian-archive-keyring apt-transport-https netfilter-persistent

# Caddy：自動申請 HTTPS 憑證（網頁在 https 上，WebSocket 必須是 wss）
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

# Oracle 的 Ubuntu 映像預設用 iptables 擋掉 22 以外的連入，開放 80/443
iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
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

# 每個交易日 08:30 自動拉最新程式並重啟（開盤前）
cat > /opt/twss/update.sh <<'EOF'
#!/bin/bash
set -e
cd /opt/twss/app
sudo -u twss git fetch --depth 1 origin main
if [ "$(sudo -u twss git rev-parse HEAD)" != "$(sudo -u twss git rev-parse FETCH_HEAD)" ]; then
  sudo -u twss git reset --hard FETCH_HEAD
  /opt/twss/venv/bin/pip install -q -r relay/requirements.txt
fi
systemctl restart twss-relay
EOF
chmod +x /opt/twss/update.sh
cat > /etc/systemd/system/twss-update.service <<'EOF'
[Unit]
Description=Update TW stock relay
[Service]
Type=oneshot
ExecStart=/opt/twss/update.sh
EOF
cat > /etc/systemd/system/twss-update.timer <<'EOF'
[Unit]
Description=Daily relay update before market open
[Timer]
OnCalendar=Mon..Fri 08:30 Asia/Taipei
Persistent=true
[Install]
WantedBy=timers.target
EOF

# HTTPS 網域：用 sslip.io（免註冊，IP 自動對應）
IP=$(curl -s --max-time 10 https://ifconfig.me || curl -s --max-time 10 https://api.ipify.org)
DOMAIN="${IP//./-}.sslip.io"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
  encode gzip
  reverse_proxy 127.0.0.1:8000
}
EOF
echo "https://$DOMAIN" > /opt/twss/URL

systemctl daemon-reload
systemctl enable --now twss-relay twss-update.timer
systemctl restart caddy
echo "完成：$(cat /opt/twss/URL)"
