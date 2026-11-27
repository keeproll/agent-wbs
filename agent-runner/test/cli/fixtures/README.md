# CLI 출력 fixture (잠정)

이 폴더의 `.jsonl` 파일은 Claude·Codex CLI가 내보내는 출력 스트림의 예시다.
fixture(테스트에 쓰는 고정 데이터)는 한 줄에 JSON 이벤트 하나씩 들어 있다.

## 어디서 왔나 — 실제 기록이 아니다

- 실제 CLI를 실행해 녹화한 기록이 **아니다**.
  - 왜: 실제 출력을 얻으려면 모델을 호출해야 하는데, owner 결정 전이라 실제 Claude·Codex 호출을 하지 않는다(유료 호출 0).
- 공식 문서의 형식을 보고 손으로 만든 **잠정본**이다(2026-11-27 확인).
  - Claude: Claude Code 공식 문서의 Agent SDK 메시지 형식(SDKMessage — `system/init`, `assistant`, `user`, `result`, `system/task_started`, `system/task_notification` 등).
  - Codex: 공식 저장소 `codex-rs/exec/src/exec_events.rs`와 TypeScript SDK의 `ThreadEvent`(`thread.started`, `turn.*`, `item.*`, `error`), 협업 도구 항목(`collab_tool_call`).
- 그래서 해석기의 관측 등급은 「미검증」이다. 실제 기록으로 검증하면(M5-03·M8-04) 같은 이름의 파일을 실제 기록으로 바꾼다.

## 파일별 내용

- `claude/success.jsonl` — 정상 실행. 생각(thinking)·글·Bash 도구 호출·결과.
- `claude/subagents.jsonl` — 하위 Agent 2개를 함께 띄우고, 그중 하나가 하위 Agent를 하나 더 띄운다(중첩). 배경 명령(`local_bash`)도 섞여 있다. 결과 이벤트 전에 끝난다.
- `claude/background.jsonl` — 배경 하위 Agent. 도구 결과는 「시작됨」일 뿐이고, 끝은 `task_notification`으로 온다.
- `claude/unknown.jsonl` — 모르는 이벤트(`rate_limit_event`, 새 system subtype, 모르는 내용 블록, `stream_event`).
- `claude/error.jsonl` — 최대 턴 수 초과(`error_max_turns`).
- `claude/api-error.jsonl` — `subtype`은 success인데 `is_error`가 true인 경우(API 오류).
- `claude/truncated.jsonl` — 하위 Agent 실행 중에 줄 중간에서 끊긴 스트림.
- `codex/success.jsonl` — 정상 실행. 추론·명령 실행·파일 변경·할 일 목록·글·토큰.
- `codex/subagents.jsonl` — `spawn_agent` 3번(중첩 1번 포함), `wait`로 둘이 끝나고 하나는 실행 중인 채로 끝난다.
- `codex/missing-id.jsonl` — 생성은 끝났는데 생성된 Agent의 ID가 비어 있다.
- `codex/unknown.jsonl` — 모르는 이벤트·항목·협업 도구, 알려진 도구의 모르는 상태 값(`hibernating`).
- `codex/failed.jsonl` — 스트림 오류 뒤 `turn.failed`.
