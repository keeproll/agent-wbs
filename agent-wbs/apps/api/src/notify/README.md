# Telegram 알림 (M6-04)

Telegram은 상태 변화를 알려 주기만 한다. 승인과 조치는 WBS 화면에서 한다.
전송이 실패해도 Task와 Agent의 상태는 바뀌지 않는다.

## 실행 범위

Q-16이 정해지기 전에는 실제 Telegram에 연결하지 않는다.
`AWBS_TELEGRAM_BOT_API_URL`에 명시한 `http://127.0.0.1:<포트>`의 fake Bot API만 호출한다.
Bot API는 봇 확인과 메시지 전송을 처리하는 HTTP 인터페이스다.
주소가 없거나 로컬 주소가 아니면 `network` 결과를 돌려준다.
왜: 실제 봇 값과 운영 연결은 owner 결정 뒤에 붙여야 한다.

`AWBS_SECRET_KEY`는 기존 GitHub 설정과 같은 32바이트 16진수 암호화 키다.
토큰은 AES-256-GCM 방식으로 `secrets`에 저장한다.
AES-256-GCM은 내용을 암호화하고 저장 중 변조도 검사하는 방식이다.
토큰은 응답과 로그에 넣지 않는다.
화면에는 등록 여부와 끝 4자리만 보인다.

## 저장과 발송

0040(옛 0051) 마이그레이션의 `telegram_transition` 트리거가 저장 전후 상태를 비교한다.
트리거는 DB에서 행이 저장될 때 함께 실행하는 함수다.
알림 이벤트와 outbox를 같은 트랜잭션에 쓴다.
outbox는 외부로 보내기 전에 DB에 남기는 발송 대기열이다.
트랜잭션은 함께 성공하거나 함께 취소되는 저장 묶음이다.
왜: 상태가 취소됐는데 알림만 나가는 일을 막아야 한다.

같은 프로젝트·이벤트·대상·원인의 열린 키는 하나다.
반복 실패는 `dup_count`만 늘린다.
서로 다른 CI 행에서 같은 원인이 동시에 생겨도 같은 키에 합친다.
CI 실패 키는 같은 단계와 PR 또는 ref의 통과에서만 닫는다.
왜: 한 PR의 성공이 다른 PR의 실패를 해소하면 안 된다.

알림 생성 실패는 트리거 내부 작업만 취소한다.
업무 상태 저장은 계속한다.
외부 발송은 API 요청과 분리된 서버 worker가 처리한다.
왜: 알림 장애가 Task와 Runner 보고를 멈추게 하면 안 된다.

`sending`은 외부 호출 전에 커밋한다.
worker는 호출 동안 초기화 세대인 `epoch`의 공유 잠금을 잡는다.
왜: 초기화가 끝난 뒤 옛 프로젝트 알림을 새로 보내면 안 된다.
외부 호출이 들어 있는 트랜잭션은 DB 교착 때문에 자동으로 다시 실행하지 않는다.
교착은 서로 가진 잠금을 기다려 작업을 진행할 수 없는 상태다.

`401`·`400 chat not found`·`403`·`chat_migrated`는 재시도하지 않는다.
`429`는 실제 `retry_after`까지 기다린다.
통신 실패는 간격을 늘려 총 5회까지 시도한다.
30초 넘게 남은 `sending`도 횟수 제한 안에서 복구한다.
응답 유실이나 중단 뒤에는 이력에 **중복 도착 가능**을 남긴다.
끝까지 수락 여부를 모르면 `unknown`이다.
왜: Telegram에는 이 설계가 사용할 수 있는 중복 방지 키가 없다.
도착과 읽음은 보장하지 않는다.

개인 대화는 최소 1초 간격으로 보낸다.
그룹은 최소 3초 간격으로 보낸다.
이 제한은 테스트 알림과 업무 알림에 함께 적용한다.

## 전이 알림 대응표 (M6 통합 정리)

전이 알림은 「어떤 상태 변화가 어떤 Telegram 알림이 되는가」를 정한 규칙이다.
원본 기준은 P L3651-3658의 `TG_EV`(알림 종류 6개)와 `TG_RULES0`(처음 켜짐 여부)다.
실제 판정은 0040(옛 0051)·0041(옛 0052) 마이그레이션의 `awbs_notify_transition` 트리거가 한다.
왜 표로 모으나: 알림 종류가 여러 표(Task·CI·설정·승인)에 흩어져 있어, 새 기능이 들어올 때 빠뜨리기 쉽다.

알림 종류마다 다음 순서로 적는다: 원본 이름 → 처음 켜짐 → 바뀌는 표와 조건 → 상태 문구 → 화면 이동.

- `done`(Task 완료)
  - 처음에는 꺼져 있다.
  - `tasks.status`가 `done`이 되고, 그 Task가 병합(`merge_queue.status='merged'`)과 ② 통합 확인 통과를 함께 가질 때만 보낸다.
  - 상태 문구는 「WBS 최종 완료」다.
  - 이동은 `/wbs/<Task>`다.
- `fail`(Task 실패)
  - 처음부터 켜져 있다.
  - `tasks.verif_state`가 `fail`이 될 때 보낸다. 상태 문구는 「QA FAIL 확정」이다.
  - `alerts`에 `retry:<Task>` 경보가 열릴 때도 보낸다. 상태 문구는 「실행 실패 — 자동 재시도 한도 초과」다.
  - 이동은 `/wbs/<Task>`다.
- `admin`(관리자 개입 필요)
  - 처음부터 켜져 있다.
  - `runner_readiness.status='fail'` → 「준비 상태 실패」, 이동 `/settings/runner`.
  - `github_settings.status='failed'` → 「GitHub 인증 실패」, 이동 `/settings/runner`.
  - `execution_holds.slot_state='unconfirmed'` → 「하위 Agent 관측 미확인(보유)」, 이동 `/settings/runner`.
  - `input_change_commits.state='pending'` → 「팀장 확인 대기」, 이동 `/project`.
- `approve`(승인 요청)
  - 처음부터 켜져 있다.
  - `change_proposals.status='review'` → 「Change Proposal 승인 대기」, 이동 `/change/<CP>`.
  - `tech_decisions.status`가 `pending` 또는 `change` → 「기술 결정 승인 대기」, 이동 `/design`. M6-05 설계 원장의 Agent 제안 결정(TD-xx)이 여기에 해당한다.
  - `wbs_drafts.status='pending'` → 「초기 WBS 승인 대기」, 이동 `/wbs`.
- `buildOk`(빌드 성공)
  - 처음에는 꺼져 있다.
  - `ci_runs`의 ② 통합 확인·④ 배포 확인이 `pass`가 될 때 보낸다. ① Task 검사와 ③ 야간 점검은 보내지 않는다.
  - 상태 문구에 통과한 단계 목록을 넣는다.
  - 이동은 `/ci/<CI>`다.
- `buildFail`(빌드 실패)
  - 처음부터 켜져 있다.
  - `ci_runs`의 ②·③·④가 `fail`이 될 때 보낸다. 상태 문구에 실패 단계를 넣는다.
  - 같은 단계·같은 PR(또는 ref)이 통과하면 그 실패 키를 닫는다.
  - 이동은 `/ci/<CI>`다.

M6 다른 기능의 경보는 Telegram으로 보내지 않는다.
- M6-03 메일 발송 실패(`mail:failed` 경보)는 대시보드 알림과 설정 탭 배지로만 보인다.
- M6-05 설계 불일치(`design_drift`)·계약 파일 읽기 실패(`design_parse`) 경보도 대시보드 알림으로만 보인다.
- 왜: 원본 `TG_EV`의 여섯 종류에 이 상황이 없다. 새 종류를 만들려면 owner 결정이 필요하다.

M5·M7 통합이 main에 들어간 뒤 할 일이 하나 있다.
- M7-03의 서비스 없음 알림 `serviceDown`(M7-03 결정 14)을 이 표와 트리거에 더한다.
- 이 브랜치에는 M7 코드가 없어서 지금은 넣지 못했다(계획 문서 미결 목록 「Telegram 전이 알림 대응표에 serviceDown 추가」).

## 연결 확인과 화면

서버가 수락한 테스트의 토큰·Chat ID 조합만 활성화할 수 있다.
조합은 SHA-256 지문으로 확인한다.
지문은 같은 입력인지 검사하는 고정 길이 값이다.
토큰이나 Chat ID가 바뀌면 테스트를 다시 해야 한다.
이름만 바꾸면 검증을 유지한다.
설정 유지 초기화는 성공 지문을 남기고 전송 이력은 지운다.
테스트 응답의 `testId`로 저장 전 초안의 재시도 결과도 조회한다.
`GET /api/notify/telegram?testId=…`는 설정을 바꾸지 않고 그 시험의 결과만 함께 보여 준다.
왜: 아직 저장하지 않은 새 토큰도 재시도 성공 뒤 정확한 테스트 상태를 보여 줘야 한다.

화면은 기존 `useSettingForm`, `useSave`, `Modal`, `TableScroll`과 원본 CSS를 쓴다.
저장 실패 때 연결·규칙·접속 주소의 초안을 유지한다.
토큰은 브라우저 저장소에 보관하지 않는다.
대화 후보는 직접 선택해야 입력에 반영된다.
Webhook은 자동으로 해제하지 않는다.

확인 명령은 `pnpm test:scenario -- telegram`이다.
화면 검증은 `pnpm e2e -- telegram`이다.
테스트는 전용 DB와 로컬 fake 서버만 사용한다.
