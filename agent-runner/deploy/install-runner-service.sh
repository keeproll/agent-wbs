#!/usr/bin/env bash
# Runner를 systemd 사용자 서비스로 설치한다(M8-06). Runner 계정(사람 계정)으로, 저장소 맨 위 폴더에서 bash로 실행한다.
#
#   bash agent-runner/deploy/install-runner-service.sh --dry-run   # 아무것도 바꾸지 않고 점검·검증만
#   bash agent-runner/deploy/install-runner-service.sh             # 설치 + 부팅 때 자동 시작 등록(시작은 하지 않음)
#   bash agent-runner/deploy/install-runner-service.sh --uninstall # 멈추고 지움
#
# 선택: --name <이름>(기본 awbs-runner) · --node <node 실행 파일 절대 경로>(기본: 지금 PATH의 node) · --out <폴더>(--dry-run 결과를 둘 곳)
#
# 설치 전에 확인하는 것(하나라도 틀리면 설치하지 않는다):
#   1. linger가 켜져 있다. 왜: 재시작 뒤 아무도 로그인하지 않으면 사용자 systemd가 없어 Runner와 세션 scope가 뜨지 않는다.
#   2. Agent 전용 계정 awbs-agent와 root 소유 실행 래퍼가 있다(Q-08 B, agent-runner/docs/OWNER-RUNBOOK.md 1~2-2단계).
#   3. agent-runner/.env가 있고 권한이 600이며 AWBS_RUNNER_TOKEN 줄이 있다(값은 읽지 않는다).
#   4. node가 26.13 이상 26 계열이다.
# sudo를 쓰지 않는다. 관리자 단계(linger·전용 계정)는 owner가 먼저 한다(docs/ops/operations.md).
set -euo pipefail

name=awbs-runner
node_bin=""
mode=install
out=""
while (($#)); do
  case "$1" in
    --dry-run) mode=dry-run ;;
    --uninstall) mode=uninstall ;;
    --name) name="${2:?--name 값이 필요합니다}"; shift ;;
    --node) node_bin="${2:?--node 값이 필요합니다}"; shift ;;
    --out) out="${2:?--out 값이 필요합니다}"; shift ;;
    -h|--help) sed -n '2,16p' "$0"; exit 0 ;;
    *) echo "알 수 없는 선택: $1" >&2; exit 2 ;;
  esac
  shift
done
[[ "$name" =~ ^[a-z][a-z0-9-]{0,62}$ ]] || { echo "--name은 영문 소문자·숫자·-만 씁니다: $name" >&2; exit 2; }
if [[ "$(id -u)" == 0 ]]; then echo "root로 실행하지 마세요. Runner 계정으로 실행합니다." >&2; exit 2; fi

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
unit="$unit_dir/$name.service"

if [[ "$mode" == uninstall ]]; then
  systemctl --user disable --now "$name.service" 2>/dev/null || true
  rm -f "$unit"
  systemctl --user daemon-reload
  echo "지움: $unit"
  exit 0
fi

fails=0
ok() { printf '  OK    %s\n' "$*"; }
bad() { printf '  FAIL  %s\n' "$*"; fails=$((fails + 1)); }

echo "점검:"
if [[ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" == yes ]]; then ok "linger 켜짐($USER)"
else bad "linger가 꺼져 있습니다. owner 명령: sudo loginctl enable-linger $USER"; fi

if getent passwd awbs-agent >/dev/null; then ok "Agent 전용 계정 awbs-agent 있음"
else bad "awbs-agent 계정이 없습니다. agent-runner/docs/OWNER-RUNBOOK.md 2단계를 먼저 하세요."; fi

wrapper=/usr/local/libexec/awbs-agent-exec
if [[ -x "$wrapper" && "$(stat -c '%u' "$wrapper" 2>/dev/null)" == 0 ]]; then ok "실행 래퍼 $wrapper (root 소유)"
else bad "실행 래퍼 $wrapper 가 없거나 root 소유가 아닙니다. OWNER-RUNBOOK.md 2단계를 먼저 하세요."; fi

env_file="$repo/agent-runner/.env"
if [[ ! -f "$env_file" ]]; then bad "$env_file 이(가) 없습니다."
else
  [[ "$(stat -c '%a' "$env_file")" == 600 ]] && ok ".env 권한 600" || bad ".env 권한이 600이 아닙니다: chmod 600 $env_file"
  grep -qE '^AWBS_RUNNER_TOKEN=.{32,}' "$env_file" && ok ".env에 AWBS_RUNNER_TOKEN 있음(값은 보지 않음)" || bad ".env에 AWBS_RUNNER_TOKEN 값이 없습니다."
  if grep -qE '^AWBS_AGENT_USER=' "$env_file" && ! grep -qx 'AWBS_AGENT_USER=awbs-agent' "$env_file"; then
    bad ".env의 AWBS_AGENT_USER가 awbs-agent가 아닙니다. 서비스는 awbs-agent로 고정합니다."
  fi
fi

[[ -n "$node_bin" ]] || node_bin="$(command -v node || true)"
if [[ -n "$node_bin" && "$node_bin" == /* && -x "$node_bin" ]]; then
  version="$("$node_bin" -p 'process.versions.node')"
  if [[ "$version" =~ ^26\.([0-9]+)\. ]] && (( BASH_REMATCH[1] >= 13 )); then ok "node $version ($node_bin)"
  else bad "node $version 은(는) 맞지 않습니다(26.13 이상 26 계열)."; fi
else bad "node 실행 파일을 찾지 못했습니다. --node <절대 경로>로 알려 주세요."; fi

render() {
  sed -e "s|@NAME@|$name|g" -e "s|@REPO@|$repo|g" -e "s|@NODE@|$node_bin|g" -e "s|@NODE_DIR@|$(dirname "$node_bin")|g" \
    "$here/awbs-runner.service.in"
}

if [[ "$mode" == dry-run ]]; then
  dir="${out:-$(mktemp -d)}"
  install -d -m 0700 "$dir"
  render > "$dir/$name.service"
  echo
  echo "만든 파일(설치하지 않음): $dir/$name.service"
  if systemd-analyze --user verify "$dir/$name.service"; then echo "systemd-analyze verify: 통과"
  else echo "systemd-analyze verify: 실패"; fails=$((fails + 1)); fi
  echo "점검 실패 $fails 개(--dry-run은 점검 실패가 있어도 아무것도 바꾸지 않습니다)."
  exit 0
fi

if ((fails)); then echo "점검 실패 $fails 개. 설치하지 않았습니다." >&2; exit 1; fi
install -d -m 0755 "$unit_dir"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
render > "$tmp/$name.service"
systemd-analyze --user verify "$tmp/$name.service"
install -m 0644 "$tmp/$name.service" "$unit.new"
mv "$unit.new" "$unit"
systemctl --user daemon-reload
systemctl --user enable "$name.service"
echo
echo "설치함: $unit (부팅 때 자동 시작 등록됨, 아직 시작하지 않음)"
echo "시작:   systemctl --user start $name.service"
echo "상태:   systemctl --user status $name.service"
echo "로그:   journalctl --user -u $name.service -f"
