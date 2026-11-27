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

## 초기 분석의 사람 결정 대기

Runner(서버 작업을 실행하고 결과를 보고하는 프로그램)가 기술 결정 제안이나 초안을 저장하면 다음 처리는 팀장이 맡는다.
`tech:run`은 기술 결정 확정 대기다. `approve:run`은 저장된 초안 승인 대기다.
이때 Runner 작업이 성공·실패·취소로 끝나거나 임대(정해진 시간 동안의 실행 권한)가 만료되어도 초기 분석을 실패로 바꾸지 않는다.
PC 재시작이나 교체도 같은 규칙을 따른다.
왜 이렇게 하나: Runner가 맡은 자료 저장은 끝났으므로, 연결 중단 때문에 사람의 결정 대기를 실패로 취급하면 안 된다.

사람 결정 대기 중에는 「다시 시도」로 Runner 작업을 만들지 않는다.
reconcile(끊긴 작업의 실제 결과를 대조하는 복구 처리)도 대체 작업을 만들지 않는다.
기술 결정을 확정하면 `draft` 작업이 만들어진다. 초안을 승인하면 초기 분석이 완료된다.
실제 분석 실패의 `resumeStep`(재개 단계)은 DB(데이터베이스)에 저장된 단계 순서에서 처음으로 `done`이 아닌 단계로 정한다.
재분석 때문에 단계들을 초기화한 경우에도 초기화한 DB 상태로 계산한다.
저장된 상태에서 Runner가 재개할 단계가 없으면 거부한다.
왜 이렇게 하나: 실패 표시가 없다고 `null`(처음부터)을 추측하면 이미 저장한 제안이나 초안을 다시 만들 수 있다.

용어: Runner는 작업 실행 프로그램이다. 임대는 일정 시간의 실행 권한이다.
reconcile은 끊긴 작업의 결과 대조다. `resumeStep`은 재개할 단계다. DB는 데이터베이스다.
