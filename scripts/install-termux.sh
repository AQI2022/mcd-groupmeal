#!/data/data/com.termux/files/usr/bin/bash
# ============================================================================
#  mcd-groupmeal · Android 手机本地安装脚本（Termux）
#
#  装完之后，这部手机自己就是服务器：不用开电脑、不用同一个 Wi-Fi，
#  断网了也能打开界面（只是算价需要联网到麦当劳官方 MCP）。
#
#  用法（在 Termux 里逐行执行）：
#      pkg install -y git
#      git clone https://github.com/AQI2022/mcd-groupmeal.git
#      bash mcd-groupmeal/scripts/install-termux.sh
#
#  脚本会做：
#    1. 安装 Node.js（Termux 官方源）
#    2. 检查版本是否 >= 20（引擎要求）
#    3. 引导你粘贴 MCP Token 并写入 mcp-config.json（不回显、不进仓库）
#    4. 生成 ~/mcd 启动脚本（带 termux-wake-lock，防止后台被杀）
#    5. 跑一次自检，并打印手机上要打开的地址
# ============================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
START_SCRIPT="$HOME/mcd"
PORT="${MCD_PORT:-8787}"

say()  { printf '\033[1;32m%s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m%s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

say "==> mcd-groupmeal · Termux 本地安装"
say "    项目目录：$REPO_DIR"

# ── 1. Node.js ──────────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  say "==> 安装 Node.js（这一步要下载几十 MB，慢是正常的）"
  pkg update -y || true
  pkg install -y nodejs || die "nodejs 安装失败。请先执行：pkg update && pkg upgrade"
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  die "Node 版本过低（当前 $(node -v)，需要 >= 20）。
     Termux 源里的 nodejs 一般已经是 20+；如果还是旧的，执行：
       pkg update && pkg upgrade
       pkg install -y nodejs-lts"
fi
say "    Node $(node -v) OK"

# ── 2. 依赖：零运行时依赖，只做完整性检查 ───────────────────────────────────
for f in src/server.mjs src/cli.mjs public/index.html; do
  [ -f "$REPO_DIR/$f" ] || die "项目不完整，缺少 $f（是不是只下载了部分文件？）"
done
say "    项目文件完整（零运行时依赖，不需要 npm install）"

# ── 3. Token ────────────────────────────────────────────────────────────────
CFG="$REPO_DIR/mcp-config.json"
if [ -f "$CFG" ]; then
  warn "    已存在 mcp-config.json，跳过 Token 输入（想重填就先删掉它）"
else
  cat <<'EOF'

  请粘贴你的麦当劳 MCP Token。
    · 获取/激活地址：https://open.mcd.cn/mcp
    · 粘贴时不会显示字符，这是正常的；粘贴完按回车。

EOF
  printf '  Token: '
  read -rs TOKEN
  echo
  TOKEN="$(printf '%s' "$TOKEN" | tr -d '[:space:]' | sed 's/^Bearer//I')"
  [ -n "$TOKEN" ] || die "Token 为空，已中止。"
  cat > "$CFG" <<EOF
{
  "mcpServers": {
    "mcd-mcp": {
      "type": "streamablehttp",
      "url": "https://mcp.mcd.cn",
      "headers": {
        "Authorization": "Bearer $TOKEN"
      }
    }
  }
}
EOF
  chmod 600 "$CFG"
  say "    Token 已写入 $CFG（权限 600，且该文件已被 .gitignore 排除，不会进仓库）"
fi

# ── 4. 启动脚本 ─────────────────────────────────────────────────────────────
cat > "$START_SCRIPT" <<EOF
#!/data/data/com.termux/files/usr/bin/bash
# 由 install-termux.sh 生成：启动手机本地的「麦麦省」服务
cd "$REPO_DIR"
# 让 Termux 在后台不被系统杀掉（对长时间比价很重要）
command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
echo "手机浏览器打开：http://127.0.0.1:$PORT/"
echo "（localhost 属于安全上下文，可以「添加到主屏幕」变成独立 App）"
# 只监听回环地址：同一 Wi-Fi 下的其他设备访问不到，所以不需要访问码
exec node src/server.mjs --port $PORT --host 127.0.0.1 --no-key
EOF
chmod +x "$START_SCRIPT"
say "    已生成启动脚本：$START_SCRIPT"

# ── 5. 自检 ─────────────────────────────────────────────────────────────────
say "==> 自检（doctor）"
if node "$REPO_DIR/src/cli.mjs" doctor; then
  say "    自检通过"
else
  warn "    自检没通过——先确认 Token 是否有效、手机是否联网。"
fi

cat <<EOF

============================================================
  装好了。以后每次这样用：

    1. 打开 Termux，输入：  ~/mcd
    2. 手机浏览器打开：     http://127.0.0.1:$PORT/
    3. 首次建议先「添加到主屏幕」，以后点图标就行

  小技巧：
    · 想让它一打开 Termux 就自动起服务，执行一次：
        echo '~/mcd' >> ~/.bashrc
    · 想换端口： MCD_PORT=9000 bash scripts/install-termux.sh
    · 这个服务只监听 127.0.0.1（所以不需要访问码），Token 也只存在这台手机本地；
      换了新手机请重新跑一遍本脚本，不要把 mcp-config.json 传到别处。
============================================================
EOF
