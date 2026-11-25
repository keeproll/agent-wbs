# Agent Runner

개발 PC에서 Agent WBS의 작업을 가져와 실행하는 데몬. 현재는 골격(설정·로그·비밀값 마스킹·시험용 fake)만 있고 WBS에 접속하지 않는다.

```sh
pnpm -C agent-runner install --frozen-lockfile
pnpm -C agent-runner check     # typecheck + lint + test. 실제 Claude/Codex/GitHub를 호출하지 않는다
pnpm -C agent-runner start     # .env의 AWBS_RUNNER_TOKEN 필요(.env.example 참고)
```
