# 계약 변경 배포와 job 재발급

Runner가 받는 입력이나 보고 형식이 달라지는 배포에 쓴다. 기존 관리 CLI와 같은 DB 접속 설정·앱 권한(`awbs_app`)을 사용한다. DB 이력을 수정하거나 임의 SQL로 job을 정리하지 않는다.

저장소의 `agent-wbs` 폴더에서 실행한다.

```sh
pnpm --filter @awbs/api auth jobs open
pnpm --filter @awbs/api auth jobs reissue --through 123
pnpm --filter @awbs/api auth jobs reissue --through 123 --confirm
```

`123`은 예시다. `jobs open` 끝에 나온 **재발급 상한 순번**으로 바꾼다. 다시 실행할 때도 같은 번호를 쓴다. 새 번호로 바꾸면 방금 만든 job도 다시 만들 수 있다. 순번은 생성 순서를 나타내며 PC 시계와 무관하다.

`jobs open`은 읽기 전용이다. `queued`(대기), `leased`(임대), `started`(실행), `reconcile`(실제 결과 대조 대기)을 종류·순번·ID·상태·저장된 계약 버전(`schema_version`)·생성 시각·임대 주인·임대 끝·fence·열린 보유 수와 함께 표시한다. 계약 버전은 기존 저장값이며 배포 버전을 자동 판별하는 값은 아니다. 입력 본문·토큰·키는 출력하지 않는다. 끝난 job에 남은 보유도 마지막의 전체 보유 수에 포함한다.

재발급 대상은 기본적으로 `bootstrap,input_diff,split,estimate,planning` 다섯 종류 중 지정 순번 이하의 **queued job만**이다. `--kinds input_diff,split`처럼 종류를 좁힐 수 있다. 다른 종류나 상한 밖의 job은 그대로 남으므로 목록을 확인한다. 그 job의 계약도 바뀐다면 배포를 진행하지 말고 해당 생성 경로 지원을 먼저 추가한다.

`--confirm`이 없으면 미리보기만 한다(`--dry-run`도 같다). 실제 실행은 취소와 fence 증가, 현재 DB에서 입력 재생성, 새 job 생성, 옛 job과 새 job의 연결 이력을 한 트랜잭션에 넣는다. 취소 사유는 `runner_job_events.code=CONTRACT_CHANGED`로 남고 Task 이력·분석 로그에도 연결이 남는다. 하나라도 실패하면 전부 되돌린다. 같은 상한으로 재실행하면 이미 취소한 job은 대상에서 빠지고 새 job은 상한 밖이므로 중복 생성하지 않는다.

## 배포 순서

1. **새 일 수령을 멈춘다.** 현재 수령 일시 중지 설정은 없다. `systemctl --user stop awbs-runner.service`로 Runner를 멈추고 중지 성공을 확인한다. 배포 중에는 새 분석 요청과 Task·정책 편집도 멈춘다.
2. **`jobs open`으로 남은 일을 본다.** 재발급 상한 순번과 대상 종류를 기록한다. 실행·임대 중인 일을 queued로 되돌리는 명령이 아니다.
3. **Runner와 실행 프로세스의 종료를 확인한다.** `jobs reissue --through <순번>` 미리보기가 통과해야 한다. 최근 heartbeat가 있거나, 임대·실행·대조 대기 job 또는 열린 실행 보유가 하나라도 있으면 명령이 거부한다. heartbeat 판정 범위는 서버의 연결 확인 주기 × 누락 허용 횟수다. 정해진 초만큼 기다렸다는 이유로 다음 단계로 넘어가지 않는다.
   - 서버 감시가 실제 상태를 바꿀 때까지 목록을 다시 확인한다. `reconcile`과 `unconfirmed` 보유가 남으면 기존 Runner 종료 증거·대조 절차를 **기존 계약 코드에서** 끝낸다. `reconcile`의 효과 없음 처리는 옛 입력으로 새 queued job을 만들 수 있으므로 그 뒤 `jobs open`으로 상한을 다시 기록한다. 정리하지 못하면 이 배포를 중단한다.
4. **백업 후 새 서버를 배포한다.** Runner는 계속 중지 상태로 둔다. M8-06 운영 이미지가 병합된 환경에서는 기존 `auth` 진입점에 `jobs`를 붙인다: `docker compose -f compose.prod.yaml run --rm --no-deps api auth jobs open`. `jobs` 전용 이미지 진입점은 추가하지 않았다.
5. **기록한 순번으로 미리보기 후 재발급한다.** `jobs reissue --through <순번> --confirm`을 실행한다. 대상이 현재 상태에서 다시 생성될 수 없으면 전부 되돌아가며 종료 코드 1로 끝난다. 출력의 옛 ID → 새 ID를 보관한다.
6. **확인 후 Runner를 시작한다.** `jobs open`에서 새 queued job을 확인하고 같은 순번으로 재발급을 다시 실행해 `0개`인지 확인한다. 다른 종류의 옛 job과 열린 보유가 없음을 확인한 뒤 새 계약에 맞는 Runner를 `systemctl --user start awbs-runner.service`로 시작한다.

## 늦은 보고를 거절하는 기준

재발급된 옛 job은 실제로 `cancelled`가 되고 fence도 1 오른다. 일반 Runner 보고는 fence·주인·상태·임대 끝을 검사하고, Planning의 `assertJob`은 fence·상태를 검사한다. 두 경로 모두 이 **상태·fence 변경 뒤** 옛 보고를 `LEASE_LOST`로 거절한다. Planning 경로는 임대 시각을 검사하지 않으므로 단순한 시간 경과를 안전 기준으로 삼지 않는다. 이번 변경은 그 보고 검사 규칙을 바꾸지 않는다.

이 안내는 M8-06 운영 문서 §4.4에 병합할 별도 보충 문서다. 지원하지 않는 job이나 종료·대조 미확인 작업이 남아 있으면 계약 변경 배포 금지를 유지한다.
