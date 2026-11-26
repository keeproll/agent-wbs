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

## 격리 계층 (`IsolationLayer`, Q-08 대기)

- 실행 격리 수준(Q-08)은 owner 결정 전이다. 그래서 갈아끼울 수 있는 경계로만 둔다.
  - `flags(agent)`: CLI 자체 sandbox·권한 모드 옵션. 예: Codex `-c sandbox_mode="workspace-write"`.
  - `wrap(launch)`: 완성된 실행 계획을 감싼다. 예: 전용 OS 사용자로 실행, 컨테이너 안에서 실행.
- 기본값 `PENDING_ISOLATION`은 실행 계획을 만들지 않고 `IsolationUndecidedError`를 던진다.
  - 왜: architecture §4 「확정 전에는 fake 실행만」을 코드로 지킨다. 시험은 fake 격리 계층을 넘긴다.
- `sessionOptions(agent, isolation, kind)`은 관측 등급 조합의 「옵션」 문자열이다. readiness `cliProfiles`와 서버 `cliGrades`에 같은 값을 쓴다.
  - `kind`는 `new`(새 실행) 또는 `resume`(재개)이다. 재개는 다른 조합으로 센다.
    - 왜: 새 실행만 검증된 조합에 재개가 「검증됨」으로 붙으면 안 된다. G §6.7은 재개를 따로 검증할 항목으로 둔다.
  - 예: Codex 새 실행 `exec --json --disable hooks …`, 재개 `exec resume --json --disable hooks …`. Claude 재개는 끝에 `--resume`이 붙는다.
  - 세션 ID 값은 넣지 않는다.

## 출력 해석

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

- fixture는 `test/cli/fixtures/`에 있다. 공식 형식을 보고 만든 잠정본이고, 실제 CLI 기록은 아니다(그 폴더의 README 참고).
- `fake-run.test.ts`는 fake CLI(`test/fakes/cli.ts`)를 실제로 띄운다. 인자·stdin·환경 변수가 CLI까지 그대로 가는지 확인한다.
