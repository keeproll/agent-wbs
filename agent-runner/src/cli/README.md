# cli — Claude·Codex CLI 어댑터 (M5-01)

어댑터(서로 다른 두 도구를 같은 모양으로 맞춰 주는 코드)가 하는 일은 셋이다.

1. CLI 실행 인자와 환경 변수를 만든다(`args.ts`, `env.ts`).
2. CLI 출력 스트림을 한 줄씩 읽어 같은 모양의 이벤트로 옮긴다(`stream.ts`, `claude.ts`, `codex.ts`, `adapters.ts`).
3. 출력에서 하위 Agent 수를 관측하고, 보유할 슬롯 수를 보수적으로 계산한다(`observe.ts`).

실제로 프로세스를 띄우고 강제 종료하는 일은 하지 않는다. 그것은 exec 계층(M5-02)이 한다.

## 실행 인자 (`buildLaunch`)

- Claude: `claude -p --output-format stream-json --verbose --settings {"disableAllHooks":true} <격리 옵션> --model <모델> --effort <값> [--resume <세션>]`
- Codex: `codex -c check_for_update_on_startup=false exec [resume] --json --disable hooks <격리 옵션> --model <모델> -c model_reasoning_effort="<값>" [<세션>] -`
- 지시문은 인자가 아니라 표준 입력(stdin)으로 넘긴다.
  - 왜: 프로세스 목록(`ps`)에 지시문이 보이지 않고, 인자 길이 제한도 피한다.
- hook(이벤트가 날 때 자동으로 부르는 사용자 스크립트)은 끈다.
  - 왜: G §6.7이 hook을 쓰지 않기로 확정했다. 사용자 설정에 hook이 있어도 세션에서는 돌지 않게 한다.
- Codex 작업 폴더는 `-C` 대신 프로세스의 현재 폴더(cwd)로 넘긴다.
  - 왜: `codex exec resume`에는 `-C`와 `--sandbox` 옵션이 없다. 새 실행과 재개가 같은 방법을 쓰게 맞췄다.
- 입력값 검사. 모두 `CliArgumentError`의 `code`로 알린다.
  - Effort는 `low`·`medium`·`high`·`xhigh`·`max`만 쓴다(owner Q-06). `ultra`나 다른 이름은 `effort_unmapped`.
  - 모델이 보고한 Effort 목록에 없으면 `effort_unsupported`, 목록이 미확인(null)이면 `effort_unconfirmed`.
  - 모델 ID·세션 ID가 `-`로 시작하거나 공백이 있으면 거부한다.
    - 왜: `--dangerously-…` 같은 값이 옵션으로 해석되는 것을 막는다.

## 환경 변수 (`sessionEnv`)

- 준비 점검·CLI 업데이트와 같은 allowlist(허용 목록에 있는 것만 통과시키는 방식)를 쓴다.
  - 허용: `PATH`, `HOME`, `USER`, `LANG`, `LC_ALL`, `TMPDIR`, `XDG_CONFIG_HOME`, 자기 CLI의 설정 폴더(`CODEX_HOME` 또는 `CLAUDE_CONFIG_DIR`).
  - 항상 추가: `DISABLE_AUTOUPDATER=1`, `DISABLE_UPDATES=1`. CLI 버전은 Runner만 바꾼다(architecture §5.1).
- 그래서 Runner·GitHub 토큰, SSH agent, `AWBS_*`, API 키, `NODE_OPTIONS` 같은 주입 변수는 넘어가지 않는다.
- 다른 CLI의 설정 폴더도 넘기지 않는다. 예: Codex 세션에는 `CLAUDE_CONFIG_DIR`이 없다.

## 격리 계층 (`IsolationLayer`, Q-08 = 전용 OS 계정)

- owner가 Q-08을 **(B) 전용 OS 사용자**로 정했다(2026-11-27). 설계·설치 절차는 [docs/isolation.md](../../docs/isolation.md).
- 경계는 둘이다.
  - `flags(agent)`: CLI 자체 sandbox·권한 모드 옵션.
  - `wrap(launch)`: 완성된 실행 계획을 감싼다.
- 기본값 `PENDING_ISOLATION`은 그대로다. 실행 계획을 만들지 않고 `IsolationUndecidedError`를 던진다.
  - 왜: 전용 계정이 설치되지 않은 PC(시험·CI)에서는 실제 실행을 만들면 안 된다.
- 전용 계정 계층 `dedicatedUserIsolation`(`dedicated-user.ts`):
  - `sudo -n -u <Agent 계정> -- <래퍼> run --agent … --cwd … -- <CLI 실제 경로> <인자>`로 감싼다.
  - 계정 이름 `awbs-agent`, 작업 영역 `/srv/agentwbs`, 래퍼 `/usr/local/libexec/awbs-agent-exec`는 고정값이다(`AGENT_USER`·`AGENT_ROOT`·`AGENT_EXEC`). `AWBS_AGENT_USER`에 다른 값을 넣으면 `agent_config_invalid`.
  - 작업 폴더는 `/srv/agentwbs/worktrees/` 안, CLI는 `/srv/agentwbs/cli/<agent>/` 안이어야 한다. 대상과 기준 폴더를 둘 다 실제 경로로 바꾼 뒤 비교한다. 밖이거나 실제 경로를 못 구하면 `cwd_outside_agent_root`·`binary_outside_agent_root`.
  - 환경 변수는 `LANG`·`LC_ALL`만 래퍼 인자로 넘긴다. HOME·PATH·TMPDIR는 래퍼가 Agent 계정 값으로 새로 만든다.
  - 권한 모드(`DEDICATED_FLAGS`): Claude `--permission-mode bypassPermissions`, Codex `-c approval_policy="never" -c sandbox_mode="workspace-write"`.
- `selectIsolation(env, run)`: `AWBS_AGENT_USER`가 없으면 거부 유지. 있으면 래퍼 `check`를 Agent 계정으로 돌린다.
  - `ok`이면 사용자 cgroup scope를 실제로 한 번 만들어 본다(`/usr/bin/env -i PATH=… XDG_RUNTIME_DIR=/run/user/<UID> systemd-run --user --scope … /bin/true`, 돈 들지 않음).
  - 둘 다 통과할 때만 `withUserScope(dedicatedUserIsolation(...))`(이름 `dedicated-user+user-scope`)를 쓴다. 실행 계획은 `systemd-run --user --scope … -- sudo … 래퍼 run …`이다(`src/exec/scope.ts`).
  - 왜 scope까지 보나: Runner는 Agent 계정 프로세스에 신호를 보낼 수 없다. scope 없이 띄우면 그룹을 빠져나간 Agent 자손을 끝냈다고 증명할 수 없다.
  - scope는 CLI 옵션(`flags`)을 바꾸지 않는다. 그래서 관측 등급 조합(`sessionOptions`)도 그대로다.
- `restoreAgentPermissions(path)`: 래퍼 `fix-perms`를 부르고 `fixed`가 아니면 `agent_permissions_unrestored`. 작업 폴더 삭제가 권한 문제로 막혔을 때 git 계층이 쓴다.
- `agentControl`: Agent 계정으로 도는 정리 명령(`kill-group`·`kill-all`·`fix-perms`·`check`). Runner 계정은 다른 계정 프로세스에 신호를 보낼 수 없기 때문이다.
- `sessionOptions(agent, isolation, kind)`은 관측 등급 조합의 「옵션」 문자열이다. readiness `cliProfiles`와 서버 `cliGrades`에 같은 값을 쓴다.
  - `kind`는 `new`(새 실행) 또는 `resume`(재개)이다. 재개는 다른 조합으로 센다.
    - 왜: 새 실행만 검증된 조합에 재개가 「검증됨」으로 붙으면 안 된다. G §6.7은 재개를 따로 검증할 항목으로 둔다.
  - 예: Codex 새 실행 `exec --json --disable hooks …`, 재개 `exec resume --json --disable hooks …`. Claude 재개는 끝에 `--resume`이 붙는다.
  - 세션 ID 값은 넣지 않는다.
  - 격리 옵션도 들어가므로 전용 계정 권한 모드로 바꾸면 조합도 바뀐다.

## 출력 해석

### 해석기 공통 규칙: 빠진 필드·모르는 값은 긍정 상태로 채우지 않는다 (재리뷰 5)

- 원문에 없는 값이나 모르는 값은 언제나 「모름(unknown)」이다. 실행 중·시작됨·끝남·전경·주 Agent 같은 긍정 상태로 채우지 않는다.
  - 왜: 긍정 상태는 시작 증명이나 「도구 결과로 끝내도 됨」 같은 다음 판단의 근거가 된다. 기본값 하나가 증명을 만들어 내면, 뒤의 완료 한 줄이 수를 지운다.
- 이 규칙을 적용한 곳:
  - Codex `agents_states[id]`에 status가 없거나, 상태가 객체가 아니거나, spawn 완료에 상태 항목 자체가 없으면 → phase `unknown`(실행 중으로 채우지 않음).
  - Codex `sender_thread_id`가 없으면 → 부모를 비워 둔다(주 Agent를 뜻하는 null로 채우지 않음).
  - Codex `turn.completed`에 `usage`가 없으면 → 토큰 0을 지어내지 않고 사용량 이벤트를 내지 않는다.
  - Claude `task_started`의 `is_backgrounded`가 불(boolean) 값이 아니면 → 배경 여부 모름. 도구 결과로 줄이지 않고 미확인이다.
  - Claude `parent_tool_use_id`가 없으면 → 주 Agent 글로 보지 않고 원문을 보존한다. Agent 호출의 부모도 비워 둔다.
  - Claude `task_notification`의 status가 없으면 → 끝으로 보지 않는다(원래부터 그랬다).
- 일부러 남긴 기본값과 이유:
  - run_id를 한 번도 쓰지 않는 task(구형 출력)는 run 키 하나(`''`)로 본다. 같은 task의 두 번째 시작은 모호(미확인)가 되므로, 지나간 run을 현재로 착각할 수 없다.
  - 오류 문구가 없으면 빈 문자열, 사용량 객체 안의 빠진 숫자는 0이다. 상태가 아니라 표시용 값이고, 수나 증명에 쓰지 않는다.


- `JsonlDecoder`는 한 줄에 JSON 하나인 출력을 읽는다. 파이프 조각이 줄이나 한글 글자 중간에서 잘려도 된다.
- 미완성 줄 조각은 딱 맞는 크기로 복사해 둔다. 큰 조각이나 너무 긴 줄의 원래 메모리를 붙잡지 않기 위해서다(`retainedBytes`로 확인).
- JSON이 아닌 줄도 버리지 않는다. `unparsed`로 원문과 줄 번호를 남긴다.
  - `invalid_json`(JSON 아님), `not_object`(객체 아님), `too_long`(너무 긴 줄 — 앞 4 KiB와 원래 크기), `truncated`(줄바꿈 없이 끊긴 마지막 조각).
- 모르는 이벤트는 `unknown`으로 원문을 그대로 보존하고 아무것도 추정하지 않는다(architecture §5 `cli`).
  - 이벤트 전체를 모르면 `path`가 없고, 이벤트 안의 한 조각만 모르면 `path`에 위치를 적는다. 예: `message.content[0]`.

## 하위 Agent 관측 (`reduce.ts`, `SubagentObserver`)

관측은 참고용이다. 슬롯 반환이나 종료 판단의 근거가 아니다. 그 근거는 프로세스 그룹뿐이다(G §6.7).

### 구조: 상태 없는 해석기 + 순수 reducer 하나

- 해석기(`claude.ts`, `codex.ts`)는 상태가 없다. 한 줄을 이벤트로 옮기기만 한다.
- 이벤트를 서로 연결하는 일은 모두 `reduceObservation(state, input) → state` 하나가 한다.
  - reducer(이전 상태와 입력을 받아 새 상태를 돌려주는 순수 함수)는 입력을 바꾸지 않는다. 같은 입력열이면 언제나 같은 결과다.
  - `SubagentObserver`는 이 reducer를 감싼 얇은 껍데기다.
- 왜: 연결 규칙이 해석기와 관측기에 나뉘어 있을 때, 한쪽에서 막은 늦은 메시지가 다른 경로(예: 도구 결과)로 들어와 현재 상태를 덮는 일이 세 번 반복됐다(M5-01 리뷰·재리뷰 1·2).

### 무엇을 「현재」로 보나 — 증명된 사실만

이벤트 안의 값(run_id 문자열 순서, 처음 본 run인지)으로 현재·다음 run을 추측하지 않는다.

- **launch 기록**: Runner가 이 CLI 프로세스를 직접 시작했다는 사실이다.
  - 관측기 하나 = 프로세스 하나. 같은 관측을 이어 프로세스를 다시 시작하면 `observer.launch()`를 부른다.
  - 새 launch가 시작되면 이전 launch의 하위 Agent는 끝을 볼 수 없으므로 수를 유지한 채 미확인이다. 이전 launch의 도구 호출에는 새 시작을 묶지 않는다.
- **도구 호출 순서**: 이 launch에서 모델이 낸 Agent 도구 호출이다. 한 스트림 안에서 모델 출력의 순서는 바뀌지 않는다.
  - run은 `task_started`의 `tool_use_id`로 자기 호출에 묶일 때만 생긴다. 한 호출에는 run 하나만 묶인다.
  - 한 task의 현재 run = 이 launch에서 가장 나중에 낸 호출에 묶인 run이다.
  - 예: `tool-A`(run 001) 뒤에 `tool-B`로 run 002가 시작되면 002가 현재다. 늦게 온 001의 완료·변경·도구 결과는 버린다.

### 한 원칙: 줄이거나 끝내는 전이는 「현재 launch에서 시작이 증명된 대상」에게만

- 수를 줄이는 전이는 모두 한 곳(`settle`)을 지난다. 도구 결과, 완료 알림, 완료 patch, Codex 완료 상태가 여기에 해당한다.
- 대상의 시작이 **현재 launch에서** 증명됐을 때만 줄인다. 그 밖에는 수를 그대로 두고 미확인으로만 남긴다.
  - Claude에서 「시작 증명」은 이 launch의 도구 호출에 `task_started`가 묶인 것이다. 도구 호출만 본 것은 증명이 아니다.
  - Codex에서 「시작 증명」은 이 launch의 스트림에서 실행 중(`running`·`pending_init`)으로 보고된 것이다.
- 시작 증명은 한 함수(`startObserved`)에서만 생긴다. **그 정확한 대상의 시작 이벤트를 현재 launch에서 관측**했을 때만 부른다(재리뷰 4).
  - 모르는 상태에서는 생기지 않는다. 예: Codex `not_found`·처음 보는 상태 값은 수를 1로 두고 미확인일 뿐, 시작 증명이 아니다.
  - 추정이나 다른 ID에서 옮겨 오지 않는다. 이전 launch의 증명을 현재 launch로 올리지도 않는다.
  - Claude 재개 호출은 같은 task의 별칭이라, 그 task의 `task_started`가 곧 그 대상의 시작 이벤트다.
  - 왜: 「보수적으로 1로 센다」와 「이번 launch에 시작했다고 증명한다」는 다르다. 둘을 섞으면, 모르는 상태 한 번을 거친 뒤 이전 launch의 완료가 수를 지운다.
- 예 1: 배경 Agent의 시작 보고가 빠지고 「시작됨」 도구 결과만 오면, 전경 완료인지 알 수 없다. 그래서 수를 1로 두고 미확인으로 남긴다.
- 예 2: 새 launch에서 이전 launch에 시작한 task의 완료가 오면, 이번 프로세스에서 증명된 종료가 아니다. 그래서 수를 두고 미확인으로 남긴다.
- launch마다 run 범위 상태(`ended`)를 처음으로 되돌린다. 이전 launch의 result가 이번 launch의 「결과 없는 종료」를 가리면 안 되기 때문이다.
  - 이전 launch의 미확인 표시와 보유 수는 이어받는다.
- 왜 한 원칙으로 묶나: 줄이는 경로가 여러 개면 한 경로만 막아도 다른 경로로 수가 사라진다. 리뷰마다 같은 부류가 다른 입구로 반복됐다.

### 이벤트 분류 (메시지 종류와 관계없이 같은 규칙)

- 현재 run의 이벤트 → 적용한다.
- 지나간 run의 이벤트 → 버린다(`dropped`로 센다). 현재 상태를 바꾸지 않는다.
- 연결을 증명할 수 없는 이벤트 → 상태를 바꾸지 않고 미확인만 남긴다.
  - 예: run_id 없음(run을 쓰는 task에서), 시작을 못 본 run, 모르는 호출·task, 이전 launch의 호출.
- 같은 호출이나 같은 run을 두 번째로 주장하는 시작 → 어느 쪽이 현재인지 증명할 수 없다.
  - run_id 순서로 고르지 않는다(owner 결정 B, 2026-11-27). 그 task를 「모호」로 표시한다.
  - 그 뒤로 그 task는 수를 줄이는 변경(완료 알림·도구 결과)을 적용하지 않고 미확인으로만 남긴다.
  - 결과: 관측 수는 유지되고, 보유는 보수 계산이 되며, 새 세션 시작은 보류된다(`test/cli/unconfirmed-path.test.ts`). 실제 해제는 프로세스 그룹 확인(M5-02)만 한다.
- 도구 결과는 그 Agent의 현재 run에 묶인 호출 ID일 때만 적용한다.
  - 재개가 새 호출로 오면 그 호출을 기존 Agent의 별칭으로 합친다. 같은 Agent가 둘로 남지 않는다.
  - 합쳐진 이전 호출 ID의 늦은 결과는 버린다.
- 배경 여부는 run을 시작할 때마다 다시 정한다. 현재 run의 `task_updated`(`patch.is_backgrounded`)만 바꿀 수 있다.
- 버리거나 미확인으로 남긴 이벤트는 실행 수를 줄일 수 없다. 그래서 늦은·중복·누락 메시지는 많아야 「더 많이 셈」이 된다.
  - property 시험(`test/cli/property.test.ts`, fast-check)이 무작위로 섞고·중복·지연·누락을 넣어 이것을 확인한다.
  - launch 경계, 배경 「시작됨」 도구 결과, 이전 launch의 완료까지 섞은 무작위 입력도 넣는다.
    - 기대값은 구현에서 구하지 않는다. 입력열만 보고 「줄여도 되는 근거」를 따로 계산하는 판정기(oracle)와 비교한다.
    - 불변식: 증명되지 않은 이벤트는 어떤 수도 줄이지 않는다. 또 `ended`는 이번 launch의 result만 반영한다.
    - 판정기는 「어느 ID가 어느 대상인지」도 따로 추적한다. 사라진 ID마다 그 이벤트가 바로 그 대상의 끝(또는 같은 대상으로의 합치기)을 증명하는지 본다.
      - 그래서 무관한 대상이 줄면 실패한다. 예: 두 번째 task의 시작이 첫 task의 Agent를 지우는 변이를 잡는다.
    - Codex 상태 보고(모르는 상태 포함)도 같은 판정기로 확인한다.

### 그 밖의 규칙

- 「끝났다」는 보고는 작업이 끝났다는 뜻이지 프로세스가 끝났다는 뜻이 아니다.
  - 예: Codex `spawn_agent` 완료는 생성 호출이 끝난 것뿐이다. 끝은 `agents_states`의 상태로만 본다.
- 배경 하위 Agent는 「시작됨」 도구 결과로 빼지 않는다. `task_notification`이 와야 뺀다.
- Claude 형식 결함은 해석기가 바로 미확인으로 알린다: id가 없는 Agent 호출, `task_id`·`task_type`이 없는 task 메시지.
- Codex는 같은 하위 Agent를 재개해도 같은 thread ID를 쓰고, 이벤트가 한 스트림에 순서대로 온다. 그래서 run 구분이 필요 없다.
- 아래 경우도 미확인이고, 한 번 그러면 되돌리지 않는다.
  - 모르는 상태 값, 깨진 줄, 결과 이벤트 없이 끝난 스트림.
  - 복구 불가능한 스트림 오류(Codex 최상위 `error`, 예: 연결 단절). 뒤에 실패 결과가 와도 미확인 그대로다.
    - 오류 이벤트 없이 온 실패 결과(예: 작업 실패 `turn.failed`)는 작업이 실패한 것일 뿐이라 관측은 정상이다.
  - 왜: 관측이 불완전할 때 수를 줄이면 실제로 돌고 있는 하위 Agent의 슬롯을 놓칠 수 있다(G §6.7 규칙 3).
- 스트림이 끝나도 남은 수를 0으로 만들지 않는다. 출력이 없거나 끊긴 것은 실행 수 0이 아니다.
- 미확인이 된 이유는 `observer.state.reasons`에 처음 20개까지 남는다(운영 로그용).

### M8 실측 확인 목록

- Claude SDK의 run_id 문자열 순서가 실제로 시작 순서를 따르는가. 지금은 이 순서를 쓰지 않는다(owner 결정 B).
- 재개가 실제로 새 `tool_use_id`로 오는가, 같은 호출을 다시 쓰는가. 같은 호출을 쓰면 지금 규칙은 그 task를 모호(미확인)로 둔다.
- 전경 재개가 실제로 있는가(공식 문서는 재개 하위 Agent가 배경으로 돈다고 설명한다).

## 보유 계산 (`sessionSlots`)

- `resources/concurrency.ts`의 `reservedSlots`를 그대로 쓴다.
- CLI는 항상 최신을 쓴다(owner Q-12). 그래서 새 버전은 재검증 전까지 미검증이고, `1 + max(예산, 관측, 직전 보유)`로 계산한다.
- 서버 `cliGrades`에서 이 조합이 `verified`이고 관측이 정상일 때만 `1 + 관측`을 쓴다.

## 시험

```sh
pnpm -C agent-runner test -- cli
```

- `dedicated-user.test.ts`는 「계정이 있다고 가정한」 명령 구성을, `agent-exec.test.ts`는 실행 래퍼를 실제 bash와 fake sudo로, `isolation-scripts.test.ts`는 설치·되돌리기·확인 스크립트를 가짜 루트 폴더와 가짜 sudo로 돌린다. 실제 계정·sudo는 쓰지 않는다.

- fixture는 `test/cli/fixtures/`에 있다. 공식 형식을 보고 만든 잠정본이고, 실제 CLI 기록은 아니다(그 폴더의 README 참고).
- `fake-run.test.ts`는 fake CLI(`test/fakes/cli.ts`)를 실제로 띄운다. 인자·stdin·환경 변수가 CLI까지 그대로 가는지 확인한다.
