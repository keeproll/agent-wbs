# 세션 실행(M5-02)

이 계층은 서버가 승인한 일을 실행한다.
등급·재시도·Task 상태를 임의로 판단하지 않는다.
실제 CLI(명령줄 프로그램)는 Q-08의 실행 격리가 정해지기 전까지 기본 거부한다.
시험은 기존 `IsolationLayer`에 fake(실제 서비스 대신 쓰는 시험 프로그램)를 넣는다.

## 실행 순서

`RunnerApp.bootstrap()`은 서버 보유 조회와 로컬 launch 기록 대조를 먼저 한다.
이 대조가 실패하면 `unconfirmed`(실행 종료를 확인하지 못함)를 유지한다.
왜: Runner가 꺼졌어도 이전 Agent가 파일을 바꾸고 있을 수 있다.

실행을 잇는 쪽은 `RunnerAppDeps.execution.prepare`로 M4 git 계층이 만든 작업 폴더와 HEAD(현재 커밋)를 제공한다.
`RunnerApp.execution`은 기존 세션 목록·무거운 작업 번호표·CLI 업데이트 관리자·outbox를 공유한다.
자동 실행 순서 전체는 M5-05가 이 진입점을 사용한다.

1. `recover()`가 `GET /api/runner/holds`로 현재 Runner의 현재 epoch(초기화 세대) 보유를 읽는다.
2. `claim(capacity)`이 작업을 받는다.
3. `run(job)`이 서버 등급과 정의를 읽고 하위 Agent를 설치한다.
4. 설치 성공 뒤에만 `start`로 새 시도를 만든다.
5. launch 기록을 디스크에 저장한 뒤 대기 래퍼를 새 프로세스 그룹으로 만든다.
6. 그룹 번호와 시작 시각을 저장하고 `/process`의 성공 응답을 기다린다.
7. 성공한 뒤에만 파이프로 실행을 허가한다.
8. 종료할 때 그룹과 같은 launchId의 자손이 비었음을 확인하고 물리 슬롯을 반환한다.

outbox는 전송 전에 요청을 디스크에 저장하는 발송함이다.
`start`·`/process`·해제·실패 보고는 먼저 여기에 들어간다.
응답을 잃으면 같은 키와 같은 본문으로 재시도한다.
왜: 서버가 이미 받은 요청을 새 요청으로 오해하면 시도나 보유가 중복될 수 있다.

## 중단과 재시작

`stop(attemptId)`와 `shutdown()`은 같은 그룹 종료 경로를 쓴다.
먼저 TERM(정상 종료 요청)을 보낸다.
남으면 KILL(강제 종료)을 보낸다.
출력 단절이나 부모 종료만으로 자손 종료를 추정하지 않는다.

래퍼는 허가 파이프가 닫히면 실제 명령을 실행하지 않고 끝난다.
재시작 때는 launchId와 시작 시각을 대조한다.
pgid(프로세스 그룹 번호)가 같아도 식별 정보가 다르면 그 프로그램을 죽이지 않는다.
로컬 기록 유실·손상·확인 불가는 해제 증거가 아니다.
같은 host(PC)에서 bootId(부팅 식별자)가 바뀐 경우에만 이전 실행이 없다고 확정할 수 있다.

현재 실행 경로는 같은 OS 사용자와 Linux `/proc`(커널이 제공하는 프로세스 정보)를 사용한다.
TERM 처리 중 새 그룹을 만든 자손도 KILL 전에 다시 찾는다.
왜: 처음 찾은 그룹만 종료하면 정리 도중 분리된 자손이 남을 수 있다.

`pnpm -C agent-runner test:host -- cgroup`은 실제 Linux 커널에서 다음 범위를 검사한다.
유료 CLI 호출은 없다.
결과는 `/home/keeproll/.orca/bots/agentwbs/archive/2026-11-27/M5-03/host-facts.json`에 기록한다.

- 같은 사용자이고 `AWBS_LAUNCH_ID`(실행 한 번을 식별하는 환경값)가 유지되면 자식·손자와 분리 자손을 정리한다.
  분리는 setsid(새 세션 만들기), nohup(터미널 연결 종료 신호 무시), 이중 fork(부모에서 두 번 갈라져 원래 부모를 벗어나기)로 시험한다.
- `/proc`에서 자손별 CPU(계산 장치) 시간과 RSS(실제 메모리에 올라온 크기)를 읽어 합산한다.
  자손별 시점이 다르고 공유 메모리가 중복될 수 있으므로 cgroup 측정과 같은 값은 아니다.
- 표식을 지우고 그룹 밖으로 나간 자손은 현재 대안으로 찾지 못한다.
  이 한계 시험은 자손이 남음을 확인한 뒤 시험 코드가 직접 종료한다.
  따라서 현재 `group_empty` 결과만으로 임의 명령의 모든 자손이 없다고 보장할 수 없다.
- cgroup(커널이 프로세스 묶음을 관리하는 기능) v2의 현재 경로 생성 권한을 실제로 검사한다.
  별도로 systemd 사용자 scope(서비스 관리자가 만드는 실행 묶음)에 위임을 요청한다.
  허용되면 실행 허가 전에 시험 래퍼를 전용 cgroup으로 옮긴다.
  분리 방식과 환경 표식 제거에도 자손이 같은 묶음에 남는지 확인한다.
  `cpu.stat`·`memory.current`·`pids.current`로 측정한다.
  `cgroup.kill`로 종료한 뒤 `cgroup.events`의 `populated 0`을 확인한다.
  왜: 그룹·표식과 달리 자손이 커널의 실행 묶음을 상속하므로 함께 종료할 수 있다.

사용자 scope 위임 실패는 성공으로 바꾸지 않고 오류와 대안의 보장 범위를 기록한다.
시험 성공은 운영 연결을 뜻하지 않는다.
현재 `LaunchRecord.cgroup`은 `null`이며 운영 실행은 이 시험의 scope를 쓰지 않는다.
Q-08의 `IsolationLayer.wrap(Launch, agent)` 경계는 그대로 유지한다.
전용 계정의 환경 초기화·종료 권한과 cgroup 밖으로 옮길 권한 차단은 격리 계층과 연결해 추가 확인해야 한다.
왜: 다른 사용자는 현재 `/proc` 탐색 대상이 아니며 Runner에게 직접 종료 권한도 없다.
이 시험으로 실제 Claude·Codex의 관측 등급을 올리지 않는다.
CLI·버전·모델·옵션 조합의 등급은 실제 기록 검증 전까지 `unverified`(미검증)다.

## 하위 Agent 설치

`key`는 Agent가 부를 안정된 이름이다.
UUID는 설치 파일 이름으로 쓰지 않는다.
`file`은 지시문 본문이다.
hash는 **그 본문의 UTF-8 바이트 SHA-256 소문자 hex**다(owner의 M5-02 결정).
버전·Agent·이름·hash를 검사한 뒤 서버의 `run-grade` 모델·Effort를 채운다.

- Claude: 작업 폴더의 `.claude/agents/<key>.md`.
- Codex: 작업 폴더의 `.codex/agents/<key>.toml`.

사용자 전체 설정 폴더에는 쓰지 않는다.
교체 전에 구·신 hash를 기록한다.
왜: 설치 도중 꺼져도 Runner가 소유한 파일을 확인하고 재시도할 수 있어야 한다.
사용자 파일이나 수정된 파일은 덮어쓰지 않는다.
설치 또는 서버의 버전 대조가 실패하면 `SUBAGENT_INSTALL_FAILED`를 보고한다.
실제 CLI는 실행하지 않는다.

정의의 `sandbox`는 지시문에도 남긴다.
실제 권한 통제는 `IsolationLayer`의 책임이다.
이 문구만으로 읽기 전용 격리가 보장된다고 보지 않는다.

## 예산과 재개

지시문에 동시 하위 Agent 예산을 넣는다.
M5-01의 관측기와 보유 계산을 그대로 사용한다.
스트림이 불완전하면 보유 수를 줄이지 않는다.
출력은 파일 쓰기가 끝나기를 기다리며 읽는다.
왜: 디스크가 느릴 때 출력이 메모리에 계속 쌓이는 것을 막는다.

재개도 새 시도다.
`run(job, {resume:true})`일 때만 CLI 세션을 이어갈 후보를 찾는다.
작업 폴더·Agent·모델·Effort가 모두 같아야 기존 세션 ID를 사용한다.
하나라도 다르면 새 CLI 세션을 만든다.
서버가 등급을 정하므로 Runner가 이전 등급으로 바꾸지 않는다.

`command(job, agent, launch)`는 ① 검사 명령에 쓴다.
같은 `HeavySemaphore`로 기다린 뒤 `acquire → /process → slots/release`를 따른다.
논리 잠금은 결과·후속 단계가 처리한다.

실제 사용한 하위 Agent는 CLI 기록 형식 검증 전까지 `partial`로 보고한다.
출력에 나타났다는 사실만으로 `confirmed`를 만들지 않는다.

## 시험

`pnpm -C agent-runner test -- exec`

fake CLI와 실제 Linux 프로세스만 쓴다.
실제 Claude·Codex·GitHub·SMTP·Telegram에는 연결하지 않는다.
