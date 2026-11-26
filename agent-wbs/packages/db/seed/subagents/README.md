# 실제 하위 Agent 정의 (system seed, M5-06)

하위 Agent(subagent)는 Agent 세션이 일을 나눠 맡기는 보조 Agent다.
이 폴더는 운영에 쓰는 하위 Agent 정의의 원본이다.

- 원본 화면의 Mock 정의(P `SUB_MOCK`)는 `../demo.json`에만 있고, demo seed만 그것을 쓴다(D-24).
- 이 폴더의 정의는 Mock 문안을 쓰지 않고 새로 작성했다. 검토 기록은 `REVIEW.md`에 있다.

## 파일

| 파일 | 내용 |
| --- | --- |
| `manifest.json` | 정의 목록. 이름(`key`)·버전·Agent·역할·도구·권한 표시·허용·참고 링크·파일·hash |
| `claude/<key>.v<버전>.md` | Claude Code 하위 Agent 파일. Runner가 worktree의 `.claude/agents/`에 그대로 설치한다 |
| `codex/<key>.v<버전>.toml` | Codex 하위 Agent 파일. Runner가 worktree의 `.codex/agents/`에 그대로 설치한다 |
| `common-rules.md` | 모든 정의에 똑같이 들어가는 공통 규칙 블록 |
| `REVIEW.md` | 검토 기준과 검토한 정의·버전·hash |

## hash

- hash는 정의 파일 내용(UTF-8 바이트)의 sha256 16진수 64자다.
- DB `subagent_defs.text`에는 파일 내용을, `hash`에는 이 값을 넣는다.
- Runner는 받은 파일 내용으로 hash를 다시 계산해 비교한 뒤 설치한다.
  - 왜: 전달 중에 내용이 바뀌거나 다른 버전이 섞이면 설치 전에 알아챌 수 있다.

## 파일에 적지 않는 것

- 모델·Effort(추론 강도). Runner가 설치할 때 실행 정책 등급으로 채운다(G §7.4).
- hook 설정. 이 시스템은 hook을 쓰지 않는다(G §6.7).
- 관리 대상 저장소의 스택·경로, Runner 계약 전용 지시(D-24). 이런 것은 Task 지시문이 정한다.

## 정의를 바꾸거나 더하는 방법

1. 이미 넣은 버전의 파일은 고치지 않는다. 새 버전 파일(예: `claude/ui-builder.v2.md`)을 만든다.
   - 왜: DB의 정의는 버전마다 내용이 바뀌지 않는다(버전 불변). 같은 버전의 내용이 다르면 seed가 멈춘다.
2. `manifest.json`에 새 항목을 더하고 hash를 적는다.
3. 교차 검토를 받고 `REVIEW.md` 「검토한 정의」 표에 새 줄을 더한다.
4. `pnpm subagents:check`가 종료 코드 0으로 끝나는지 확인한다.

## 검사

```sh
pnpm subagents:check
```

- 검사 규칙은 `REVIEW.md` 「자동 검사 항목」에 있다.
- `pnpm db:migrate` 뒤 `pnpm --filter @awbs/db seed:system`이 검사를 통과한 정의만 넣는다. 이미 있는 정의·버전은 건드리지 않는다.
