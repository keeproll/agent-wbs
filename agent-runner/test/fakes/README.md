# 가짜 실행기

실제 Claude/Codex/GitHub를 호출하지 않는다.

- `cli.ts`의 `installFakeCli(dir, 'claude' | 'codex', scenario?)`: 같은 이름의 실행 파일을 임시 폴더에 만든다.
- `github/server.ts`의 `startFakeGitHub(token)`: 127.0.0.1 임의 포트. 등록하지 않은 호출은 501이며 `assertNoUnexpected()`로 잡는다. 경로에 `:name` 변수를 쓸 수 있고, 응답에 `drop: true`를 주면 처리 뒤 연결을 끊어 응답 유실을 흉내 낸다.
- `github/model.ts`의 `GitHubModel`: 저장소 1개(커밋·브랜치·PR·status)와 strict 병합 규칙(예상 head 불일치 409, main 미포함·필수 status 없음 405)을 흉내 낸다. `model.install(github)`로 위 서버에 올린다. 실제 GitHub 응답 전체를 재현하지는 않는다.
- `claude/success.jsonl`, `codex/success.jsonl`은 **손으로 쓴 예시**다. 실제 CLI 기록이 아니므로 출력 형식의 근거로 쓰지 않는다. 기록 fixture는 M5-01에서 만든다.
