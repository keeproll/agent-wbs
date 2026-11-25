# 가짜 실행기

실제 Claude/Codex/GitHub를 호출하지 않는다.

- `cli.ts`의 `installFakeCli(dir, 'claude' | 'codex', scenario?)`: 같은 이름의 실행 파일을 임시 폴더에 만든다.
- `github/server.ts`의 `startFakeGitHub(token)`: 127.0.0.1 임의 포트. 등록하지 않은 호출은 501이며 `assertNoUnexpected()`로 잡는다.
- `claude/success.jsonl`, `codex/success.jsonl`은 **손으로 쓴 예시**다. 실제 CLI 기록이 아니므로 출력 형식의 근거로 쓰지 않는다. 기록 fixture는 M5-01에서 만든다.
