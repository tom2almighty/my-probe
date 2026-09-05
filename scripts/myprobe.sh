#!/usr/bin/env bash
# MyProbe 一键部署脚本
#
#   sudo bash myprobe.sh                      # 交互菜单
#   sudo bash myprobe.sh install-server --mode docker --port 8000 --yes
#   sudo bash myprobe.sh install-agent --server ws://1.2.3.4:8000/ws/agent --secret xxx --yes
#
# 主控自带这个脚本，被监控机器可以直接从主控取，一条命令装完客户端：
#   curl -fsSL http://<主控>/install.sh | sudo bash -s -- install-agent \
#     --server ws://<主控>:8000/ws/agent --secret <密钥> --yes
# 密钥也可以走环境变量，避免落进 shell 历史：
#   curl -fsSL http://<主控>/install.sh | sudo MYPROBE_AGENT_SECRET=xxx bash -s -- \
#     install-agent --server ws://<主控>:8000/ws/agent --yes
#
# 安装时脚本会把自己放到 $BIN_DIR/myprobe，之后直接 myprobe <命令> 即可；
# 客户端默认开启每日自动更新（systemd timer），主控默认不开。
#
# 主控与客户端都支持二进制（systemd）和 Docker 两种部署方式。
# HTTPS / 反向代理不在脚本职责范围内，按需自行配置。

set -euo pipefail

REPO="${MYPROBE_REPO:-tom2almighty/my-probe}"
REGISTRY="${MYPROBE_REGISTRY:-ghcr.io/$(printf '%s' "${REPO%%/*}" | tr '[:upper:]' '[:lower:]')}"
CONF_DIR="${MYPROBE_CONF_DIR:-/etc/myprobe}"
DATA_DIR="${MYPROBE_DATA_HOME:-/var/lib/myprobe}"
BIN_DIR="${MYPROBE_BIN_DIR:-/usr/local/bin}"
SVC_USER=myprobe
IMAGE_UID=10001 # 镜像里的运行用户，Docker 模式下数据目录要归它
# 管道执行时脚本自己不是文件，自动更新需要一份能落地的副本，从这里取
SCRIPT_URL="${MYPROBE_SCRIPT_URL:-}"

# 命令行给的值优先，其次读已保存的配置，最后才问/取默认。
# 敏感参数也接受环境变量，一行命令里就不必把密钥写进 shell 历史。
OPT_MODE=""
OPT_PORT=""
OPT_PASSWORD="${MYPROBE_ADMIN_PASSWORD:-}"
OPT_SERVER="${MYPROBE_AGENT_SERVER:-}"
OPT_SECRET="${MYPROBE_AGENT_SECRET:-}"
OPT_NAME="${MYPROBE_AGENT_NAME:-}"
OPT_VERSION=""
OPT_AUTO_UPDATE=""
OPT_PURGE=0
OPT_FORCE=0
ASSUME_YES=0
MODE=""
PORT=""
VERSION=""
RESOLVED_VERSION=""
AUTO_UPDATE=""
PASSWORD=""
SERVER_URL=""
SECRET=""
AGENT_NAME=""
COMP=""

if [ -t 1 ]; then
  C_R=$'\033[31m' C_G=$'\033[32m' C_Y=$'\033[33m' C_B=$'\033[36m' C_D=$'\033[2m' C_0=$'\033[0m'
else
  C_R="" C_G="" C_Y="" C_B="" C_D="" C_0=""
fi

info() { printf '%s==>%s %s\n' "$C_B" "$C_0" "$*"; }
ok() { printf '%s[ok]%s %s\n' "$C_G" "$C_0" "$*"; }
warn() { printf '%s[!]%s %s\n' "$C_Y" "$C_0" "$*" >&2; }
die() {
  printf '%s[x]%s %s\n' "$C_R" "$C_0" "$*" >&2
  exit 1
}
ask() { # 提示 [默认值] -> stdout
  local ans=""
  if [ "$ASSUME_YES" = 1 ] || [ ! -r /dev/tty ]; then
    printf '%s' "${2-}"
    return
  fi
  {
    printf '%s%s%s' "$C_B" "$1" "$C_0"
    [ -n "${2-}" ] && printf ' %s[%s]%s' "$C_D" "$2" "$C_0"
    printf ': '
  } >/dev/tty
  read -r ans </dev/tty || true
  printf '%s' "${ans:-${2-}}"
}

confirm() { # 提示 -> 0 表示同意
  [ "$ASSUME_YES" = 1 ] && return 0
  case "$(ask "$1 (y/N)" N)" in
    y | Y | yes | YES) return 0 ;;
    *) return 1 ;;
  esac
}

need_root() { [ "$(id -u)" = 0 ] || die "需要 root 权限，请用 sudo 重新运行"; }

has_systemd() { [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; }

need_systemd() {
  has_systemd || die "未检测到 systemd，二进制方式无法托管，请改用 --mode docker"
}

need_docker() {
  command -v docker >/dev/null 2>&1 || die "未找到 docker，可先执行 curl -fsSL https://get.docker.com | sh"
  docker info >/dev/null 2>&1 || die "docker 不可用，请确认服务已启动且当前用户有权限"
}

fetch() { # url 目标文件
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$2" "$1"
  else
    die "需要 curl 或 wget"
  fi
}
detect_platform() { # -> Release 里的平台名
  [ "$(uname -s)" = Linux ] || die "一键脚本仅支持 Linux，其他系统请从 Release 手动下载"
  case "$(uname -m)" in
    x86_64 | amd64) echo linux-amd64 ;;
    aarch64 | arm64) echo linux-arm64 ;;
    *) die "不支持的架构 $(uname -m)，官方只发布 x86_64 / arm64 版本，其他架构请自行编译" ;;
  esac
}

script_source() { # -> 能下到脚本的 URL，尽最大努力猜一个
  if [ -n "$SCRIPT_URL" ]; then
    printf '%s' "$SCRIPT_URL"
    return
  fi
  # 优先从主控地址推导：ws://host:8000/ws/agent -> http://host:8000/install.sh
  local u="${SERVER_URL:-}"
  u="${u%/ws/agent}"
  case "$u" in
    wss://*)
      printf 'https://%s/install.sh' "${u#wss://}"
      return
      ;;
    ws://*)
      printf 'http://%s/install.sh' "${u#ws://}"
      return
      ;;
  esac
  printf 'https://raw.githubusercontent.com/%s/main/scripts/myprobe.sh' "$REPO"
}

# 把脚本自己装到 PATH 里：一是之后能直接敲 myprobe，二是自动更新的 timer
# 需要一个稳定的可执行路径。成功返回 0。
self_install() {
  local dest="$BIN_DIR/myprobe" tmp url
  if [ -f "$0" ] && [ -r "$0" ]; then
    if [ "$(readlink -f "$0")" = "$(readlink -f "$dest" 2>/dev/null)" ]; then
      return 0
    fi
    install -m 0755 "$0" "$BIN_DIR/.myprobe.new" || {
      warn "没能把脚本写到 $dest（自动更新需要它）"
      return 1
    }
  else
    # curl ... | bash 时 $0 是 bash / /dev/stdin，读不到脚本本体，只能重新下一份
    url=$(script_source)
    tmp=$(mktemp)
    if ! fetch "$url" "$tmp" || [ ! -s "$tmp" ]; then
      rm -f "$tmp"
      warn "没能把脚本保存到 $dest（自动更新需要它），可稍后手动放一份：$url"
      return 1
    fi
    install -m 0755 "$tmp" "$BIN_DIR/.myprobe.new" || {
      rm -f "$tmp"
      warn "没能把脚本写到 $dest（自动更新需要它）"
      return 1
    }
    rm -f "$tmp"
  fi
  # 正在执行的脚本文件不能原地覆盖，rename 换 inode 才安全
  mv -f "$BIN_DIR/.myprobe.new" "$dest"
  ok "脚本已安装到 $dest（之后可直接执行 myprobe）"
}

# VERSION=latest 时跟一次 releases/latest 的 302，拿到真实 tag。
# 这样才能判断"有没有新版本"，也能保证二进制和 SHA256SUMS 来自同一个 release。
# 解析不出来（网络受限 / 没有 curl -I）就回退 latest，行为跟以前一致。
resolve_version() {
  local want="${VERSION:-latest}" final=""
  if [ "$want" != latest ]; then
    printf '%s' "$want"
    return
  fi
  if command -v curl >/dev/null 2>&1; then
    final=$(curl -fsSLI -o /dev/null -w '%{url_effective}' --retry 2 \
      "https://github.com/$REPO/releases/latest" 2>/dev/null) || final=""
  elif command -v wget >/dev/null 2>&1; then
    final=$(wget -qS --spider "https://github.com/$REPO/releases/latest" 2>&1 \
      | awk '/[Ll]ocation:/ {print $2}' | tail -1) || final=""
  fi
  case "$final" in
    */releases/tag/?*) printf '%s' "${final##*/}" ;;
    *) printf 'latest' ;;
  esac
}

release_base() { # [tag]
  local tag="${1:-${VERSION:-latest}}"
  if [ "$tag" = latest ]; then
    echo "https://github.com/$REPO/releases/latest/download"
  else
    echo "https://github.com/$REPO/releases/download/$tag"
  fi
}

install_binary() { # server|agent；成功后 RESOLVED_VERSION 为实际安装的 tag
  local comp="$1" plat asset base tmp tag
  plat=$(detect_platform)
  asset="myprobe-$comp-$plat.tar.gz"
  tag=$(resolve_version)
  base=$(release_base "$tag")
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' RETURN

  info "下载 $asset（$tag）"
  fetch "$base/$asset" "$tmp/$asset" || die "下载失败：$base/$asset"
  if fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" 2>/dev/null; then
    (cd "$tmp" && grep " $asset\$" SHA256SUMS | sha256sum -c - >/dev/null 2>&1) \
      || die "校验和不匹配，已中止"
    ok "校验通过"
  else
    warn "该版本没有 SHA256SUMS，跳过校验"
  fi

  tar -xzf "$tmp/$asset" -C "$tmp"
  # 留一份旧的：新版本起不来时可以立刻回滚
  if [ -x "$BIN_DIR/myprobe-$comp" ]; then
    cp -f "$BIN_DIR/myprobe-$comp" "$BIN_DIR/myprobe-$comp.old"
  fi
  # 正在运行的可执行文件不能直接覆盖写，先落临时名再 rename
  install -m 0755 "$tmp/myprobe-$comp" "$BIN_DIR/.myprobe-$comp.new"
  mv -f "$BIN_DIR/.myprobe-$comp.new" "$BIN_DIR/myprobe-$comp"
  # tag 还是 latest 说明没解析出真实版本号，别记下来，否则以后判断"没变化"会永远跳过
  if [ "$tag" = latest ]; then RESOLVED_VERSION=""; else RESOLVED_VERSION="$tag"; fi
  ok "已安装 $BIN_DIR/myprobe-$comp（$tag）"
}

# 重启后等一下再看服务是否真的活着。Docker / 无 systemd 环境不做判断。
verify_service() { # comp -> 0 表示在跑
  [ "$MODE" = docker ] && return 0
  has_systemd || return 0
  sleep 3
  systemctl is-active --quiet "myprobe-$1"
}

rollback_binary() { # comp -> 0 表示已回滚
  local comp="$1" old="$BIN_DIR/myprobe-$1.old"
  [ -x "$old" ] || return 1
  warn "新版本启动失败，回滚到上一个版本"
  install -m 0755 "$old" "$BIN_DIR/.myprobe-$comp.new"
  mv -f "$BIN_DIR/.myprobe-$comp.new" "$BIN_DIR/myprobe-$comp"
  systemctl restart "myprobe-$comp" || true
}
ensure_user() {
  id -u "$SVC_USER" >/dev/null 2>&1 && return 0
  useradd --system --no-create-home --shell /usr/sbin/nologin "$SVC_USER" \
    || die "创建系统用户 $SVC_USER 失败"
}

save_conf() { # comp
  mkdir -p "$CONF_DIR"
  chmod 750 "$CONF_DIR"
  cat >"$CONF_DIR/$1.conf" <<EOF
# 由 myprobe.sh 生成，记录部署方式，供后续 update / restart 复用
MODE=$MODE
PORT=$PORT
VERSION=$VERSION
# 上次实际装上的 tag：VERSION=latest 时用它判断有没有新版本
RESOLVED_VERSION=$RESOLVED_VERSION
AUTO_UPDATE=$AUTO_UPDATE
EOF
}

# 读配置前先清空，避免上一个组件的值串到下一个
reset_conf() {
  MODE=""
  PORT=""
  VERSION=""
  RESOLVED_VERSION=""
  AUTO_UPDATE=""
}

load_conf() { # comp；有配置返回 0
  local f="$CONF_DIR/$1.conf"
  [ -f "$f" ] || return 1
  # shellcheck disable=SC1090
  . "$f"
  return 0
}

# 命令行 > 已保存的值（作为提问默认值）> 内置默认值；非交互时直接取默认
pick() { # 变量名 命令行值 已存值 提示 默认值
  local __var="$1" __opt="$2" __saved="$3" __prompt="$4" __default="$5" __val
  if [ -n "$__opt" ]; then
    __val="$__opt"
  else
    __val=$(ask "$__prompt" "${__saved:-$__default}")
  fi
  printf -v "$__var" '%s' "$__val"
}

env_val() { # comp 键 -> 现值
  sed -n "s|^$2=||p" "$CONF_DIR/$1.env" 2>/dev/null | head -1
}

image_of() { # comp -> 完整镜像名；镜像 tag 不带 v 前缀（metadata-action 生成的是 1.2.3）
  local tag="${VERSION:-latest}"
  echo "$REGISTRY/myprobe-$1:${tag#v}"
}

svc_of() { echo "myprobe-$1"; }
write_server_unit() {
  local extra=""
  # 1024 以下的端口需要额外授权，非 root 服务才能绑定
  [ "$PORT" -lt 1024 ] 2>/dev/null && extra="AmbientCapabilities=CAP_NET_BIND_SERVICE"
  cat >/etc/systemd/system/myprobe-server.service <<EOF
[Unit]
Description=MyProbe 主控
Documentation=https://github.com/$REPO
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
EnvironmentFile=$CONF_DIR/server.env
ExecStart=$BIN_DIR/myprobe-server
WorkingDirectory=$DATA_DIR
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=$DATA_DIR
$extra

[Install]
WantedBy=multi-user.target
EOF
}

write_agent_unit() {
  cat >/etc/systemd/system/myprobe-agent.service <<EOF
[Unit]
Description=MyProbe 客户端
Documentation=https://github.com/$REPO
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$SVC_USER
Group=$SVC_USER
EnvironmentFile=$CONF_DIR/agent.env
ExecStart=$BIN_DIR/myprobe-agent
Restart=always
RestartSec=5
# ICMP 探测要发原始包，只给这一个能力，其余按默认收紧
AmbientCapabilities=CAP_NET_RAW
CapabilityBoundingSet=CAP_NET_RAW
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true

[Install]
WantedBy=multi-user.target
EOF
}
write_update_timer() { # comp
  local comp="$1" svc="myprobe-$1-update"
  cat >"/etc/systemd/system/$svc.service" <<EOF
[Unit]
Description=MyProbe $comp 自动更新
Documentation=https://github.com/$REPO

[Service]
Type=oneshot
ExecStart=$BIN_DIR/myprobe update $comp --yes
EOF
  cat >"/etc/systemd/system/$svc.timer" <<EOF
[Unit]
Description=MyProbe $comp 每日检查更新

[Timer]
OnCalendar=daily
# 关机期间错过的时间点，开机后补跑一次
Persistent=true
# 随机推迟最多 1 小时，避免所有机器同一秒去打 GitHub
RandomizedDelaySec=1h
Unit=$svc.service

[Install]
WantedBy=timers.target
EOF
}

apply_auto_update() { # comp on|off
  local comp="$1" want="$2" svc="myprobe-$1-update" removed=0
  if [ "$want" = on ]; then
    if ! has_systemd; then
      warn "没有 systemd，自动更新用不了；可自行加 cron 定时执行 myprobe update $comp --yes"
      AUTO_UPDATE=off
      return 0
    fi
    # timer 要调用一个稳定路径上的脚本；已经装过就不用再下一次
    if [ ! -x "$BIN_DIR/myprobe" ] && ! self_install; then
      AUTO_UPDATE=off
      return 0
    fi
    write_update_timer "$comp"
    systemctl daemon-reload
    systemctl enable --now "$svc.timer" >/dev/null 2>&1 || warn "启用 $svc.timer 失败"
    AUTO_UPDATE=on
    ok "已开启每日自动更新（systemctl list-timers 可看下次执行时间）"
    return 0
  fi
  if has_systemd && [ -f "/etc/systemd/system/$svc.timer" ]; then
    systemctl disable --now "$svc.timer" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/$svc.timer" "/etc/systemd/system/$svc.service"
    systemctl daemon-reload
    removed=1
  fi
  AUTO_UPDATE=off
  if [ "$removed" = 1 ]; then ok "已关闭自动更新"; fi
  return 0
}

set_env_kv() { # 文件 键 值
  local f="$1" k="$2" v="$3"
  if grep -q "^$k=" "$f" 2>/dev/null; then
    v=${v//\\/\\\\}
    v=${v//|/\\|}
    v=${v//&/\\&}
    sed -i "s|^$k=.*|$k=$v|" "$f"
  else
    printf '%s=%s\n' "$k" "$v" >>"$f"
  fi
}

write_server_env() {
  local f="$CONF_DIR/server.env" addr datadir
  # Docker 模式容器内固定监听 8000、数据落 /data，端口和目录都在外面映射
  if [ "$MODE" = docker ]; then
    addr="0.0.0.0:8000"
    datadir="/data"
  else
    addr="0.0.0.0:$PORT"
    datadir="$DATA_DIR"
  fi
  mkdir -p "$CONF_DIR"
  chmod 750 "$CONF_DIR"
  if [ ! -f "$f" ]; then
    cat >"$f" <<EOF
# MyProbe 主控运行参数，改完执行 myprobe restart server 生效
MYPROBE_ADDR=$addr
MYPROBE_DATA_DIR=$datadir
# 仅首次启动生效；留空则随机生成一个并打印到日志
MYPROBE_ADMIN_PASSWORD=$PASSWORD
# 历史指标保留天数
MYPROBE_RETENTION_DAYS=14
# 心跳中断多少秒判定离线
MYPROBE_OFFLINE_AFTER=30
EOF
  else
    info "沿用已有的 $f"
  fi
  # 这两项必须跟部署方式对齐，其余保留用户改过的值
  set_env_kv "$f" MYPROBE_ADDR "$addr"
  set_env_kv "$f" MYPROBE_DATA_DIR "$datadir"
  if [ -n "$OPT_PASSWORD" ]; then set_env_kv "$f" MYPROBE_ADMIN_PASSWORD "$OPT_PASSWORD"; fi
  chmod 600 "$f"
}
write_agent_env() {
  local f="$CONF_DIR/agent.env"
  mkdir -p "$CONF_DIR"
  chmod 750 "$CONF_DIR"
  if [ ! -f "$f" ]; then
    cat >"$f" <<EOF
# MyProbe 客户端运行参数，改完执行 myprobe restart agent 生效
MYPROBE_AGENT_SERVER=$SERVER_URL
MYPROBE_AGENT_SECRET=$SECRET
# 留空则用后台里配置的名称
MYPROBE_AGENT_NAME=$AGENT_NAME
# 只统计这些网卡的流量（逗号分隔）；不填则自动跳过 lo/docker/veth 等虚拟口
#MYPROBE_AGENT_NET_IFACES=eth0
EOF
  fi
  set_env_kv "$f" MYPROBE_AGENT_SERVER "$SERVER_URL"
  set_env_kv "$f" MYPROBE_AGENT_SECRET "$SECRET"
  set_env_kv "$f" MYPROBE_AGENT_NAME "$AGENT_NAME"
  chmod 600 "$f"
}

run_docker() { # comp 额外参数...
  local comp="$1" image
  shift
  image=$(image_of "$comp")
  info "拉取 $image"
  docker pull "$image" >/dev/null || die "拉取镜像失败：$image"
  docker rm -f "myprobe-$comp" >/dev/null 2>&1 || true
  docker run -d --name "myprobe-$comp" --restart unless-stopped \
    --env-file "$CONF_DIR/$comp.env" "$@" "$image" >/dev/null
  ok "容器 myprobe-$comp 已启动"
}

# 拉一下镜像，如果和容器正在用的是同一个 image id，就没必要重建容器。
# 返回 0 表示已是最新。
docker_up_to_date() { # comp
  local comp="$1" image cur new
  image=$(image_of "$comp")
  cur=$(docker inspect -f '{{.Image}}' "myprobe-$comp" 2>/dev/null || true)
  [ -n "$cur" ] || return 1
  info "检查镜像 $image"
  docker pull "$image" >/dev/null 2>&1 || return 1
  new=$(docker image inspect -f '{{.Id}}' "$image" 2>/dev/null || true)
  [ -n "$new" ] && [ "$cur" = "$new" ]
}

apply_server() {
  if [ "$MODE" = docker ]; then
    need_docker
    mkdir -p "$DATA_DIR"
    # 镜像里以 uid 10001 运行，挂进去的目录得归它
    chown -R "$IMAGE_UID:$IMAGE_UID" "$DATA_DIR"
    run_docker server --security-opt no-new-privileges:true -p "$PORT:8000" -v "$DATA_DIR:/data"
  else
    need_systemd
    ensure_user
    mkdir -p "$DATA_DIR"
    chown -R "$SVC_USER:$SVC_USER" "$DATA_DIR"
    write_server_unit
    systemctl daemon-reload
    systemctl enable myprobe-server >/dev/null 2>&1 || true
    # 用 restart 而不是 start，重复执行安装/更新时也能拉起新二进制
    systemctl restart myprobe-server
    ok "systemd 服务 myprobe-server 已启动"
  fi
}
apply_agent() {
  if [ "$MODE" = docker ]; then
    need_docker
    # host 网络 + host pid 才能采到宿主机指标，NET_RAW 给 ICMP 探测，根目录只读挂载用于磁盘用量
    run_docker agent --network host --pid host --cap-add NET_RAW -v /:/host:ro
  else
    need_systemd
    ensure_user
    write_agent_unit
    systemctl daemon-reload
    systemctl enable myprobe-agent >/dev/null 2>&1 || true
    systemctl restart myprobe-agent
    ok "systemd 服务 myprobe-agent 已启动"
  fi
}

comp_state() { # comp -> 运行状态文字
  local comp="$1"
  if [ "$MODE" = docker ]; then
    if command -v docker >/dev/null 2>&1 \
      && [ "$(docker inspect -f '{{.State.Running}}' "myprobe-$comp" 2>/dev/null)" = true ]; then
      printf '%s运行中%s' "$C_G" "$C_0"
    else
      printf '%s未运行%s' "$C_R" "$C_0"
    fi
  elif has_systemd && systemctl is-active --quiet "myprobe-$comp"; then
    printf '%s运行中%s' "$C_G" "$C_0"
  else
    printf '%s未运行%s' "$C_R" "$C_0"
  fi
}

local_ip() {
  ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1)}' | head -1
}
check_mode() {
  case "$MODE" in
    binary | docker) ;;
    *) die "部署方式只能是 binary 或 docker" ;;
  esac
}

check_auto_update() {
  case "$AUTO_UPDATE" in
    on | off) ;;
    *) die "自动更新只能是 on 或 off" ;;
  esac
}

cmd_install_server() {
  need_root
  reset_conf
  load_conf server || true
  pick MODE "$OPT_MODE" "${MODE:-}" "部署方式 binary/docker" binary
  check_mode
  pick PORT "$OPT_PORT" "${PORT:-}" "主控监听端口" 8000
  pick VERSION "$OPT_VERSION" "${VERSION:-}" "版本（latest 或 v1.2.3）" latest
  # 主控默认不自动更新：升级可能带库迁移，交给人挑时间
  pick AUTO_UPDATE "$OPT_AUTO_UPDATE" "${AUTO_UPDATE:-}" "开启每日自动更新 on/off" off
  check_auto_update

  PASSWORD="$OPT_PASSWORD"
  if [ -z "$PASSWORD" ] && [ ! -f "$CONF_DIR/server.env" ]; then
    PASSWORD=$(ask "初始管理员密码（留空则自动生成）" "")
  fi

  write_server_env
  if [ "$MODE" = binary ]; then install_binary server; fi
  apply_server
  self_install || true
  apply_auto_update server "$AUTO_UPDATE"
  save_conf server

  local ip
  ip=$(local_ip)
  ok "主控已就绪：http://${ip:-本机IP}:$PORT"
  info "用户名 admin；没指定密码的话用 myprobe logs server 看日志里那串随机密码"
  info "被监控机器装客户端（密钥在后台添加服务器时生成）："
  printf '  curl -fsSL http://%s:%s/install.sh | sudo bash -s -- install-agent \\\n' \
    "${ip:-本机IP}" "$PORT"
  printf '    --server ws://%s:%s/ws/agent --secret <密钥> --yes\n' "${ip:-本机IP}" "$PORT"
  info "对外提供服务建议自行套一层 HTTPS 反向代理"
}

cmd_install_agent() {
  need_root
  reset_conf
  load_conf agent || true
  pick MODE "$OPT_MODE" "${MODE:-}" "部署方式 binary/docker" binary
  check_mode
  pick VERSION "$OPT_VERSION" "${VERSION:-}" "版本（latest 或 v1.2.3）" latest
  pick SERVER_URL "$OPT_SERVER" "$(env_val agent MYPROBE_AGENT_SERVER)" \
    "主控地址" "ws://127.0.0.1:8000/ws/agent"
  pick SECRET "$OPT_SECRET" "$(env_val agent MYPROBE_AGENT_SECRET)" "接入密钥（后台添加服务器时生成）" ""
  pick AGENT_NAME "$OPT_NAME" "$(env_val agent MYPROBE_AGENT_NAME)" "展示名（可留空）" ""
  # 客户端通常几十上百台，默认自动更新，省得逐台登上去升级
  pick AUTO_UPDATE "$OPT_AUTO_UPDATE" "${AUTO_UPDATE:-}" "开启每日自动更新 on/off" on
  check_auto_update

  case "$SERVER_URL" in
    ws://* | wss://*) ;;
    *) die "主控地址需以 ws:// 或 wss:// 开头" ;;
  esac
  # 少写 /ws/agent 是最常见的填错，直接补上
  case "$SERVER_URL" in
    */ws/agent) ;;
    *) SERVER_URL="${SERVER_URL%/}/ws/agent" ;;
  esac
  [ -n "$SECRET" ] || die "接入密钥不能为空"

  write_agent_env
  if [ "$MODE" = binary ]; then install_binary agent; fi
  apply_agent
  self_install || true
  apply_auto_update agent "$AUTO_UPDATE"
  save_conf agent
  ok "客户端已连向 $SERVER_URL"
  info "看运行情况：myprobe status / myprobe logs agent"
}
cmd_status() {
  local comp label desc ip
  ip=$(local_ip)
  printf '%s组件    方式      状态     版本         自动更新  备注%s\n' "$C_D" "$C_0"
  for comp in server agent; do
    reset_conf
    [ "$comp" = server ] && label="主控  " || label="客户端"
    if load_conf "$comp"; then
      if [ "$comp" = server ]; then
        desc="http://${ip:-本机IP}:$PORT"
      else
        desc=$(env_val agent MYPROBE_AGENT_SERVER)
      fi
      printf '%s  %-8s  %s  %-11s  %-8s  %s\n' "$label" "$MODE" "$(comp_state "$comp")" \
        "${RESOLVED_VERSION:-${VERSION:-latest}}" "${AUTO_UPDATE:-off}" "$desc"
    else
      printf '%s  %-8s  %s未安装%s\n' "$label" "-" "$C_D" "$C_0"
    fi
  done
}

svc_cmd() { # comp start|stop|restart
  need_root
  reset_conf
  load_conf "$1" || die "myprobe-$1 尚未安装"
  if [ "$MODE" = docker ]; then
    need_docker
    docker "$2" "myprobe-$1" >/dev/null
  else
    need_systemd
    systemctl "$2" "myprobe-$1"
  fi
  ok "myprobe-$1 $2 完成"
}

cmd_logs() { # comp
  reset_conf
  load_conf "$1" || die "myprobe-$1 尚未安装"
  if [ "$MODE" = docker ]; then
    need_docker
    docker logs -f --tail 100 "myprobe-$1"
  else
    need_systemd
    journalctl -u "myprobe-$1" -n 100 -f
  fi
}

cmd_auto_update() { # on|off，组件已解析到 COMP
  need_root
  case "${1:-}" in
    on | off) ;;
    *) die "用法：myprobe auto-update <on|off> [server|agent]" ;;
  esac
  reset_conf
  load_conf "$COMP" || die "myprobe-$COMP 尚未安装"
  apply_auto_update "$COMP" "$1"
  save_conf "$COMP"
}

# 更新：先判断有没有必要动，再动；binary 模式起不来就回滚。
# 自动更新的 timer 走的就是这个入口。
cmd_update() { # comp
  need_root
  reset_conf
  load_conf "$1" || die "myprobe-$1 尚未安装"
  if [ -n "$OPT_VERSION" ]; then
    VERSION="$OPT_VERSION"
    RESOLVED_VERSION=""
  fi

  if [ "$MODE" = docker ]; then
    need_docker
    if [ "$OPT_FORCE" = 0 ] && docker_up_to_date "$1"; then
      ok "镜像已是最新，不用重建容器"
      return 0
    fi
    if [ "$1" = server ]; then apply_server; else apply_agent; fi
  else
    need_systemd
    local tag
    tag=$(resolve_version)
    # 解析不出真实 tag（拿到 latest）时不敢判定"没变化"，老老实实重装
    if [ "$OPT_FORCE" = 0 ] && [ "$tag" != latest ] && [ "$tag" = "$RESOLVED_VERSION" ] \
      && [ -x "$BIN_DIR/myprobe-$1" ]; then
      ok "已是最新版本 $tag，跳过（要强制重装加 --force）"
      return 0
    fi
    install_binary "$1"
    if [ "$1" = server ]; then apply_server; else apply_agent; fi
    if ! verify_service "$1"; then
      rollback_binary "$1" || die "myprobe-$1 启动失败，且没有可回滚的版本，用 myprobe logs $1 看日志"
      # 故意不写 conf：磁盘上记的还是回滚后那个版本，下次更新会重试
      die "myprobe-$1 启动失败，已回滚到上一个版本"
    fi
  fi
  save_conf "$1"
  ok "myprobe-$1 已更新到 ${RESOLVED_VERSION:-${VERSION:-latest}}"
}
cmd_uninstall() { # comp
  need_root
  reset_conf
  load_conf "$1" || warn "没有 myprobe-$1 的部署记录，仍按默认路径清理"
  confirm "确认卸载 myprobe-$1？" || die "已取消"

  apply_auto_update "$1" off
  if command -v docker >/dev/null 2>&1; then
    docker rm -f "myprobe-$1" >/dev/null 2>&1 || true
  fi
  if has_systemd && [ -f "/etc/systemd/system/myprobe-$1.service" ]; then
    systemctl disable --now "myprobe-$1" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/myprobe-$1.service"
    systemctl daemon-reload
  fi
  rm -f "$BIN_DIR/myprobe-$1" "$BIN_DIR/myprobe-$1.old" "$CONF_DIR/$1.conf"
  ok "myprobe-$1 已卸载"

  # 数据库删了没法恢复：非交互模式下只有显式 --purge 才动它
  if [ "$1" = server ]; then
    local purge="$OPT_PURGE"
    if [ "$purge" = 0 ] && [ "$ASSUME_YES" = 0 ]; then
      confirm "同时删除数据目录 $DATA_DIR（含数据库，不可恢复）？" && purge=1 || purge=0
    fi
    if [ "$purge" = 1 ]; then
      rm -rf "$DATA_DIR"
      ok "已删除 $DATA_DIR"
    else
      info "数据保留在 $DATA_DIR"
    fi
  fi
  info "配置文件仍在 $CONF_DIR/$1.env，确认不再需要可手动删除"
  if [ ! -f "$CONF_DIR/server.conf" ] && [ ! -f "$CONF_DIR/agent.conf" ] \
    && [ -f "$BIN_DIR/myprobe" ]; then
    info "本机已无 MyProbe 组件，这个脚本可以一起删：rm -f $BIN_DIR/myprobe"
  fi
}

resolve_comp() { # 参数 -> 全局 COMP
  case "${1:-}" in
    server | s | 主控) COMP=server ;;
    agent | a | 客户端) COMP=agent ;;
    "")
      if [ "$ASSUME_YES" = 1 ] || [ ! -r /dev/tty ]; then die "请指定组件：server 或 agent"; fi
      case "$(ask "选择组件 1 主控 / 2 客户端" 1)" in
        2 | agent) COMP=agent ;;
        *) COMP=server ;;
      esac
      ;;
    *) die "组件只能是 server 或 agent" ;;
  esac
}
menu() {
  while true; do
    printf '\n%s MyProbe 部署助手 %s %s%s%s\n\n' "$C_B" "$C_0" "$C_D" "$REPO" "$C_0"
    cmd_status
    printf '\n  1) 安装 / 更新主控\n  2) 安装 / 更新客户端\n  3) 查看日志\n  4) 重启\n'
    printf '  5) 停止\n  6) 更新到最新版\n  7) 自动更新开关\n  8) 卸载\n  0) 退出\n\n'
    case "$(ask "请选择" 0)" in
      1) cmd_install_server ;;
      2) cmd_install_agent ;;
      3)
        resolve_comp ""
        cmd_logs "$COMP"
        ;;
      4)
        resolve_comp ""
        svc_cmd "$COMP" restart
        ;;
      5)
        resolve_comp ""
        svc_cmd "$COMP" stop
        ;;
      6)
        resolve_comp ""
        cmd_update "$COMP"
        ;;
      7)
        resolve_comp ""
        cmd_auto_update "$(ask "自动更新 on/off" on)"
        ;;
      8)
        resolve_comp ""
        cmd_uninstall "$COMP"
        ;;
      0 | q | Q) exit 0 ;;
      *) warn "无效选项" ;;
    esac
  done
}
usage() {
  cat <<EOF
MyProbe 一键部署脚本

用法: sudo bash $0 [命令] [组件] [参数]

命令:
  menu                      交互菜单（不带命令时的默认行为）
  install-server            安装 / 更新主控
  install-agent             安装 / 更新客户端
  status                    查看部署状态
  logs <server|agent>       跟踪日志
  start|stop|restart <组件>  启停
  update <组件>              有新版本才更新，起不来自动回滚
  auto-update <on|off> <组件> 每日自动更新开关（systemd timer）
  uninstall <组件>           卸载

参数:
  --mode <binary|docker>    部署方式，默认 binary
  --port <端口>              主控监听端口，默认 8000
  --password <密码>          主控初始管理员密码，留空则自动生成
  --server <ws 地址>         客户端要连的主控地址
  --secret <密钥>            客户端接入密钥
  --name <名称>              客户端展示名
  --version <latest|vX.Y.Z>  指定版本，默认 latest
  --auto-update             安装时开启自动更新（客户端默认开，主控默认关）
  --no-auto-update          安装时关闭自动更新
  --force                   update 时即使版本没变也重装
  --purge                   卸载主控时连数据目录一起删
  -y, --yes                 非交互，全部取默认值

被监控机器一条命令装完客户端（脚本由主控提供，版本自动对齐）:
  curl -fsSL http://<主控>/install.sh | sudo bash -s -- install-agent \\
    --server ws://<主控>:8000/ws/agent --secret <密钥> --yes

环境变量:
  MYPROBE_AGENT_SECRET / MYPROBE_AGENT_SERVER / MYPROBE_AGENT_NAME
  MYPROBE_ADMIN_PASSWORD    与同名参数等价，适合避免密钥进 shell 历史
  MYPROBE_AGENT_NET_IFACES  客户端只统计这些网卡（逗号分隔），默认自动跳过 lo/docker/veth 等
  MYPROBE_SCRIPT_URL        自动更新时重新下载本脚本的地址
  MYPROBE_REPO（默认 $REPO）MYPROBE_REGISTRY MYPROBE_CONF_DIR MYPROBE_DATA_HOME MYPROBE_BIN_DIR
EOF
}
ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --mode | --port | --password | --server | --secret | --name | --version)
      [ $# -ge 2 ] || die "$1 需要一个参数"
      case "$1" in
        --mode) OPT_MODE="$2" ;;
        --port) OPT_PORT="$2" ;;
        --password) OPT_PASSWORD="$2" ;;
        --server) OPT_SERVER="$2" ;;
        --secret) OPT_SECRET="$2" ;;
        --name) OPT_NAME="$2" ;;
        --version) OPT_VERSION="$2" ;;
      esac
      shift 2
      ;;
    --purge)
      OPT_PURGE=1
      shift
      ;;
    --auto-update)
      OPT_AUTO_UPDATE=on
      shift
      ;;
    --no-auto-update)
      OPT_AUTO_UPDATE=off
      shift
      ;;
    --force)
      OPT_FORCE=1
      shift
      ;;
    -y | --yes)
      ASSUME_YES=1
      shift
      ;;
    -*) die "未知参数 $1，用 -h 看用法" ;;
    *)
      ARGS+=("$1")
      shift
      ;;
  esac
done
set -- ${ARGS[@]+"${ARGS[@]}"}

case "${1:-menu}" in
  menu) menu ;;
  install-server) cmd_install_server ;;
  install-agent) cmd_install_agent ;;
  status) cmd_status ;;
  logs)
    resolve_comp "${2:-}"
    cmd_logs "$COMP"
    ;;
  start | stop | restart)
    resolve_comp "${2:-}"
    svc_cmd "$COMP" "$1"
    ;;
  update)
    resolve_comp "${2:-}"
    cmd_update "$COMP"
    ;;
  auto-update)
    resolve_comp "${3:-}"
    cmd_auto_update "${2:-}"
    ;;
  uninstall)
    resolve_comp "${2:-}"
    cmd_uninstall "$COMP"
    ;;
  *)
    usage
    die "未知命令 $1"
    ;;
esac
