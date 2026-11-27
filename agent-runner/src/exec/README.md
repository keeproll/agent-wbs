# 세션 실행(M5-02)

이 계층은 서버가 승인한 일을 실행한다.
등급·재시도·Task 상태를 임의로 판단하지 않는다.
실제 CLI(명령줄 프로그램)는 Q-08 전용 계정 격리가 설치·확인된 PC에서만 실행한다(아래 「전용 계정 + 사용자 scope 실행」).
그 밖의 PC(시험·CI·미설치)는 지금처럼 기본 거부한다.
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
4. 설치 성공 뒤에만 `start`로 새 시도를 만들고 `status running`으로 실행 등급을 확인한다.
5. launch 기록을 디스크에 저장한 뒤 대기 래퍼를 새 프로세스 그룹으로 만든다.
6. 그룹 번호와 시작 시각을 저장하고 `/process`의 성공 응답을 기다린다.
7. 성공한 뒤에만 파이프로 실행을 허가한다.
8. 종료할 때 원래 세션과 같은 launchId의 자손이 비었음을 확인하고 물리 슬롯을 반환한다.

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

초기화는 원래 pgid가 비어 있어도 `launchCheck`로 자손을 먼저 대조한다.
그룹이 달라져도 원래 session ID(커널의 프로세스 세션 번호)를 유지한 자손은 함께 찾는다.
그 번호도 leader(세션을 처음 만든 프로세스)의 시작 시각과 대조한다.
번호를 다른 프로그램이 재사용했으면 그 프로그램을 종료하지 않는다.
별도 세션으로 나간 자손은 launchId 표식으로 찾는다.
왜: 부모의 종료나 빈 그룹만으로 자손 전체가 끝났다고 판단할 수 없기 때문이다.

서버가 슬롯 해제를 확인한 뒤 해당 launchId에 `completedAt`을 저장한다.
일반 재시작은 완료 기록을 다시 종료 대상으로 삼지 않는다.
옛 미완료 기록에 서버 보유가 없으면 자기 정체성과 맞는 프로세스만 정리한 뒤 기록을 완료한다.
타인이 재사용한 pgid를 종료하거나, 그 번호 때문에 새 시작을 막지 않는다.

현재 실행 경로는 같은 OS 사용자와 Linux `/proc`(커널이 제공하는 프로세스 정보)를 사용한다.
환경을 읽기 전에 공개 `stat`의 세션·부모 프로세스 번호(ppid)·시작 시각으로 소속을 가린다.
읽을 수 있는 launchId 표식으로 다른 세션의 자손도 찾는다.
무관한 프로세스의 EACCES(접근 권한 없음)는 건너뛴다.
소속 프로세스의 환경을 읽지 못하면 정리 미확인을 유지한다.
왜: 같은 사용자라도 ssh처럼 환경 읽기를 제한한 프로그램이 있으며, 무관한 프로그램 때문에 모든 실행의 종료 증명을 막으면 안 되기 때문이다.
TERM 처리 중 새 그룹을 만든 자손도 KILL 전에 다시 찾는다.
왜: 처음 찾은 그룹만 종료하면 정리 도중 분리된 자손이 남을 수 있다.

`pnpm -C agent-runner test:host -- cgroup`은 실제 Linux 커널에서 다음 범위를 검사한다.
유료 CLI 호출은 없다.
증거는 기본적으로 `agent-runner/test-results/host/run-*/`에 기록한다.
`AWBS_HOST_ARCHIVE`로 증거의 상위 폴더를 바꿀 수 있다.
실행마다 새 `run-*` 폴더를 만들므로 이전 실행이나 다른 clone의 증거를 덮어쓰지 않는다.
실측 결과는 그 안의 `host-facts.json`이다.
검증 기록에는 경로와 함께 `userScope.available`·종료 전후 측정값을 직접 적는다.
왜: 종료 코드만으로 어떤 커널 값을 확인했는지 알 수 없고 개인 PC의 경로만으로는 다른 사람이 결과를 읽을 수 없다.

- 같은 사용자이고 `AWBS_LAUNCH_ID`(실행 한 번을 식별하는 환경값)가 유지되면 자식·손자와 분리 자손을 정리한다.
  분리는 setsid(새 세션 만들기), nohup(터미널 연결 종료 신호 무시), 이중 fork(부모에서 두 번 갈라져 원래 부모를 벗어나기)로 시험한다.
- 시험 프로그램이 자기 `/proc/self/stat`에서 읽은 CPU(계산 장치) 시간과 RSS(실제 메모리에 올라온 크기)를 시험 코드가 합산한다.
  자손별 시점이 다르고 공유 메모리가 중복될 수 있으므로 cgroup 측정과 같은 값은 아니다.
  운영 Runner의 `/proc` 자원 합산은 아직 구현하지 않았다.
  다른 계정의 프로세스를 외부에서 읽을 수 있다는 검증도 아니다.
- 표식을 확인할 수 없고 원래 세션과 부모 연결도 잃은 자손은 현재 대안으로 찾지 못한다.
  이 한계 시험은 자손이 남음을 확인한 뒤 시험 코드가 직접 종료한다.
  따라서 현재 `group_empty` 결과만으로 임의 명령의 모든 자손이 없다고 보장할 수 없다.
- cgroup(커널이 프로세스 묶음을 관리하는 기능) v2의 현재 경로 생성 권한을 실제로 검사한다.
  별도로 systemd 사용자 scope(서비스 관리자가 만드는 실행 묶음)에 위임을 요청한다.
  허용되면 실행 허가 전에 시험 래퍼를 전용 cgroup으로 옮긴다.
  분리 방식과 환경 표식 제거에도 자손이 같은 묶음에 남는지 확인한다.
  `cpu.stat`·`memory.current`·`pids.current`로 측정한다.
  `cgroup.kill`로 종료한 뒤 `cgroup.events`의 `populated 0`을 확인한다.
  왜: 그룹·표식과 달리 자손이 커널의 실행 묶음을 상속하므로 함께 종료할 수 있다.

사용자 scope 위임·실측이 실패하면 오류를 기록하고 host 시험도 실패한다.
scope 안의 검사기가 이번 실행에 만든 실측 파일과 실제 측정값이 모두 있어야 통과한다.
가짜 명령이 성공 코드나 예전 결과를 표준 출력으로 돌려주는 것만으로는 통과하지 않는다.
이 시험은 같은 계정의 실측이다.
전용 계정 실행의 운영 연결은 아래 「전용 계정 + 사용자 scope 실행」과 `dedicated-scope.host.ts`가 본다.
서버 보고용 `LaunchRecord.cgroup`은 지금도 `null`이다(이유는 아래 절).
이 시험으로 실제 Claude·Codex의 관측 등급을 올리지 않는다.
CLI·버전·모델·옵션 조합의 등급은 실제 기록 검증 전까지 `unverified`(미검증)다.

## 전용 계정 + 사용자 scope 실행(M8 전 연결)

`AWBS_AGENT_USER=awbs-agent`이면 모든 세션과 ① 명령이 아래 모양으로 뜬다.

```text
/bin/sh(허가 대기) → /usr/bin/systemd-run --user --scope --quiet --collect --slice=app.slice --unit=awbs-<uuid> --
  /usr/bin/sudo -n -u awbs-agent -- /usr/local/libexec/awbs-agent-exec run --agent … --cwd … -- <CLI 실제 경로> <인자>
```

- scope(사용자 systemd가 프로세스 묶음에 붙이는 이름표, 커널에서는 cgroup 하나)는 Runner 계정의 사용자 systemd가 만든다.
  - 그래서 그 cgroup 파일은 Runner 계정 소유다. Agent 계정은 그 파일을 쓸 수 없어 scope 밖으로 나가지 못한다.
- `systemd-run --scope`는 자기 자신을 scope로 옮긴 뒤 sudo로 바뀐다(exec). 프로세스 번호가 그대로라 launch 정체성(pgid·시작 시각)이 유지된다.
- scope 이름(`awbs-<uuid>`)은 프로세스를 띄우기 **전에** launch 기록(`LaunchRecord.scope`)에 저장한다.
  - 왜: Runner가 그 사이 죽어도 다음 대조가 같은 scope를 찾아 비울 수 있어야 한다.
- cgroup 위치는 정해져 있다: `/sys/fs/cgroup/user.slice/user-<UID>.slice/user@<UID>.service/app.slice/awbs-<uuid>.scope`.

### 정리 순서

`Launches.reconcile`은 scope가 있는 launch를 이렇게 정리한다.

1. scope의 `cgroup.kill`에 1을 쓴다. 커널이 그 안의 모든 프로세스(sudo=root, Agent=awbs-agent)를 끝낸다.
2. `cgroup.events`의 `populated 0`(또는 systemd가 빈 scope를 지워 폴더가 없음)을 확인한다.
3. 지금처럼 프로세스 그룹을 대조한다. scope가 생기기 전의 허가 대기 셸·systemd-run은 이 단계가 끝낸다.
4. scope를 한 번 더 비우고 확인한 뒤에만 종료 증거(`group_empty`)를 낸다.

- 왜 scope가 필요한가: Runner(keeproll)는 다른 계정 프로세스에 신호를 보낼 수 없다(EPERM). `/proc`에서도 그 프로세스의 소속을 가리지 못한다.
  - 그래서 그룹만 보면 setsid·이중 fork로 그룹을 빠져나간 Agent 자손이 남아도 「비었다」고 증명하게 된다.
- 왜 두 번 비우나: 1과 3 사이에 대기 셸이 허가를 받아 scope를 새로 만들 수 있다. 그룹이 빈 뒤에는 새 scope를 만들 프로세스가 없다.
- scope를 비운 뒤 leader(sudo였던 프로세스)가 Runner에게 회수될 때까지 최대 1초 기다린다.
  - 왜: 회수 전에는 좀비(끝났지만 부모가 아직 거두지 않은 프로세스)가 그룹에 남아 그룹이 비지 않은 것으로 보인다.
- 비우지 못하면(쓰기 거부·시간 초과) 증거를 내지 않고 `unconfirmed`를 유지한다.

### 서버 보고(`/process`의 cgroup)

- scope로 띄운 launch는 `reportJobProcess.cgroup`에 그 scope의 cgroup 경로를 보낸다(조정자 결정 3, fix1).
  - 모양: `/user.slice/user-<UID>.slice/user@<UID>.service/app.slice/awbs-<uuid>.scope`(`/proc/<pid>/cgroup`의 `0::` 뒤와 같은 모양, `scopeCgroupPath`).
  - 이 경로는 launch 기록(`LaunchRecord.cgroup`)에도 실행 전에 저장한다.
- 해제 증거는 `cgroup_empty`(`{kind, bootId, processGroup, cgroup}`)다. 서버는 cgroup이 기록된 보유를 이것(또는 `boot_changed`)으로만 닫는다.
  - `Launches.reconcile`은 scope를 비운 것을 확인한 뒤에만 이 증거를 낸다. 서버 보유의 cgroup을 받으면 launch 기록과 같아야 한다. 다르면 증거를 내지 않는다(「모름」).
  - scope 없는 launch(시험용 fake 계층)는 지금처럼 `group_empty`다.
  - 초기화 정리(`cleanup/reset.ts`)도 cgroup이 기록된 보유에는 `cgroup_empty`를 보낸다.

### 격리 다시 확인

- `RunnerApp.refreshIsolation()`이 준비 점검 뒤·매일 점검·**실행 직전마다** `selectIsolation`을 다시 부른다.
  - 래퍼 `check`가 `ok`이고 사용자 scope를 실제로 한 번 만들 수 있을 때만 「전용 계정 + scope」(`dedicated-user+user-scope`)를 쓴다.
  - 하나라도 실패하면 그 실행을 거부하고(`isolation_undecided`), 새 claim도 받지 않는다. 이유가 바뀔 때만 경고한다.
- 왜 실행 직전마다 보나: 재부팅 뒤 `/run/WSL` 보호가 아직 안 돌았거나, linger(로그아웃·재시작 뒤에도 사용자 systemd를 띄워 두는 설정)가 꺼져 사용자 systemd가 없을 수 있다. 래퍼 `check`는 약 40ms다.

### ①·CI 명령(`Execution.command`)

- 격리 계층의 `command`로 감싼다. 전용 계정이면 `systemd-run --user --scope … -- sudo -n -u awbs-agent -- 래퍼 ci-run --cwd … [--env …] -- <명령> <인자>`다(조정자 결정 1).
  - 명령은 pipeline.yaml argv 그대로다. 이름(`pnpm`)이면 래퍼가 고정 PATH에서, 경로면 작업 폴더 안에서만 찾는다.
  - 환경 변수는 허용 목록(`CI_ENV_NAMES`: LANG·LC_ALL·TZ·CI·NODE_ENV·FORCE_COLOR·NO_COLOR·AWBS_REPORT·AWBS_REPORT_NONCE·AWBS_EVIDENCE_DIR)만 넘긴다.
  - 시험용 fake 계층(`command` 없음)만 `wrap`으로 대신한다.
- CI job(`integrate`·`ci_retry`)은 claim 때 물리 슬롯이 이미 `reserved`다. 그때는 `acquireJobSlots` 없이 그 예약으로 `/process`를 보낸다. 슬롯이 `none`이면(시도 job의 ①) 지금처럼 acquire한다.

### 남은 것

- scope의 `cpu.stat`·`memory.current`로 세션 자원을 재는 일은 M8-04(CLI 실측) 범위다(조정자 결정 5).

## Q-08 운영 연결 경계 — 전용 계정 격리 작업(아이템 16)

> M8 전 연결에서 1~5번을 위 절처럼 연결했다. 2번의 「`/process`에 실제 cgroup 경로」는 fix1에서 서버 계약(`cgroup_empty`, 마이그레이션 0041)과 함께 연결했다.
> 4번의 CPU·메모리 읽기는 M8-04 범위다.

조정자가 cgroup 운영 연결을 Q-08 전용 계정 격리 작업(아이템 16)에 배정했다.
전용 계정 CLI는 Runner 사용자가 소유한 systemd 사용자 scope 안에서 실행한다.
전용 계정 자신의 systemd 사용자 관리자가 있다는 가정은 하지 않는다.
이번 변경은 운영 실행을 연결하거나 새 공개 TypeScript API를 확정하지 않는다.
연결 작업이 주고받고 지켜야 할 정보는 다음과 같다.

1. scope 준비 쪽은 `launchId`·job·hostId·bootId를 받고 scope 이름과 세션 cgroup 경로를 돌려준다.
   실행 쪽은 그 경로를 실제 명령 생성 전에 launch 기록에 영속화한다.
   왜: Runner가 꺼져도 세션별로 남은 프로세스를 다시 찾을 수 있어야 한다.
2. 대기 래퍼를 세션 cgroup에 넣고 pgid·시작 시각을 기록한 뒤 `/process`에 실제 cgroup 경로를 보낸다.
   `/process` 성공 전에는 현재의 실행 허가 파이프를 열지 않는다.
   왜: 계정 전환이나 실제 CLI가 기록·서버 승인보다 먼저 실행되면 정리할 근거를 잃는다.
3. `IsolationLayer.wrap(Launch, agent)`는 계정 전환을 맡는다.
   명령·인자 배열·표준 입력 전달은 유지한다.
   순서는 세션 cgroup 배치 → 대기 래퍼 승인 → Q-08 계정 전환 래퍼 → 전용 계정 CLI다.
   계정 전환으로 환경값이 지워져도 자손은 같은 cgroup을 물려받아야 한다.
4. scope 관리 쪽은 cgroup 경로로 CPU·메모리·프로세스 수 읽기와 세션 전체 종료·비었음 확인을 제공해야 한다.
   종료·재시작·초기화는 같은 세션 기록을 사용한다.
   `cgroup.kill` 뒤 `cgroup.events`의 `populated 0`을 확인하기 전에는 보유를 풀지 않는다.
   접근 거부나 기록 유실은 `unconfirmed`를 유지한다.
   왜: 출력 종료·원래 pgid의 부재·다른 계정에 신호를 보낼 권한이 없다는 사실은 자손 종료 증거가 아니다.
5. cgroup 제어 파일은 Runner만 관리한다.
   Agent 계정에는 세션 밖 cgroup으로 이동하거나 제어 파일을 바꿀 권한을 주지 않는다.
   왜: 실행할 계정에 탈출 권한까지 주면 cgroup 전체 종료의 보장이 사라진다.

아이템 16에서는 전용 계정으로 setsid·nohup·이중 fork·환경 표식 제거를 다시 시험해야 한다.
Runner 강제 종료 뒤 같은 기록으로 자손을 정리하고 다른 세션을 보존하는지도 확인해야 한다.

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
`ExecutionOptions.canStart`에는 기존 `ResourceReporter.canStart()`를 연결한다.
claim과 실제 실행 허가에 최신 로컬 보유·준비 중 예약·상한·미확인을 사용한다.
`claim(capacity)`의 `capacity`는 전체 한도다.
Runner는 이 값을 줄이지 않고 서버에 그대로 보낸다.
기존 보유와 새 작업의 자리는 서버의 claim 트랜잭션 안에서 계산한다.
왜: Runner가 먼저 보유를 빼면 서버가 같은 보유를 다시 빼서 정상 실행을 막기 때문이다.
준비 중인 일도 비동기 작업 전에 자리를 예약한다.
start 직전과 `/process` 응답 뒤에도 자기 예약을 제외한 나머지 보유를 다시 검사한다.
왜: 서버에 관측을 보고하는 주기 사이에도 실제 로컬 보유는 늘어날 수 있기 때문이다.
출력은 파일 쓰기가 끝나기를 기다리며 읽는다.
왜: 디스크가 느릴 때 출력이 메모리에 계속 쌓이는 것을 막는다.

재개도 새 시도다.
`run(job, {resume:true})`일 때만 CLI 세션을 이어갈 후보를 찾는다.
작업 폴더·Agent·모델·Effort가 모두 같아야 기존 세션 ID를 사용한다.
하나라도 다르면 새 CLI 세션을 만든다.
서버가 등급을 정하므로 Runner가 이전 등급으로 바꾸지 않는다.
start 뒤에는 실제 실행할 모델·Effort를 `/status`의 `running`으로 보고한다.
서버가 저장한 등급과 다르면 CLI를 허가하지 않고 미실행 시도와 보유를 정리한다.

`command(job, agent, launch)`는 ① 검사 명령에 쓴다.
같은 `HeavySemaphore`로 기다린 뒤 `acquire → /process → slots/release`를 따른다.
명령도 세션과 같은 시작 검사기에 최신 로컬 보유와 예약을 넘긴다.
첫 대기 전에 한 자리를 예약한다.
무거운 작업 번호표를 받은 뒤와 `/process` 응답 뒤에도 다시 검사한다.
거부되면 실제 명령을 허가하지 않는다.
이미 예약한 서버 슬롯은 자손 종료 증명을 확인한 뒤 반환한다.
반환 증거는 `GET /api/runner/holds`에 기록된 pgid를 기준으로 고른다.
서버가 `/process`를 거부하여 pgid가 없으면 래퍼와 자손을 정리한 뒤 `no_process`를 보낸다.
서버가 pgid를 기록했으면 그 번호의 `group_empty` 증거만 보낸다.
로컬 launch 완료에는 실제 래퍼의 종료 증거를 사용한다.
왜: 서버가 받지 않은 새 번호를 보내면 슬롯 반환이 거부되고, 그 증거로 로컬 기록까지 완료하면 실행 정체성이 섞이기 때문이다.
종료를 증명하지 못하면 미확인 예약을 유지한다.
왜: 대기 중 자원이 부족해져도 명령이 우회해서 실행되면 안 되기 때문이다.
논리 잠금은 결과·후속 단계가 처리한다.

실제 사용한 하위 Agent는 CLI 기록 형식 검증 전까지 `partial`로 보고한다.
출력에 나타났다는 사실만으로 `confirmed`를 만들지 않는다.

## 시험

`pnpm -C agent-runner test -- exec`

fake CLI와 실제 Linux 프로세스만 쓴다.
실제 Claude·Codex·GitHub·SMTP·Telegram에는 연결하지 않는다.

`pnpm -C agent-runner test:host -- non-dumpable`은 실제 `prctl(PR_SET_DUMPABLE, 0)`으로 환경 읽기를 제한한다.
무관한 같은 사용자 프로세스와 시작 시각이 다른 번호 재사용은 우리 실행으로 취급하지 않는다.
우리 세션과 부모 연결로 확인되는 자손의 접근 거부는 정리 미확인으로 유지한다.
왜: 접근 거부를 무조건 실패시키거나 무조건 무시하는 두 회귀를 함께 막아야 하기 때문이다.

서버 슬롯 반환 회귀 표는 `agent-wbs/apps/api/test/runner.db.test.ts`의 `review3 matrix`로 검증한다.
아래 행 이름은 시험 이름이다.
새 API 상태를 뜻하지 않는다.
각 칸은 해당 상태에서 거부·실패·취소·강제 종료를 따로 실행하는 실제 DB(데이터베이스) 시험이다.

| 시험 행과 서버 보유 | 거부 reject | 실패 failure | 취소 cancel | 강제 종료 crash |
|---|---|---|---|---|
| reserved: reserved, pgid null | no_process | no_process | no_process | no_process |
| running: active, pgid 등록됨 | group_empty | group_empty | group_empty | group_empty |
| stopping: unconfirmed, pgid 등록됨 | group_empty | group_empty | group_empty | group_empty |
| unregistered-stopping: unconfirmed, pgid null | no_process | no_process | no_process | no_process |

`unregistered-stopping`은 등록 전에 실제 임대 감시가 보유를 미확인으로 바꾼 상태다.
그 상태를 먼저 만든 뒤 각 종료 원인을 발생시킨다.
왜: 미확인이라고 항상 서버에 pgid가 있는 것은 아니므로 별도 행으로 구분해야 한다.
강제 종료는 실제 SIGKILL(운영체제의 강제 종료 신호) 뒤 복구한다.
복구의 중단 보고가 상태를 unconfirmed로 바꾸어도 pgid 유무에 맞는 증거를 유지해야 한다.

별도 `running × lost-response` 시험은 서버 등록 성공 뒤 응답만 잃고 취소한다.
서버에 저장된 pgid의 group_empty로 반환되는지 확인한다.
왜: 응답을 받지 못했다고 서버에도 번호가 없다고 추정하면 안 되기 때문이다.
이 17개와 별도 기록 유실·부팅 변경 시험을 전체 상태 공간으로 해석하지 않는다.

실행 명령은 `pnpm -C agent-wbs test:db -- runner.db -t 'review3 matrix'`다.
새 전용 DB의 `TEST_DATABASE_URL`을 지정해야 한다.

M5-02 리뷰의 초기화 결함은 `pnpm -C agent-runner test:host -- m502-pending`으로 따로 재현한다.
첫 시험은 setsid 자손을 남긴 채 초기화가 완료되던 결함을 재현한다.
M5-02 리뷰 수정 뒤에는 자손 종료까지 확인하여 통과한다.
같은 파일의 번호 재사용 시험은 실제 다른 프로세스의 시작 시각을 대조해 종료하지 않는지 확인한다.
번호 자체의 커널 순환을 강제한 시험은 아니다.
왜: 기존 결함의 실패 증거와 M5-03의 `test:host -- cgroup` 실증 결과를 구분해야 한다.

`cgroup-proof.host.ts`의 세 시험은 가짜 명령의 성공 오판을 막는 회귀 시험이다.
이 세 시험 자체는 cgroup 위임·측정의 실증이 아니다.
`test:host -- cgroup`은 실제 커널 시험 6개와 이 회귀 시험 3개를 함께 실행한다.
