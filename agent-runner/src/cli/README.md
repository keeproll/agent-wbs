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
- `sessionOptions(agent, isolation)`은 관측 등급 조합의 「옵션」 문자열이다. readiness `cliProfiles`와 서버 `cliGrades`에 같은 값을 쓴다.

## 출력 해석

- `JsonlDecoder`는 한 줄에 JSON 하나인 출력을 읽는다. 파이프 조각이 줄이나 한글 글자 중간에서 잘려도 된다.
- JSON이 아닌 줄도 버리지 않는다. `unparsed`로 원문과 줄 번호를 남긴다.
  - `invalid_json`(JSON 아님), `not_object`(객체 아님), `too_long`(너무 긴 줄 — 앞 4 KiB와 원래 크기), `truncated`(줄바꿈 없이 끊긴 마지막 조각).
- 모르는 이벤트는 `unknown`으로 원문을 그대로 보존하고 아무것도 추정하지 않는다(architecture §5 `cli`).
  - 이벤트 전체를 모르면 `path`가 없고, 이벤트 안의 한 조각만 모르면 `path`에 위치를 적는다. 예: `message.content[0]`.

## 하위 Agent 관측 (`SubagentObserver`)

관측은 참고용이다. 슬롯 반환이나 종료 판단의 근거가 아니다. 그 근거는 프로세스 그룹뿐이다(G §6.7).

- 같은 ID는 한 번만 센다. `done`이면 뺀다.
- 「끝났다」는 보고는 작업이 끝났다는 뜻이지 프로세스가 끝났다는 뜻이 아니다.
  - 예: Codex `spawn_agent` 완료는 생성 호출이 끝난 것뿐이다. 끝은 `agents_states`의 상태로만 본다.
- 배경 하위 Agent는 「시작됨」 도구 결과로 빼지 않는다. `task_notification`이 와야 뺀다.
- 아래 경우는 `unconfirmed`(미확인)로 두고, 한 번 그러면 되돌리지 않는다.
  - 모르는 상태 값, ID 없는 생성, 깨진 줄, 결과 이벤트 없이 끝난 스트림.
  - 왜: 관측이 불완전할 때 수를 줄이면 실제로 돌고 있는 하위 Agent의 슬롯을 놓칠 수 있다(G §6.7 규칙 3).
- 스트림이 끝나도 남은 수를 0으로 만들지 않는다. 출력이 없거나 끊긴 것은 실행 수 0이 아니다.

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
