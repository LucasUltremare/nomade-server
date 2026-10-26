#!/usr/bin/env bash
# Mia · painel web pro Proxmox VE (projeto Nomade)
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/LucasUltremare/nomade-server/main/install.sh)"
#
# Roda no shell do host Proxmox, como root. Instala um binário único em
# /usr/local/bin/mia e um serviço systemd. Rodar de novo abre o menu de
# atualizar, reconfigurar ou desinstalar.
#
# Variáveis opcionais:
#   MIA_VERSION=v0.1.0   instala uma versão específica (padrão: a última release)
#   MIA_PORT=8443        porta HTTPS
#   MIA_YES=1            não pergunta nada (usa os padrões)
#   MIA_DOWNLOAD_URL=... baixa os arquivos da release de outro lugar (testes, mirror)
#
# Sem menu: bash install.sh [install|update|uninstall]

set -Eeuo pipefail

REPO="LucasUltremare/nomade-server"
APP="Mia"
BIN="/usr/local/bin/mia"
ETC="/etc/mia"
ENV_FILE="$ETC/mia.env"
DATA="/var/lib/mia"
UNIT="/etc/systemd/system/mia.service"
SVC_USER="mia"

# ---------- visual (no estilo community-scripts) ----------

YW=$'\033[33m'
BL=$'\033[36m'
RD=$'\033[01;31m'
GN=$'\033[1;92m'
DGN=$'\033[32m'
BGN=$'\033[4;92m'
CL=$'\033[m'
BOLD=$'\033[1m'
TAB="  "
CM="${TAB}✔️${TAB}${CL}"
CROSS="${TAB}✖️${TAB}${CL}"
INFO="${TAB}💡${TAB}${CL}"
WARN="${TAB}⚠️${TAB}${CL}"
SPINNER_PID=""

header_info() {
  [[ -t 1 ]] && clear 2>/dev/null || true
  cat <<'EOF'
    __  ____
   /  |/  (_)___ _
  / /|_/ / / __ `/
 / /  / / / /_/ /
/_/  /_/_/\__,_/

EOF
  echo -e "${TAB}${BOLD}painel web pro Proxmox VE${CL} ${DGN}· nomade${CL}\n"
}

spinner() {
  local frames=('⠋' '⠙' '⠹' '⠸' '⠼' '⠴' '⠦' '⠧' '⠇' '⠏') i=0
  while true; do
    printf "\r${TAB}${YW}%s${CL}${TAB}${YW}%s${CL}" "${frames[i++ % ${#frames[@]}]}" "$1"
    sleep 0.1
  done
}

stop_spinner() {
  if [[ -n "$SPINNER_PID" ]] && kill -0 "$SPINNER_PID" 2>/dev/null; then
    kill "$SPINNER_PID" 2>/dev/null || true
    wait "$SPINNER_PID" 2>/dev/null || true
  fi
  SPINNER_PID=""
  printf "\r\033[K"
}

msg_info() {
  stop_spinner
  if [[ -t 1 ]]; then
    spinner "$1" &
    SPINNER_PID=$!
  else
    echo -e "${TAB}…${TAB}$1"
  fi
}

msg_ok() {
  stop_spinner
  echo -e "${CM}${GN}$1${CL}"
}

msg_warn() {
  stop_spinner
  echo -e "${WARN}${YW}$1${CL}"
}

msg_error() {
  stop_spinner
  echo -e "${CROSS}${RD}$1${CL}"
}

on_error() {
  local code=$? line=$1
  stop_spinner
  echo -e "\n${CROSS}${RD}Falhou na linha ${line} (código ${code}): ${BASH_COMMAND}${CL}"
  [[ -s "${LOG:-}" ]] && echo -e "${INFO}${YW}Log: ${LOG}${CL}" && tail -n 15 "$LOG"
  exit "$code"
}
trap 'on_error $LINENO' ERR
trap stop_spinner EXIT

LOG="$(mktemp -t mia-install.XXXXXX.log)"
# Saída de comandos vai pro log; só os msg_* aparecem na tela.
run() { "$@" >>"$LOG" 2>&1; }

ask_yes() { # pergunta sim/não; em modo não interativo responde sim
  [[ "${MIA_YES:-}" == "1" ]] && return 0
  whiptail --backtitle "Mia · nomade" --title "$1" --yesno "$2" 12 64
}

# ---------- verificações ----------

check_root() {
  if [[ $EUID -ne 0 ]]; then
    msg_error "Rode como root (no shell do Proxmox)."
    exit 1
  fi
}

check_pve() {
  if ! command -v pveversion >/dev/null 2>&1; then
    msg_error "Isso não parece um host Proxmox VE (pveversion não encontrado)."
    exit 1
  fi
  local ver major
  ver="$(pveversion | grep -oP 'pve-manager/\K[0-9.]+' || true)"
  major="${ver%%.*}"
  if [[ -z "$major" || "$major" -lt 8 ]]; then
    msg_error "Precisa do Proxmox VE 8 ou 9 (achei: ${ver:-desconhecido})."
    exit 1
  fi
  PVE_VER="$ver"
}

detect_arch() {
  case "$(dpkg --print-architecture 2>/dev/null || uname -m)" in
    amd64 | x86_64) ARCH="amd64" ;;
    arm64 | aarch64) ARCH="arm64" ;;
    *)
      msg_error "Arquitetura não suportada: $(uname -m)"
      exit 1
      ;;
  esac
}

ensure_deps() {
  local missing=()
  for c in curl whiptail sha256sum tar; do
    command -v "$c" >/dev/null 2>&1 || missing+=("$c")
  done
  if ((${#missing[@]})); then
    msg_info "Instalando dependências (${missing[*]})"
    run apt-get update -qq
    run apt-get install -y -qq curl whiptail coreutils tar
    msg_ok "Dependências instaladas"
  fi
}

port_in_use() {
  ss -Hltn "sport = :$1" 2>/dev/null | grep -q .
}

host_ip() {
  hostname -I 2>/dev/null | awk '{print $1}'
}

# ---------- download ----------

resolve_version() {
  if [[ -n "${MIA_VERSION:-}" ]]; then
    VERSION="$MIA_VERSION"
    return
  fi
  msg_info "Buscando a última versão"
  VERSION="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" 2>>"$LOG" |
    grep -oP '"tag_name":\s*"\K[^"]+' || true)"
  if [[ -z "$VERSION" ]]; then
    msg_error "Não achei nenhuma release em github.com/${REPO}."
    exit 1
  fi
  msg_ok "Última versão: ${BL}${VERSION}${CL}"
}

download() {
  local base="${MIA_DOWNLOAD_URL:-https://github.com/${REPO}/releases/download/${VERSION}}"
  local file="mia_linux_${ARCH}.tar.gz"
  TMP="$(mktemp -d)"
  msg_info "Baixando ${APP} ${VERSION} (${ARCH})"
  run curl -fsSL -o "$TMP/$file" "$base/$file"
  run curl -fsSL -o "$TMP/checksums.txt" "$base/checksums.txt"
  msg_ok "Baixado ${APP} ${VERSION}"

  msg_info "Conferindo checksum"
  (cd "$TMP" && grep " ${file}\$" checksums.txt | sha256sum -c --status) || {
    msg_error "Checksum não bate. Abortando."
    exit 1
  }
  run tar -xzf "$TMP/$file" -C "$TMP"
  msg_ok "Checksum conferido"
}

install_binary() {
  msg_info "Instalando o binário"
  install -m 0755 "$TMP/mia" "$BIN"
  rm -rf "$TMP"
  msg_ok "Binário em ${BL}${BIN}${CL}"
}

# ---------- configuração ----------

choose_settings() {
  PORT="${MIA_PORT:-8443}"
  [[ "${MIA_YES:-}" == "1" ]] && return
  local mode
  mode=$(whiptail --backtitle "Mia · nomade" --title "Configuração" --menu \
    "\nComo você quer instalar?" 13 64 2 \
    "1" "Padrão (HTTPS na porta ${PORT})" \
    "2" "Avançado (escolher porta)" 3>&1 1>&2 2>&3) || exit 0
  if [[ "$mode" == "2" ]]; then
    PORT=$(whiptail --backtitle "Mia · nomade" --title "Porta" --inputbox \
      "\nPorta HTTPS do Mia (a 8006 é do Proxmox):" 10 64 "$PORT" 3>&1 1>&2 2>&3) || exit 0
  fi
  if ! [[ "$PORT" =~ ^[0-9]+$ ]] || ((PORT < 1 || PORT > 65535)); then
    msg_error "Porta inválida: $PORT"
    exit 1
  fi
}

create_user() {
  if ! id "$SVC_USER" >/dev/null 2>&1; then
    msg_info "Criando o usuário de sistema ${SVC_USER}"
    run useradd --system --home-dir "$DATA" --no-create-home --shell /usr/sbin/nologin "$SVC_USER"
    msg_ok "Usuário ${SVC_USER} criado"
  fi
  # www-data lê o certificado do pveproxy em /etc/pve/local, que o Mia reaproveita.
  run usermod -aG www-data "$SVC_USER"
}

write_config() {
  msg_info "Gravando configuração"
  install -d -m 0750 -o root -g "$SVC_USER" "$ETC"
  if [[ -f "$ENV_FILE" ]]; then
    sed -i "s|^MIA_LISTEN=.*|MIA_LISTEN=:${PORT}|" "$ENV_FILE"
  else
    cat >"$ENV_FILE" <<EOF
# Configuração do Mia. Depois de editar: systemctl restart mia
MIA_LISTEN=:${PORT}
MIA_PVE_URL=https://127.0.0.1:8006
MIA_DATA_DIR=${DATA}
# Certificado próprio (padrão: usa o mesmo do pveproxy)
#MIA_TLS_CERT=
#MIA_TLS_KEY=
EOF
  fi
  chmod 0640 "$ENV_FILE"
  chgrp "$SVC_USER" "$ENV_FILE"

  local caps=""
  if ((PORT < 1024)); then
    caps=$'AmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE'
  else
    caps="CapabilityBoundingSet="
  fi
  cat >"$UNIT" <<EOF
[Unit]
Description=Mia - painel web do Proxmox VE (nomade)
Documentation=https://github.com/${REPO}
After=network-online.target pveproxy.service
Wants=network-online.target

[Service]
User=${SVC_USER}
Group=${SVC_USER}
SupplementaryGroups=www-data
EnvironmentFile=${ENV_FILE}
ExecStart=${BIN} serve
StateDirectory=mia
StateDirectoryMode=0750
Restart=on-failure
RestartSec=3
${caps}
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX

[Install]
WantedBy=multi-user.target
EOF
  msg_ok "Configuração em ${BL}${ENV_FILE}${CL}"
}

start_service() {
  msg_info "Iniciando o serviço"
  run systemctl daemon-reload
  run systemctl enable mia
  run systemctl restart mia
  local i
  for i in $(seq 1 30); do
    if curl -fsk "https://127.0.0.1:${PORT}/api/meta" >/dev/null 2>&1; then
      msg_ok "Serviço no ar"
      return
    fi
    sleep 0.5
  done
  msg_error "O serviço não respondeu. Veja: journalctl -u mia -n 50"
  exit 1
}

current_port() {
  grep -oP '^MIA_LISTEN=.*:\K[0-9]+' "$ENV_FILE" 2>/dev/null || echo 8443
}

finish() {
  local ip
  ip="$(host_ip)"
  echo
  msg_ok "Pronto!"
  echo -e "${INFO}${YW}Acesse no navegador, com a mesma conta do Proxmox:${CL}"
  echo -e "${TAB}${TAB}${BGN}https://${ip:-<ip-do-host>}:${PORT}${CL}\n"
  echo -e "${TAB}${DGN}Logs:${CL}        journalctl -u mia -f"
  echo -e "${TAB}${DGN}Config:${CL}      ${ENV_FILE}"
  echo -e "${TAB}${DGN}Atualizar:${CL}   rode o mesmo comando de instalação de novo\n"
}

# ---------- fluxos ----------

do_install() {
  choose_settings
  if port_in_use "$PORT"; then
    msg_error "A porta ${PORT} já está em uso. Rode de novo e escolha outra em Avançado."
    exit 1
  fi
  resolve_version
  download
  install_binary
  create_user
  write_config
  start_service
  finish
}

do_update() {
  PORT="$(current_port)"
  local installed
  installed="$("$BIN" version 2>/dev/null || echo "?")"
  resolve_version
  if [[ "$installed" == "$VERSION" && -z "${MIA_VERSION:-}" ]]; then
    msg_ok "Já está na versão mais nova (${VERSION})"
    exit 0
  fi
  download
  msg_info "Parando o serviço"
  run systemctl stop mia
  msg_ok "Serviço parado"
  install_binary
  create_user
  write_config
  start_service
  msg_ok "Atualizado de ${installed} para ${VERSION}"
  finish
}

do_reconfigure() {
  PORT="$(current_port)"
  local old="$PORT"
  MIA_YES="" choose_settings
  if [[ "$PORT" != "$old" ]] && port_in_use "$PORT"; then
    msg_error "A porta ${PORT} já está em uso."
    exit 1
  fi
  write_config
  start_service
  finish
}

do_uninstall() {
  ask_yes "Desinstalar" "\nRemover o Mia deste host?\n\nO Proxmox e seus guests não são afetados." || exit 0
  msg_info "Removendo o serviço"
  run systemctl disable --now mia || true
  rm -f "$UNIT" "$BIN"
  run systemctl daemon-reload
  msg_ok "Serviço removido"
  if ask_yes "Dados" "\nApagar também a configuração e os dados?\n(${ETC}, ${DATA}: favoritos e certificado gerado)"; then
    rm -rf "$ETC" "$DATA"
    run userdel "$SVC_USER" || true
    msg_ok "Configuração e dados apagados"
  fi
  echo
  msg_ok "Mia desinstalado."
}

main() {
  header_info
  check_root
  check_pve
  detect_arch
  ensure_deps
  echo -e "${INFO}${YW}Proxmox VE ${PVE_VER} · ${ARCH}${CL}\n"

  case "${1:-}" in
    install) do_install; return ;;
    update) do_update; return ;;
    uninstall) do_uninstall; return ;;
  esac

  if [[ -x "$BIN" ]]; then
    local installed choice
    installed="$("$BIN" version 2>/dev/null || echo "?")"
    if [[ "${MIA_YES:-}" == "1" ]]; then
      do_update
      return
    fi
    choice=$(whiptail --backtitle "Mia · nomade" --title "Mia ${installed} já instalado" --menu \
      "\nO que você quer fazer?" 15 64 4 \
      "1" "Atualizar pra última versão" \
      "2" "Mudar a porta" \
      "3" "Desinstalar" \
      "4" "Sair" 3>&1 1>&2 2>&3) || exit 0
    case "$choice" in
      1) do_update ;;
      2) do_reconfigure ;;
      3) do_uninstall ;;
      *) exit 0 ;;
    esac
  else
    ask_yes "Mia" "\nInstalar o Mia neste host?\n\nÉ um painel web pro seu Proxmox: um binário + um serviço systemd. O login usa as próprias contas do Proxmox." || exit 0
    do_install
  fi
}

main "$@"
