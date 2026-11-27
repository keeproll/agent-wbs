# 가짜 실행기

실제 Claude/Codex/GitHub를 호출하지 않는다.

- `cli.ts`의 `installFakeCli(dir, 'claude' | 'codex', scenario?)`: 같은 이름의 실행 파일을 임시 폴더에 만든다.
- `github/server.ts`의 `startFakeGitHub(token)`: 127.0.0.1 임의 포트. 등록하지 않은 호출은 501이며 `assertNoUnexpected()`로 잡는다. 경로에 `:name` 변수를 쓸 수 있고, 응답에 `drop: true`를 주면 처리 뒤 연결을 끊어 응답 유실을 흉내 낸다.
- `github/model.ts`의 `GitHubModel`: 저장소 1개(커밋·브랜치·PR·status)와 strict 병합 규칙(예상 head 불일치 409, main 미포함·필수 status 없음 405)을 흉내 낸다. `model.install(github)`로 위 서버에 올린다. 리뷰 뒤 보강한 흉내:
  - `holdMerges()`: 병합 요청을 받아 두고 `release()` 전까지 적용하지 않는다(타임아웃 뒤 늦게 완료).
  - `pullReadLag`: 병합 직후 몇 번의 PR 조회는 병합 전 모습을 돌려준다(조회 반영 지연).
  - `limitNext(n, 'primary' | 'secondary' | 'secondary429')`: 다음 n개 요청을 기본·보조 속도 제한으로 거부한다.
  - status 목록: per_page(기본 30, 최대 100)·page와 `Link rel="next"`.
  - `tokenPermissions`: PR(Pull requests)·status(Commit statuses)·병합(Contents) 쓰기 권한을 따로 빼면 403과 `x-accepted-github-permissions`를 준다.
  실제 GitHub 응답 전체나 보호 규칙의 실재는 재현하지 않는다(M4-06에서 확인).
- `claude/success.jsonl`, `codex/success.jsonl`은 **손으로 쓴 예시**다. 실제 CLI 기록이 아니므로 출력 형식의 근거로 쓰지 않는다. M5-01의 출력 fixture는 `test/cli/fixtures/`에 있다. 그것도 공식 형식을 보고 만든 잠정본이며 실제 기록이 아니다.
