# Agent Runner

개발 PC에서 Agent WBS에 연결하는 상주 프로그램이다. 현재는 정리 명령 조회, 정책·메시지 조회, 생존 신호와 세션 시작·종료 보고를 제공한다. 실제 Agent 실행은 다음 작업에서 연결한다.

```sh
pnpm -C agent-runner install --frozen-lockfile
pnpm -C agent-runner check     # typecheck + lint + test. 실제 Claude/Codex/GitHub를 호출하지 않는다
pnpm -C agent-runner start     # .env의 AWBS_RUNNER_TOKEN 필요(.env.example 참고)
```

보고는 `Outbox.enqueue()`로 먼저 `AWBS_HOME/state/runner.json`에 저장한 뒤 전송한다. Outbox(보고 대기함)는 같은 요청을 여러 번 보내도 한 번만 처리하도록 멱등 키를 유지한다. 예를 들어 서버가 보고를 처리한 직후 Runner가 강제 종료돼도, 재시작하면 같은 키로 다시 보내 서버의 중복 처리를 막는다. 네트워크·408·429·5xx 오류는 간격을 늘려 재시도하고, 다른 오류는 `rejected`(전송 거부)로 보존한다. `readinessWarnings`에서 거부된 보고를 확인할 수 있다.

epoch(프로젝트 초기화 번호)가 바뀌면 이전 보고와 수신함을 비우고 새 일을 멈춘다. `Runner`의 `cleanup` 함수에 실제 정리 구현을 연결해야 하며, 연결되지 않았으면 정리 대기 상태를 유지한다. 정리 결과를 서버가 확인한 뒤에만 새 번호를 저장한다. 메시지는 디스크 수신함에 보관하며, 실행 계층이 지시를 실제로 전달한 다음 `ackMessage()`를 호출한다. 예를 들어 다음 실행에 넣어야 하는 지시는 조회만 했다는 이유로 수신 확인을 보내지 않는다.

`AWBS_HOME` 폴더 하나는 Runner 프로세스 하나만 사용한다. 파일 저장은 임시 파일 기록·디스크 동기화·이름 교체 순서로 처리하지만, 프로세스 여러 개가 같은 폴더를 함께 쓰는 기능은 제공하지 않는다. 토큰은 상태 파일에 저장하지 않는다.
