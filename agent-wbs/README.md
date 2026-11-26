# Agent WBS

Web UI · REST API · PostgreSQL. 계획은 [`docs/plan`](../docs/plan/architecture.md)에 있다.

Node 26.13 이상(26 계열)과 pnpm 12.16.1이 필요하다. 저장소 루트에서 실행한다.

```sh
pnpm -C agent-wbs env:init          # .env 생성(무작위 DB 비밀번호, 커밋하지 않음). 최초 1회
docker compose -p awbs -f agent-wbs/compose.yaml up -d --wait postgres
pnpm -C agent-wbs install --frozen-lockfile
pnpm -C agent-wbs db:migrate
pnpm -C agent-wbs --filter @awbs/db seed:system # 필수 기본 설정을 넣음. 없으면 Runner 상태를 읽을 수 없음
pnpm -C agent-wbs dev               # web 127.0.0.1:5173, api 127.0.0.1:3100
```

| 명령 | 내용 |
|---|---|
| `pnpm check` | typecheck + lint + 단위 테스트(DB 불필요) |
| `pnpm build` | 전체 빌드 |
| `pnpm test:db` | 실제 PostgreSQL 테스트. `TEST_DATABASE_URL`이 `awbs_test_` DB가 아니면 거부 |
| `pnpm --filter web e2e:install` | Playwright Chromium을 사용자 캐시에 설치 |
| `pnpm --filter web test:e2e` | 브라우저 테스트 |

특정 테스트만 실행하려면 `-- <이름>`을 붙인다(예: `pnpm test:db -- guard`).

DB 비밀번호는 PC당 하나(`~/.agentwbs/wbs/dev-db-password`, 0600)이며 여러 worktree가 같은 컨테이너를 쓴다.
테스트 DB는 worktree마다 다르다. 컨테이너 중지는 `docker compose -p awbs -f agent-wbs/compose.yaml stop`이다.
