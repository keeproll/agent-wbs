# 계약 변경 배포와 job 재발급

계약 변경 배포는 [운영 안내 §4.4](operations.md#44-서버-계약을-바꾸는-배포-옛-job-처리)의 순서로 진행한다. 수령 중지 → 목록 확인 → 기존 계약에서 실행·대조·보유·정리 완료 → Runner 정지와 세션 종료 확인 → 백업·배포 → 미리보기·재발급 → 확인 → 새 Runner 시작이다.

운영에서는 아래 **정해진 compose 실행 방식만** 쓴다. `<저장소>`를 실제 저장소 절대 경로로 바꾼다. 앱 컨테이너 진입점이 비밀 파일을 읽어 앱 로그인 `awbs_app_login`으로 연결한다. 관리자 `awbs_owner`가 기본인 개발 `.env`의 `pnpm auth` 경로를 운영 명령으로 사용하지 않는다. 비밀번호나 DB 주소를 복사해 명령줄에 넣을 필요가 없다.

```sh
docker compose -p awbs-prod -f <저장소>/agent-wbs/deploy/compose.prod.yaml --env-file ~/.agentwbs/prod/deploy.env exec -T api awbs-entrypoint auth jobs open
docker compose -p awbs-prod -f <저장소>/agent-wbs/deploy/compose.prod.yaml --env-file ~/.agentwbs/prod/deploy.env exec -T api awbs-entrypoint auth jobs reissue --through 123
docker compose -p awbs-prod -f <저장소>/agent-wbs/deploy/compose.prod.yaml --env-file ~/.agentwbs/prod/deploy.env exec -T api awbs-entrypoint auth jobs reissue --through 123 --confirm
```

`123`은 `jobs open` 끝의 **재발급 상한 순번**으로 바꾼다. 같은 배포의 재실행에서는 같은 번호를 유지한다. 새 번호로 바꾸면 방금 만든 job도 다시 만들 수 있다. 순번은 생성 순서를 나타내며 PC 시계와 무관하다.

`jobs open`은 읽기 전용이다. `queued`(대기), `leased`(임대), `started`(실행), `reconcile`(실제 결과 대조 대기)을 종류·순번·ID·상태·저장된 계약 버전(`schema_version`)·생성 시각·임대 주인·임대 끝·fence·열린 보유 수와 함께 표시한다. 끝난 job에 남은 보유도 마지막 전체 수에 포함한다. 입력 본문·토큰·키는 출력하지 않는다. 계약 버전은 저장값이며 새 배포 여부를 자동 식별하는 값이 아니다.

재발급 대상은 기본적으로 `bootstrap,input_diff,split,estimate,planning` 다섯 종류 중 상한 이하의 **queued job만**이다. `--kinds input_diff,split`로 좁힐 수 있다. 다른 종류나 상한 밖의 job은 그대로 남는다. 그 job의 계약도 바뀐다면 배포를 진행하지 말고 해당 생성 경로 지원을 먼저 추가한다.

`--confirm`이 없으면 실제 입력 재생성·새 job·이력 기록까지 시험한 뒤 트랜잭션 전체를 롤백한다(`--dry-run`도 같다). 미리보기로 job이나 이력이 남지는 않지만 DB 순번에 빈 번호가 생길 수 있다. 재생성 실패는 해당 job ID와 업무 오류를 표시한다. 실제 실행도 하나라도 실패하면 전부 되돌린다. 원래 대상이 삭제됐거나 유효한 생성 상태가 아니면 배포를 멈추고 기존 계약 버전에서 업무 상태를 해결한 뒤 다시 미리보기한다.

실제 실행은 취소·fence 증가·현재 내용/정책으로 입력 재생성·새 job 생성·연결 이력을 한 트랜잭션에 넣는다. 취소 사유는 `runner_job_events.code=CONTRACT_CHANGED`로 남고 Task 이력·분석 로그에도 연결을 남긴다. 분석은 정상 다시 시도와 같은 경로를 거쳐 WBS·기술 결정 전제가 바뀌었으면 단계 초기화와 회차 증가도 한다. 분석의 입력 버전은 첫 분석이 고정한 버전을 유지한다.

안전 확인은 시간 하나에 의존하지 않는다. 열린 Runner 세션(`ended_at` 없음)은 heartbeat가 오래됐어도 거부한다. 닫힌 세션에도 `연결 확인 주기 × 누락 허용 횟수 + 5초` 창을 추가로 검사한다. 활성 임대·실행·대조 대기·열린 보유·미완료 Runner 정리도 모두 거부한다. 실제 프로세스가 끝났는지도 기존 종료 증거 절차로 확인한다.

`repo_check`의 만료 임대는 감시가 자동으로 취소하지 않는다. 명령이 이를 알리면 **배포 전에 기존 계약 Runner를 다시 켜 조회 재수령·완료 보고를 끝내고 다시 정지**한다. `reconcile`의 효과 없음 처리는 옛 입력으로 새 queued job을 만들 수 있으므로 대조를 기존 계약에서 끝낸 뒤 상한을 다시 기록한다. `unconfirmed` 보유는 실제 종료 증거로 정리한다. 정리되지 않으면 배포 금지를 유지한다. 임의 SQL로 상태·임대·fence를 바꾸지 않는다.

재발급 뒤 `jobs open`에서 새 queued job을 확인하고 같은 상한으로 다시 실행해 `0개`인지 본다. 다른 종류에 옛 계약 job이나 열린 보유가 남지 않았음을 확인한 뒤 새 Runner를 시작한다.

늦은 보고는 **실제 상태·fence 변경 뒤** 거절된다. 일반 Runner 경로는 fence·주인·상태·임대 끝을 검사하고, Planning `assertJob`은 fence·상태를 검사한다. 이번 변경은 Planning에 임대 만료 검사를 추가하지 않았다. queued 보고는 재발급 전에도 원래 거절되므로 시간 경과나 그 거절 자체를 재발급의 효과로 설명하지 않는다.
