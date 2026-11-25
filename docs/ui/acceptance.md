# 구현 완료 판정용 인수 체크리스트

이 문서는 **제품의 기대 동작**이다. [inventory.md](inventory.md)·[catalog.tsv](catalog.tsv)는 원본의 현재 동작을 기록하므로, 원본 결함이나 Mock 버튼이 인수 기준으로 승격되지 않는다. 충돌 시 owner 결정 → 계획 기준선 a60216d → 가이드 → 원본 순으로 적용한다. owner Q-01/02/03/04/05/06/11/12는 계획의 open-questions §0, 마일스톤은 milestones를 따른다.

owner 확정 사항은 계획 a60216d의 open-questions §0·D-27·D-28을 따른다. **시작 전 취소 선행의 SS 관계는 원자적으로 제거하되 다른 미충족 선행은 계속 차단하고, CP 영향에서 실제 풀리는 후속을 구분**한다. **1280px 이상 전체 지원, 그 아래 표는 영역 내 가로 스크롤, 390px 휴대폰은 알림 링크의 Task·CI·변경 제안 상세 열람**이다. 즉시 전달·실 격리·외부 자격 증명 등 나머지 gate는 계획대로 남는다.

로그인 화면(UI-AUTH)은 owner 추가 범위다. 착수 승인을 거친 뒤 팀장 시작 버튼을 누르면 후속 실행·재작업은 자동(자동 재시도2회/총3회, 자동 재작업3회)이며 Gate+②통합+병합 확인 후 서버가 자동 완료한다. CLI는 최신 유지, 미검증 시 보수 계산·재검증 안내를 제공하고 버전 고정/하향을 합격 조건으로 요구하지 않는다.

[acceptance-cases.tsv](acceptance-cases.tsv)의 전제·사건·관찰 결과를 정본으로 아래를 생성한다. UAT-접두어는 화면 ID와 충돌하지 않는다. 529개 CD 조건은 원본 추적용이고 합격 항목이 아니다. 같은 빈 상태/오류는 실제 API/Runner fixture와 기대 문구가 있는 화면 시나리오로 통합했다. Mock 버튼·정기 점검·가상 토큰 주입·고정 Task11개·제작예정 UI-13은 제품 필수 UI가 아니다.

검증 방법은 항목별로 다르게 적었다. API/E2E/Runner/SMTP/BotAPI/PDF검사는 자동화 가능하고 시각 비교는 자동 보조와 수동 검수를 병행한다. E2E는 UI·키보드·라우팅, API+E2E는 저장/검증/재조회, API+Runner+E2E는 보고·실행·Git 연계, API+SMTP/BotAPI+E2E는 실제 프로토콜을 처리하는 로컬 시험 서버까지, PDF검사는 생성 파일·텍스트/폰트/페이지 검사, 시각·수동은 렌더/인쇄·포커스 확인을 뜻한다. M3 fake Runner는 테스트 준비 수단이며 제품의 가짜 성공 근거가 아니다. 외부 자격 증명/유료 실호출은 해당 owner gate 뒤의 M8 인수에서 수행한다.

모든 M3 UI 사례는 공통으로1280/1920px 전체 기능·페이지 가로 스크롤 없음과1280 미만 표 영역 가로 스크롤을 만족해야 한다(plan a60216d milestones M3 공통 완료 조건). 390px 상세 열람은 Task M3-03, CP M3-05, CI M7-05에서 각각 판정한다. 수동 시각/접근성 검수가 필요한 부분을 자동 API 성공으로 대신하지 않는다.

M3-01의 공통 상태 완료는 업무 화면 대신 공통 컴포넌트 시험 화면으로 계획의 e2e -- states를 통과한다. 실제 WBS/Task/대시보드/제품 모달 회귀는 각 화면이 있는 UAT 지정 마일스톤에서 통과한다. 전체 UAT의 화면·API 가용 시점과 선행 그래프는 [milestone-audit.md](milestone-audit.md)에 대조했다.

모든 체크박스는 **제품에서 아직 실행 전**이다. 독립 리뷰의 프로토타입 브라우저 확인과 스크린샷은 [screenshots.md](screenshots.md)에 대응시키며 제품 통과로 체크하지 않는다. 원본 문구·라벨의 정본은 P의 해당 화면 줄 범위다. UI-AUTH와 owner/불일치 수정 대상 문구는 이 기준서가 우선한다.

<!-- GENERATED: extract.py -->

## 집계

실제 판정 항목 **149개**. 이전933개(원본 설명404 + 기계 조건529)에서 교체했다. 조건529개는 인수 총계에서 제외하고 inventory의 CD 추적 색인에만 남긴다.

검증 방법별: API+E2E 69개, E2E 23개, 시각+수동 2개, E2E+시각 6개, E2E+수동 1개, API+Runner+E2E 36개, E2E+PDF검사 1개, API+E2E+PDF검사 1개, 수동+시각 1개, API+SMTP+E2E 3개, API+BotAPI+E2E 6개.

## 필수 통과 마일스톤

각 UAT는 아래 **하나의 마일스톤에서 전체 기대 결과를 통과**해야 한다. M3 화면/API 사례와 M4 이후 실행 결합 사례는 서로 다른 ID다. 앞 단계의 fixture 성공으로 뒤 단계 체크박스를 체크하지 않는다. 세부 기대 a/b/c 중 하나라도 실패하면 해당 UAT 전체는 미통과다.

| 마일스톤 | UAT 수 | 필수 판정 ID |
|---|---:|---|
| M3-01 | 7 | UAT-AUTH-01, UAT-AUTH-02, UAT-AUTH-03, UAT-SHELL-05, UAT-STATE-04, UAT-STATE-05, UAT-STATE-07 |
| M3-02 | 8 | UAT-WBS-01, UAT-WBS-02, UAT-WBS-05, UAT-WIZ-01, UAT-WIZ-02, UAT-WIZ-04, UAT-STATE-02-UI, UAT-EMPTY-10 |
| M3-03 | 16 | UAT-STATE-06, UAT-STATE-08, UAT-STATE-09, UAT-WBS-03, UAT-WBS-04, UAT-WIZ-03, UAT-TASK-01, UAT-TASK-02, UAT-TASK-03, UAT-TASK-05, UAT-TASK-07, UAT-TASK-08, UAT-TASK-09, UAT-APPROVE-01, UAT-EMPTY-01, UAT-RESP-02-TASK |
| M3-04 | 10 | UAT-SHELL-02, UAT-PROJECT-02, UAT-PROJECT-06, UAT-PROJECT-07, UAT-PROJECT-09, UAT-PROJECT-10, UAT-RESET-01, UAT-RESET-02, UAT-PROJECT-UI, UAT-RESET-UI |
| M3-05 | 10 | UAT-STATE-10, UAT-TASK-06, UAT-PLAN-02, UAT-CP-01, UAT-CP-02, UAT-CP-03, UAT-PLAN-UI, UAT-RESP-01-UI, UAT-RESP-02-UI, UAT-EMPTY-02 |
| M3-06 | 7 | UAT-TASK-10, UAT-MSG-01, UAT-EXEC-09, UAT-EXEC-UI, UAT-MSG-UI, UAT-SHELL-04-UI, UAT-EMPTY-03 |
| M3-07 | 9 | UAT-STATE-01, UAT-PROJECT-11, UAT-TASK-11, UAT-VERIFY-01, UAT-VERIFY-02, UAT-VERIFY-03, UAT-HISTORY-01, UAT-DASH-01, UAT-EMPTY-04 |
| M3-08 | 11 | UAT-SHELL-01, UAT-STATE-03, UAT-TASK-04, UAT-POLICY-01, UAT-POLICY-03, UAT-POLICY-04, UAT-POLICY-05, UAT-RUNNER-UI, UAT-GITHUB-UI, UAT-POLICY-UI, UAT-EMPTY-11 |
| M4-01 | 2 | UAT-SHELL-03, UAT-RESET-04 |
| M4-02 | 4 | UAT-EXEC-03, UAT-RUNNER-01, UAT-RUNNER-03, UAT-RUNNER-04 |
| M4-04 | 4 | UAT-PROJECT-01, UAT-PROJECT-08, UAT-RESET-03, UAT-GITHUB-01 |
| M5-02 | 1 | UAT-EXEC-08 |
| M5-03 | 1 | UAT-RUNNER-05 |
| M5-04 | 4 | UAT-PROJECT-03, UAT-PROJECT-04, UAT-PROJECT-05, UAT-PLAN-01 |
| M5-05 | 7 | UAT-EXEC-01, UAT-EXEC-04, UAT-EXEC-05, UAT-EXEC-07, UAT-MSG-02, UAT-MSG-03, UAT-EXEC-09-RUNNER |
| M5-06 | 1 | UAT-POLICY-02 |
| M6-01 | 5 | UAT-STATE-02, UAT-REPORT-01, UAT-REPORT-02, UAT-REPORT-03, UAT-EMPTY-06 |
| M6-02 | 2 | UAT-REPORT-04, UAT-REPORT-05 |
| M6-03 | 7 | UAT-MAIL-01, UAT-MAIL-02, UAT-MAIL-03, UAT-MAIL-04, UAT-MAIL-05, UAT-MAIL-06, UAT-EMPTY-07 |
| M6-04 | 8 | UAT-TG-01, UAT-TG-02, UAT-TG-03, UAT-TG-04, UAT-TG-06, UAT-TG-07, UAT-TG-08, UAT-EMPTY-08 |
| M6-07 | 5 | UAT-DESIGN-01, UAT-DESIGN-02, UAT-DESIGN-03, UAT-DESIGN-04, UAT-EMPTY-09 |
| M7-04 | 1 | UAT-EXEC-02 |
| M7-05 | 10 | UAT-RESP-01, UAT-RESP-02, UAT-CI-01, UAT-CI-03, UAT-CI-04, UAT-CI-05, UAT-CI-06, UAT-TG-09, UAT-EMPTY-05, UAT-TASK-10-CI |
| M7-06 | 5 | UAT-EXEC-06, UAT-GATE-01, UAT-GATE-02, UAT-CI-02, UAT-TG-05 |
| M8-01 | 2 | UAT-SHELL-04, UAT-REPORT-06 |
| M8-03 | 1 | UAT-GITHUB-02 |
| M8-04 | 1 | UAT-RUNNER-02 |

단계 합계: M3 78개, M4 10개, M5 14개, M6 27개, M7 16개, M8 4개.

M3 필수 목록은 위 M3-01~08 행의 ID 전체다. M3는 M2 API와 fake Runner 보고 fixture로 화면·저장·전이·보류를 확인하고 Gate 대기까지 검사한다. M4 이후에는 각 항목에 적힌 실제 adapter/프로세스/프로토콜을 사용한다. M7-06도 유료 CLI·실 GitHub 인수가 아니라 fake CLI·로컬 git·fake GitHub를 거치는 실제 ①/② 파이프라인 결합이다. 유료 CLI/실 GitHub/실 SMTP·BotAPI는 계획 M8 gate를 별도로 충족한다.

빈 상태 문구·생성 조건과 오류별 판정 ID는 [acceptance-coverage.md](acceptance-coverage.md)를 따른다. 원본의 동일 빈 문구로 구분되지 않는 경우 G86의 기록 없음/조건 불일치 구분이 제품 기준이다.

## 화면 ID → 판정 항목

| 화면 ID | 판정 ID |
|---|---|
| UI-00 | UAT-SHELL-01, UAT-SHELL-02, UAT-SHELL-03, UAT-SHELL-04, UAT-SHELL-05, UAT-RESP-01, UAT-RUNNER-UI, UAT-SHELL-04-UI, UAT-RESP-01-UI |
| UI-01 | UAT-STATE-01, UAT-PROJECT-11, UAT-DASH-01, UAT-MAIL-05, UAT-TG-05, UAT-EMPTY-04 |
| UI-02 | UAT-PROJECT-10, UAT-PROJECT-11, UAT-RESET-01 |
| UI-02A | UAT-SHELL-02, UAT-PROJECT-01, UAT-PROJECT-02, UAT-PROJECT-03, UAT-RESET-03, UAT-RESET-04, UAT-PROJECT-UI, UAT-RESET-UI |
| UI-02B | UAT-SHELL-02, UAT-PROJECT-04, UAT-PROJECT-05, UAT-RESET-04, UAT-PROJECT-UI, UAT-RESET-UI |
| UI-02C | UAT-PROJECT-03, UAT-PROJECT-06, UAT-PROJECT-UI |
| UI-02D | UAT-PROJECT-06, UAT-PROJECT-07 |
| UI-02E | UAT-PROJECT-05, UAT-PROJECT-08, UAT-PROJECT-09, UAT-PROJECT-10, UAT-PROJECT-UI |
| UI-03 | UAT-SHELL-04, UAT-STATE-01, UAT-STATE-02, UAT-WBS-01, UAT-WBS-02, UAT-WBS-03, UAT-WBS-04, UAT-TASK-11, UAT-STATE-02-UI, UAT-SHELL-04-UI, UAT-EMPTY-10 |
| UI-03A | UAT-WBS-02 |
| UI-03B | UAT-RESP-01, UAT-WBS-01, UAT-WBS-02, UAT-WBS-05, UAT-RESP-01-UI, UAT-EMPTY-10 |
| UI-03C | UAT-WBS-04 |
| UI-03D | UAT-WBS-03, UAT-TASK-11 |
| UI-03E | UAT-RESP-02, UAT-WBS-03, UAT-TASK-01, UAT-GATE-01, UAT-GATE-02, UAT-APPROVE-01, UAT-RESP-02-TASK |
| UI-03F | UAT-STATE-09, UAT-TASK-05, UAT-TASK-07, UAT-TASK-08 |
| UI-03-01 | UAT-STATE-06, UAT-TASK-01, UAT-TASK-02, UAT-EMPTY-01 |
| UI-03-01A | UAT-TASK-03, UAT-EXEC-07, UAT-POLICY-02, UAT-POLICY-UI |
| UI-03-01B | UAT-TASK-04 |
| UI-03-02 | UAT-WIZ-03, UAT-TASK-05, UAT-APPROVE-01 |
| UI-03-03 | UAT-TASK-06, UAT-EMPTY-01 |
| UI-03-04 | UAT-TASK-07, UAT-TASK-08, UAT-DESIGN-03 |
| UI-03-05 | UAT-TASK-09, UAT-EMPTY-01 |
| UI-03-06 | UAT-TASK-10, UAT-EXEC-02, UAT-POLICY-02, UAT-EXEC-09, UAT-POLICY-UI, UAT-EMPTY-01, UAT-TASK-10-CI |
| UI-03-07 | UAT-TASK-10, UAT-EXEC-04, UAT-EMPTY-01 |
| UI-03-08 | UAT-TASK-10, UAT-HISTORY-01, UAT-APPROVE-01, UAT-EMPTY-01 |
| UI-03-09 | UAT-MSG-01, UAT-MSG-02, UAT-MSG-03, UAT-MSG-UI, UAT-EMPTY-01 |
| UI-04 | UAT-DESIGN-01 |
| UI-04-01 | UAT-DESIGN-01 |
| UI-04-02 | UAT-DESIGN-02 |
| UI-04-03 | UAT-DESIGN-03, UAT-EMPTY-09 |
| UI-04-03A | UAT-DESIGN-03 |
| UI-04-04 | UAT-DESIGN-03, UAT-EMPTY-09 |
| UI-04-04A | UAT-DESIGN-03 |
| UI-04-05 | UAT-DESIGN-04, UAT-EMPTY-09 |
| UI-04-06 | UAT-DESIGN-04, UAT-EMPTY-09 |
| UI-05 | UAT-PLAN-01, UAT-CP-03, UAT-PLAN-UI, UAT-EMPTY-02 |
| UI-05-01 | UAT-PLAN-01, UAT-PLAN-UI, UAT-EMPTY-02 |
| UI-05-02 | UAT-PLAN-02, UAT-EMPTY-02 |
| UI-06 | UAT-SHELL-04, UAT-EXEC-01, UAT-EXEC-02, UAT-EXEC-04, UAT-EXEC-06, UAT-EXEC-07, UAT-EXEC-08, UAT-RUNNER-05, UAT-EXEC-09, UAT-EXEC-09-RUNNER, UAT-EXEC-UI, UAT-SHELL-04-UI, UAT-EMPTY-03 |
| UI-06A | UAT-EXEC-02, UAT-EXEC-03, UAT-EXEC-UI |
| UI-06B | UAT-EXEC-03, UAT-EXEC-04, UAT-EXEC-05, UAT-EXEC-UI |
| UI-06C | UAT-EXEC-06, UAT-EXEC-UI |
| UI-06D | UAT-EXEC-01, UAT-EXEC-06, UAT-GATE-01, UAT-GATE-02, UAT-EXEC-09, UAT-EXEC-UI, UAT-EMPTY-03 |
| UI-06E | UAT-MSG-01, UAT-MSG-02, UAT-MSG-03, UAT-MSG-UI, UAT-EMPTY-03 |
| UI-07 | UAT-VERIFY-01 |
| UI-07-01 | UAT-VERIFY-01, UAT-EMPTY-04 |
| UI-07-01A | UAT-TASK-11, UAT-EXEC-05, UAT-VERIFY-01, UAT-VERIFY-02, UAT-EMPTY-04 |
| UI-07-02 | UAT-VERIFY-02, UAT-EMPTY-04 |
| UI-07-03 | UAT-GATE-01, UAT-GATE-02, UAT-VERIFY-03 |
| UI-08 | UAT-CI-01 |
| UI-08-01 | UAT-RESP-01, UAT-CI-01, UAT-EMPTY-05 |
| UI-08-01A | UAT-RESP-02, UAT-CI-01, UAT-CI-02, UAT-CI-04, UAT-CI-05, UAT-TASK-10-CI |
| UI-08-02 | UAT-CI-02, UAT-CI-03, UAT-EMPTY-05 |
| UI-08-03 | UAT-CI-05 |
| UI-08-04 | UAT-CI-04, UAT-CI-06 |
| UI-08-05 | UAT-CI-06, UAT-EMPTY-05 |
| UI-09 | UAT-CP-01, UAT-EMPTY-02 |
| UI-09A | UAT-RESP-01, UAT-RESP-02, UAT-CP-01, UAT-CP-02, UAT-CP-03, UAT-RESP-01-UI, UAT-RESP-02-UI |
| UI-10 | UAT-HISTORY-01, UAT-EMPTY-04 |
| UI-11 | UAT-STATE-02, UAT-REPORT-01, UAT-REPORT-03, UAT-EMPTY-06 |
| UI-11A | UAT-REPORT-02 |
| UI-11B | UAT-REPORT-03, UAT-REPORT-04, UAT-REPORT-05, UAT-EMPTY-06 |
| UI-11C | UAT-REPORT-03, UAT-REPORT-05, UAT-EMPTY-06 |
| UI-11D | UAT-REPORT-05, UAT-REPORT-06, UAT-MAIL-03, UAT-MAIL-05, UAT-EMPTY-07 |
| UI-12 | UAT-SHELL-01 |
| UI-12-01 | UAT-RUNNER-01, UAT-RUNNER-UI |
| UI-12-01A | UAT-PROJECT-02, UAT-GITHUB-01, UAT-GITHUB-02, UAT-GITHUB-UI |
| UI-12-01B | UAT-SHELL-03, UAT-EXEC-08, UAT-RUNNER-01, UAT-RUNNER-02, UAT-RUNNER-UI |
| UI-12-01C | UAT-EXEC-03, UAT-RUNNER-03, UAT-EXEC-09-RUNNER, UAT-RUNNER-UI, UAT-EMPTY-11 |
| UI-12-01D | UAT-EXEC-08, UAT-RUNNER-04, UAT-RUNNER-UI, UAT-EMPTY-11 |
| UI-12-01E | UAT-EXEC-08, UAT-RUNNER-02, UAT-RUNNER-05, UAT-RUNNER-UI |
| UI-12-02 | UAT-POLICY-01 |
| UI-12-02A | UAT-POLICY-01, UAT-EMPTY-11 |
| UI-12-02B | UAT-POLICY-02, UAT-POLICY-UI |
| UI-12-03 | UAT-POLICY-03 |
| UI-12-03A | UAT-TASK-04, UAT-POLICY-03, UAT-EMPTY-11 |
| UI-12-03B | UAT-POLICY-04 |
| UI-12-03C | UAT-POLICY-04, UAT-EMPTY-11 |
| UI-12-04 | UAT-MAIL-01 |
| UI-12-04A | UAT-MAIL-01 |
| UI-12-04B | UAT-GITHUB-02, UAT-MAIL-02 |
| UI-12-04C | UAT-MAIL-04, UAT-MAIL-05, UAT-MAIL-06, UAT-EMPTY-07 |
| UI-12-05 | UAT-TG-01 |
| UI-12-05A | UAT-GITHUB-02, UAT-TG-01, UAT-TG-02, UAT-TG-03, UAT-TG-04, UAT-TG-08 |
| UI-12-05B | UAT-TG-03, UAT-TG-05, UAT-TG-06, UAT-TG-07 |
| UI-12-05C | UAT-TG-03, UAT-TG-09 |
| UI-12-05D | UAT-RESP-02, UAT-TG-05, UAT-TG-06, UAT-TG-07, UAT-TG-08, UAT-TG-09, UAT-EMPTY-08 |
| UI-12-06 | UAT-POLICY-05 |
| UI-12-06A | 주입 도구 제외; 실제 상태는 UAT-STATE 및 acceptance-coverage 오류 참조표로 검증 |
| UI-13 | 정상 제품화면 제외; 모르는 URL404는 UAT-SHELL-05 |
| SYS-01 | UAT-STATE-01, UAT-STATE-02, UAT-STATE-03, UAT-STATE-04, UAT-STATE-05, UAT-STATE-02-UI |
| SYS-02 | UAT-STATE-06, UAT-STATE-07, UAT-STATE-08, UAT-TG-03 |
| SYS-03 | UAT-STATE-05 |
| MOD-01 | UAT-STATE-08, UAT-STATE-10 |
| MOD-02 | UAT-TG-04 |
| MOD-03 | UAT-MAIL-03, UAT-MAIL-04, UAT-TG-09 |
| MOD-04 | UAT-MAIL-03 |
| MOD-05 | UAT-STATE-10, UAT-RESET-01, UAT-RESET-02, UAT-RESET-03, UAT-RESET-04, UAT-RESET-UI |
| MOD-06 | UAT-STATE-10, UAT-WIZ-01, UAT-WIZ-02, UAT-WIZ-03, UAT-WIZ-04 |
| MOD-06A | UAT-WIZ-01, UAT-WIZ-02 |
| MOD-06B | UAT-WIZ-01 |
| MOD-06C | UAT-WIZ-02, UAT-WIZ-03 |
| MOD-07 | UAT-STATE-10, UAT-CP-01 |
| MOD-08 | UAT-STATE-09, UAT-STATE-10, UAT-WIZ-04 |
| UI-AUTH | UAT-AUTH-01, UAT-AUTH-02, UAT-AUTH-03 |

## 판정 가능한 시나리오

### UAT-AUTH-01 · UI-AUTH

- 전제: LAN 모드, 미로그인.
- 동작/사건: 보호 화면 URL로 접속하고 비밀번호로 로그인.
- [ ] **UAT-AUTH-01** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 로그인 화면 1개에서 비밀번호 입력과 이 PC 새 링크 발급 안내를 제공하고 성공 후 요청 화면으로 이동하며 세션이 발급된다.
- 근거: owner Q-01, plan architecture §4/contracts §2.4; **필수 통과: M3-01**.
- 불일치: 없음.

### UAT-AUTH-02 · UI-AUTH

- 전제: 유효한 loopback 1회용 링크.
- 동작/사건: 링크로 로그인한 뒤 같은 토큰을 다시 사용.
- [ ] **UAT-AUTH-02** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 최초만 성공하고 URL에서 토큰을 제거하며 재사용·만료·비loopback 연결은 LOGIN_FAILED로 거부한다.
- 근거: owner Q-01, plan contracts §2.4; **필수 통과: M3-01**.
- 불일치: 없음.

### UAT-AUTH-03 · UI-AUTH

- 전제: LAN 비밀번호 인증.
- 동작/사건: 틀린 비밀번호로 반복 로그인.
- [ ] **UAT-AUTH-03** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 인증 실패 안내를 표시하고 횟수 제한 시 429를 처리하며 보호 데이터를 표시하지 않는다.
- 근거: plan contracts §2.4; **필수 통과: M3-01**.
- 불일치: 없음.

### UAT-SHELL-01 · UI-00, UI-12

- 전제: 등록된 프로젝트, 1920px.
- 동작/사건: 메뉴 접기/펼치기와 12개 메뉴·설정 6탭 선택.
- [ ] **UAT-SHELL-01** [E2E] 아래 기대를 모두 만족한다.
  - a) 메뉴 폭180/56px, 헤더64px이며 선택 강조·화면·URL이 함께 바뀌고 새로고침/뒤로가기가 같은 화면을 복원한다.
  - b) M3에서는12메뉴·설정6탭의 라우트·선택 강조·URL/복원만 판정하고 설계/보고서/CI 본문과 메일/알림 탭 내용은 해당 M6/M7 UAT에서 판정한다.
- 근거: P27–60,3063–3076; G348; **필수 통과: M3-08**.
- 불일치: MM-21, MM-29.

### UAT-SHELL-02 · UI-00, UI-02A, UI-02B

- 전제: 미등록 또는 초기 WBS 승인 전.
- 동작/사건: 프로젝트·설정과 나머지 메뉴 선택.
- [ ] **UAT-SHELL-02** [E2E] 아래 기대를 모두 만족한다.
  - a) 프로젝트·설정은 열리고 나머지는 등록/초기승인 필요 안내와 함께 잠기며 승인 뒤 잠금이 풀린다.
- 근거: P6874–6879; G87; **필수 통과: M3-04**.
- 불일치: MM-22.

### UAT-SHELL-03 · UI-00, UI-12-01B

- 전제: Runner 온라인.
- 동작/사건: Runner heartbeat 중단 후 재연결 보고.
- [ ] **UAT-SHELL-03** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 헤더와 설정이 같은 연결 상태를 표시하고 새 실행 보류·복구가 보고에 따라 반영되며 사용자용 Mock 연결 전환 버튼은 없다.
- 근거: P658,2276; G93; plan D-23; **필수 통과: M4-01**.
- 불일치: 없음.

### UAT-SHELL-04 · UI-00, UI-03, UI-06

- 전제: 동일 fixture·고정시각, 1280/1920px.
- 동작/사건: 각 주요 화면을 열어 스크린샷·텍스트 확인.
- [ ] **UAT-SHELL-04** [시각+수동] 아래 기대를 모두 만족한다.
  - a) 페이지 가로 스크롤과 필수 열 잘림 없이 모든 정보에 접근하고 Pretendard GOV·상태 색+텍스트·개별 모달 폭·P의20/24px 페이지 패딩을 재현하며 본문 문장은12px 이상이다.
- 근거: P14–644; G1206–1207; plan M0-04; **필수 통과: M8-01**.
- 불일치: MM-28, MM-29.

### UAT-SHELL-05 · UI-00

- 전제: 존재하지 않는 URL.
- 동작/사건: 직접 접속.
- [ ] **UAT-SHELL-05** [E2E] 아래 기대를 모두 만족한다.
  - a) 제작 예정 Phase 카드 대신404 화면을 제공하며 정상12개 메뉴에 가짜 메뉴를 추가하지 않는다.
  - b) 이 항목의 M3 통과는 미등록 URL404와 정상 메뉴 라우트 구분에 한정한다.
  - c) 정상 후속 메뉴의 본문/제작 예정 표시 최종 판정은 SHELL-04(M8-01)의 범위다.
- 근거: P2678–2688,7062; review MM-26 권고 채택; **필수 통과: M3-01**.
- 불일치: MM-26.

### UAT-RESP-01 · UI-00, UI-03B, UI-08-01, UI-09A

- 전제: 1024/768px 표와390px실제모바일viewport.
- 동작/사건: 헤더/도구막대와표의오른쪽열탐색.
- [ ] **UAT-RESP-01** [E2E+시각] 아래 기대를 모두 만족한다.
  - a) viewport meta가CSS폭을실제기기폭과일치시키고페이지/도구막대비의도넘침없이1280미만표는영역내가로스크롤로모든열을읽을수있으며overflow:hidden으로자를수없다.
- 근거: plan a60216d open-questions §0/D-28; review B4; **필수 통과: M7-05**.
- 불일치: MM-29.

### UAT-RESP-02 · UI-03E, UI-08-01A, UI-09A, UI-12-05D

- 전제: 390px휴대폰, LAN접속주소·인증사용가능.
- 동작/사건: Telegram알림의Task/CI/변경제안링크각각열기.
- [ ] **UAT-RESP-02** [E2E+시각] 아래 기대를 모두 만족한다.
  - a) 로그인후지정상세를직접열고핵심필드·상태·실패사유/Diff·근거링크를잘림없이열람하며메뉴/목록전체기능을휴대폰필수범위로확장하지않는다.
- 근거: plan a60216d open-questions §0/D-28; G499–501; **필수 통과: M7-05**.
- 불일치: MM-29.

### UAT-STATE-01 · SYS-01, UI-03, UI-01

- 전제: 첫 화면 API 응답을 지연.
- 동작/사건: 처음 WBS와 대시보드 열기.
- [ ] **UAT-STATE-01** [E2E] 아래 기대를 모두 만족한다.
  - a) 각 화면 배치의 skeleton을 표시하고 응답 후 실제 콘텐츠로 교체하며200ms 이내 응답은 표시 생략, 표시한 skeleton은 약300ms 유지한다.
- 근거: P684–691; G76–85; **필수 통과: M3-07**.
- 불일치: MM-17.

### UAT-STATE-02 · SYS-01, UI-03, UI-11

- 전제: 이미 로드한 목록·보고서.
- 동작/사건: 필터·정렬·보고서 선택의 응답을 지연.
- [ ] **UAT-STATE-02** [E2E] 아래 기대를 모두 만족한다.
  - a) 이전 화면과 상단 진행막대를 유지하고 보고서 선택은 문서 영역만 로딩하며 응답 뒤 요청한 데이터로 교체한다.
- 근거: P6814–6841; G79–83; **필수 통과: M6-01**.
- 불일치: 없음.

### UAT-STATE-03 · SYS-01

- 전제: 일정 재계산 중.
- 동작/사건: 재계산을 시작하고 완료 보고.
- [ ] **UAT-STATE-03** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 화면을 흐리게 하고 일정 다시 계산 중 안내와 클릭 차단을 표시하며 완료 후 최신 일정과 상호작용을 복원한다.
- 근거: P675,6841; G81; **필수 통과: M3-08**.
- 불일치: 없음.

### UAT-STATE-04 · SYS-01

- 전제: 현재 화면 API가 약10초 응답하지 않음.
- 동작/사건: 실패 전환 후 다시 시도.
- [ ] **UAT-STATE-04** [E2E] 아래 기대를 모두 만족한다.
  - a) 메뉴 제목·503 원인·마지막 성공시각·재시도를 표시하고 재시도 성공 시 데이터가 복구되며6초 고정 타이머를 제품 규칙으로 쓰지 않는다.
- 근거: P692–700,4624; G85; **필수 통과: M3-01**.
- 불일치: MM-17.

### UAT-STATE-05 · SYS-01, SYS-03

- 전제: 저장 요청 중, 동작 줄이기 선호.
- 동작/사건: 저장 버튼 연타 후 성공 응답.
- [ ] **UAT-STATE-05** [E2E] 아래 기대를 모두 만족한다.
  - a) 처리중 문구와 disabled로 중복 저장을 막고 완료 후 실제 저장 결과와 status 안내를 제공하며 reduced-motion에서 skeleton·막대·스피너 회전이 멈춘다.
- 근거: P599,5017–5035; G83–85; **필수 통과: M3-01**.
- 불일치: MM-17.

### UAT-STATE-06 · SYS-02, UI-03-01

- 전제: 편집 중 입력 있음.
- 동작/사건: 저장500 또는 응답없는 네트워크 오류를 각각 발생시킨 후 재시도.
- [ ] **UAT-STATE-06** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 데이터는 미반영, 입력은 유지되고 오류에 동작·코드·시각·조치가 보이며 재시도 성공 때만 편집이 닫힌다.
- 근거: P677–682,5037–5051; G70–73; **필수 통과: M3-03**.
- 불일치: MM-03, MM-30.

### UAT-STATE-07 · SYS-02

- 전제: 서버 검증400.
- 동작/사건: 필수값 누락 저장.
- [ ] **UAT-STATE-07** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 고칠 항목을 안내하고 초안을 유지하며 같은 잘못된 요청을 재전송하는 다시 시도 버튼은 없고 입력 수정 뒤 저장할 수 있다.
- 근거: P6844–6858; G47,70; **필수 통과: M3-01**.
- 불일치: MM-30.

### UAT-STATE-08 · MOD-01, SYS-02

- 전제: 같은 Task를 두 세션에서 편집.
- 동작/사건: 먼저 저장한 뒤 낡은 버전으로 저장.
- [ ] **UAT-STATE-08** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 409와 해당 Task의 서버 최신 변경·내 변경을 표시하고 다른 Task 마지막 이력을 대신 표시하지 않으며 내 변경 버림/최신 위 재적용이 각 선택대로 저장된다.
- 근거: P2692–2704,6853–6858; G73,1010; **필수 통과: M3-03**.
- 불일치: MM-20.

### UAT-STATE-09 · MOD-08, UI-03F

- 전제: 개요·명세·설계 중 하나 편집 중.
- 동작/사건: 탭/Task/메뉴 이동 후 버리기 확인 취소 또는 확인.
- [ ] **UAT-STATE-09** [E2E] 아래 기대를 모두 만족한다.
  - a) 취소는 입력과 현재 화면을 유지하고 확인만 초안을 버리고 이동하며 삭제 확인도 취소 시 원본을 보존한다.
- 근거: P5052–5054,5620,5631; **필수 통과: M3-03**.
- 불일치: 없음.

### UAT-STATE-10 · MOD-01, MOD-05, MOD-06, MOD-07, MOD-08

- 전제: M3 제품 모달을 열기.
- 동작/사건: 키보드 Tab/Shift+Tab/Esc 조작.
- [ ] **UAT-STATE-10** [E2E+수동] 아래 기대를 모두 만족한다.
  - a) 포커스가 모달 내부로 이동·순환하고 배경으로 빠지지 않으며 닫으면 원래 컨트롤로 복원되고 접근성 제목 ID가 유일하다.
- 근거: P2694,2889; G283; review B5 권고 채택; 메일/TG 모달은 MAIL-03/TG-04의 공통 접근성 회귀; **필수 통과: M3-05**.
- 불일치: MM-29.

### UAT-PROJECT-01 · UI-02A

- 전제: 미등록, GitHub 인증됨.
- 동작/사건: 이름과 저장소 URL·선택 목표일·기술제약·지시 입력 후 접근 확인.
- [ ] **UAT-PROJECT-01** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) GitHub 저장소까지만 허용하고 tree/blob 주소는 거부하며 main 커밋·private 접근·구조·설계md목록을 실제 Runner 결과대로 표시한다.
- 근거: P712–727,3744–3763; G217–235; **필수 통과: M4-04**.
- 불일치: MM-23, MM-27.

### UAT-PROJECT-02 · UI-02A, UI-12-01A

- 전제: 잘못된 URL/권한없음/필수구조없음을 각각 준비.
- 동작/사건: 접근 확인·등록 요청.
- [ ] **UAT-PROJECT-02** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 각 원인과 없는 경로를 표시하고 확인 실패·이름없음·필수권한누락이면 등록하지 않으며 성공 시 고정 커밋 입력v1과 분석 job이1개 생성된다.
- 근거: P3744–3763; G233–235; **필수 통과: M3-04**.
- 불일치: MM-12, MM-27, MM-30.

### UAT-PROJECT-03 · UI-02A, UI-02C

- 전제: 등록 기술제약 여러개.
- 동작/사건: 필수·조건부 선호·금지 추가/삭제 후 분석.
- [ ] **UAT-PROJECT-03** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 제약과 조건문이 보존되고 팀장 지정은 그대로 적용되며 조건부 판단·Agent 제안에는 근거·대안·개별 승인/반려를 제공한다.
- 근거: P721–724,760–773; G217–238; **필수 통과: M5-04**.
- 불일치: 없음.

### UAT-PROJECT-04 · UI-02B

- 전제: 등록된 분석 job.
- 동작/사건: Runner가 단계 wait/run/done/fail 및 연결 끊김을 보고.
- [ ] **UAT-PROJECT-04** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 실제 단계·보고 로그·원인·조치를 표시하고 Runner 대기에서 진행되지 않으며 자동시간경과만으로 분석 성공하지 않는다.
- 근거: P749–758,4512–4533; G235–240; **필수 통과: M5-04**.
- 불일치: MM-27.

### UAT-PROJECT-05 · UI-02B, UI-02E

- 전제: 초기 checkout 또는 차이 영향분석 단계 실패.
- 동작/사건: 실패 원인 해결 후 다시 시도.
- [ ] **UAT-PROJECT-05** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 실패 단계부터 재개하고 완료 단계는 반복하지 않으며 Git LFS 미설치와 Agent 응답없음을 서로 다른 원인으로 표시한다.
  - b) 등록 취소는 초기화 확인창을 열고 취소 시 분석/프로젝트를 유지하며 확인한 초기화만 등록 전 상태로 돌아간다.
- 근거: P4626–4631,4530–4531; G52,65–66; P752; G65; **필수 통과: M5-04**.
- 불일치: MM-23, MM-30.

### UAT-PROJECT-06 · UI-02C, UI-02D

- 전제: Agent 제안 하나 미결.
- 동작/사건: 기술 결정 확정 후 초기 WBS 승인 시도.
- [ ] **UAT-PROJECT-06** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 미결이면 확정 거부, 모두 정한 뒤 초안을 작성하고 최초 승인 시 실제 초안의 Task수·생성이력·기준v1을 원자적으로 저장하며11건 고정 기대는 없다.
  - b) 초기 승인 성공 뒤 첫 Task 상세로 이동한다.
- 근거: P760–786,4534–4547; G238–239; P4543–4547; **필수 통과: M3-04**.
- 불일치: MM-27.

### UAT-PROJECT-07 · UI-02D

- 전제: WBS 초안 존재.
- 동작/사건: 추가 지시로 재분석.
- [ ] **UAT-PROJECT-07** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 지시를 남기고 Codex 분석부터 다시 진행하되 확정 기술결정을 유지하며 새 revision 초안만 승인할 수 있다.
- 근거: P4548–4552; G238; plan contracts §2.2; **필수 통과: M3-04**.
- 불일치: 없음.

### UAT-PROJECT-08 · UI-02E

- 전제: main에 uiux변경·새md·md삭제·src만변경 커밋.
- 동작/사건: Runner 변경 보고 후 이 버전으로 분석.
- [ ] **UAT-PROJECT-08** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) prototype/uiux와 prototype/docs만 입력변경으로 분류하고 새md추가·삭제를 목록에 반영하며 최신선택커밋을 새버전으로 고정하고 src만변경은 입력변경으로 알리지 않는다.
  - b) 변경 감지 결과의 확인 시각을 최신 보고 시각으로 갱신한다.
- 근거: P4661,6945; G225,230,243–250; P2009–2016; **필수 통과: M4-04**.
- 불일치: MM-04, MM-27.

### UAT-PROJECT-09 · UI-02E

- 전제: 입력 변경을 감지함.
- 동작/사건: 분석 안 함 후 다른 변경을 감지·분석.
- [ ] **UAT-PROJECT-09** [API+E2E] 아래 기대를 모두 만족한다.
  - a) skipped 확인기록을 남기고 다음 분석은 마지막 분석 커밋과 새 커밋 사이 전체차이를 포함하며 CP와 srcV를 연결하고 이미 분석한 커밋은 INPUT_UNCHANGED로 거부한다.
  - b) 입력 버전별 출처 Task 수를 누르면 해당 버전으로 필터한 현재 WBS로 이동하고 감지 확인 시각을 갱신한다.
- 근거: P4653–4693; G243–250; plan contracts §2.2; G248; P2009–2016; **필수 통과: M3-04**.
- 불일치: 없음.

### UAT-PROJECT-10 · UI-02, UI-02E

- 전제: 활성 프로젝트와 기준v1·이력 존재.
- 동작/사건: 이름·설명·시작일·목표일 수정 후 재조회.
- [ ] **UAT-PROJECT-10** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 필수·날짜오류는 거부하고 성공 시 전후·주체 이력을 남기며 날짜변경을 서버 재계산하고 정책 임계값을 넘을 때 새기준을 추가하며 원래v1을 보존한다.
- 근거: P6487–6492; G122,1016; review MM-10 권고 채택; **필수 통과: M3-04**.
- 불일치: MM-10.

### UAT-PROJECT-11 · UI-02, UI-01

- 전제: Phase/WP·Agent참여·계획변경 데이터.
- 동작/사건: WBS구조·Planning·CP·지표 링크 선택.
- [ ] **UAT-PROJECT-11** [E2E] 아래 기대를 모두 만족한다.
  - a) 관련 Phase필터 WBS 또는 해당 전용화면으로 이동하고 진행률/완료율·기간범위·최초/최신기준을 구분해 표시한다.
- 근거: P2032–2079,6274–6333; **필수 통과: M3-07**.
- 불일치: 없음.

### UAT-RESET-01 · UI-02, MOD-05

- 전제: 등록 프로젝트.
- 동작/사건: 초기화창을 열고 틀린 이름/정확한 이름 입력.
- [ ] **UAT-RESET-01** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 삭제건수·Runner정리·제외경로·설정유지 선택을 표시하고 이름불일치 시 실행을 거부하며 입력 원본은 prototype/로 안내하고 zip첨부를 요구하지 않는다.
- 근거: P2084,2765–2781; G253–261; **필수 통과: M3-04**.
- 불일치: MM-19, MM-23.

### UAT-RESET-02 · MOD-05

- 전제: 초기화 전 데이터 있음.
- 동작/사건: 선택 내보내기 다운로드 후 내용검사.
- [ ] **UAT-RESET-02** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 내려받은 파일은 표시한 형식으로 열리고 비밀값·메일수신자가 없으며 내보내기를 생략해도 초기화 가능하다.
- 근거: P4702–4707; plan contracts §2.2 export; **필수 통과: M3-04**.
- 불일치: MM-19.

### UAT-RESET-03 · MOD-05, UI-02A

- 전제: Runner 연결, 시스템 기록 Agent브랜치/PR과 미기록브랜치 존재.
- 동작/사건: 설정유지/삭제 각각으로 초기화.
- [ ] **UAT-RESET-03** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 서버 데이터삭제·epoch증가 후 등록전 복귀, 기록한 Agent브랜치/PR만 정리하고 main되돌림커밋·입력보존을 확인한 뒤 정리완료로 표시하며 강제push를 하지 않는다.
- 근거: P4708–4724; G257,1037; owner Q-11; **필수 통과: M4-04**.
- 불일치: MM-19.

### UAT-RESET-04 · MOD-05, UI-02A, UI-02B

- 전제: Runner 연결 끊김.
- 동작/사건: 초기화 후 재연결·옛 epoch 보고 전송.
- [ ] **UAT-RESET-04** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 서버는 즉시 등록전 상태가 되고 정리대기를 표시하며 재연결 시 정리명령을 먼저 처리하고 결과 전 새 분석을 막으며 옛 보고는409 EPOCH_MISMATCH로 거부한다.
- 근거: P4714–4724; G261–263; **필수 통과: M4-01**.
- 불일치: 없음.

### UAT-WBS-01 · UI-03, UI-03B

- 전제: 서로 다른 분류/상태/담당 Task.
- 동작/사건: ID·제목 검색과8개 선택필터 조합 후 초기화.
- [ ] **UAT-WBS-01** [E2E] 아래 기대를 모두 만족한다.
  - a) 매칭Task와 상위Phase/WP가 함께 보이고 필터초기화는 검색도 지우며 기록없음과 조건에 맞는Task없음을 구분한다.
- 근거: P813–822,842–898; G271–275; **필수 통과: M3-02**.
- 불일치: 없음.

### UAT-WBS-02 · UI-03, UI-03A, UI-03B

- 전제: 여러 WP의 Task.
- 동작/사건: WP내정렬·그룹캐럿·모두접기/펼치기·컬럼설정.
- [ ] **UAT-WBS-02** [E2E] 아래 기대를 모두 만족한다.
  - a) 정렬은 WP내에 적용하고 WBS/제목은 항상 표시하며 기본8컬럼·선택최근변경을 정확히 제어하고 캐럿은 Task선택을 바꾸지 않는다.
- 근거: P825–838,858–890; **필수 통과: M3-02**.
- 불일치: 없음.

### UAT-WBS-03 · UI-03, UI-03D, UI-03E

- 전제: Task목록과 상세링크.
- 동작/사건: Task열기·레일이전/다음·필터외Task링크·펼치기.
- [ ] **UAT-WBS-03** [E2E] 아래 기대를 모두 만족한다.
  - a) 260px레일+상세로 전환하고 레일순서와 위치를 따르며 목록밖·참조복귀를 표시하고 펼치면 필터/정렬/스크롤을 유지한 표로 돌아간다.
- 근거: P804–810,924–977; G276–283; **필수 통과: M3-03**.
- 불일치: 없음.

### UAT-WBS-04 · UI-03, UI-03C

- 전제: 기준·실제·미착수·불가일·목표일 fixture.
- 동작/사건: Gantt 전환 후 Task막대 선택.
- [ ] **UAT-WBS-04** [E2E+시각] 아래 기대를 모두 만족한다.
  - a) 전체기간맞춤으로 기준/예측/진척/낙관비관범위/현재/목표/불가일을 구분하고 Task로 이동하며 일주확대·전체상세토글·compact안내 잔재를 노출하지 않는다.
- 근거: P899–921,6975,7080–7086; G274; **필수 통과: M3-03**.
- 불일치: MM-25.

### UAT-WBS-05 · UI-03B

- 전제: 존재하지 않는Task링크와200/1000행 fixture.
- 동작/사건: 잘못된링크 열기와 대량목록 탐색.
- [ ] **UAT-WBS-05** [E2E] 아래 기대를 모두 만족한다.
  - a) TASK_NOT_FOUND와 닫기를 표시해 메뉴를 유지하고 대량목록은 가상스크롤/페이징으로 모든행에 접근하며 렌더·응답측정기록을 남긴다.
- 근거: P793,4447; G1019; plan M3-02; **필수 통과: M3-02**.
- 불일치: 없음.

### UAT-WIZ-01 · MOD-06, MOD-06A, MOD-06B

- 전제: 새Task Wizard.
- 동작/사건: 필수값누락·시간0/400초과·날짜형식오류로 다음 선택.
- [ ] **UAT-WIZ-01** [E2E] 아래 기대를 모두 만족한다.
  - a) 제목/유형/주영역/목적/완료조건 등 단계별 오류를 표시하고 다음을 막으며 유효입력과 이전단계 이동에서 입력을 보존한다.
- 근거: P2791–2811,6787–6794; **필수 통과: M3-02**.
- 불일치: 없음.

### UAT-WIZ-02 · MOD-06, MOD-06A, MOD-06C

- 전제: 현재WP목록에 WP-06 없음.
- 동작/사건: Wizard WP목록 확인 후 삭제되거나 없는WP로 직접 생성요청.
- [ ] **UAT-WIZ-02** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 실존WP만 선택할 수 있고 서버는 없는부모를4xx로 거부하며 Task사전/트리/이력에 부분생성이나 전체화면오류가 없다.
- 근거: P2794,6787,6795–6811; review MM-05 권고 채택; **필수 통과: M3-02**.
- 불일치: MM-05.

### UAT-WIZ-03 · MOD-06, MOD-06C, UI-03-02

- 전제: 필수정보 유효, 미완료선행Task 선택.
- 동작/사건: 확인단계에서 생성.
- [ ] **UAT-WIZ-03** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 고유Task ID와 계산WBS번호·분류/Agent·설계섹션·FS선행을 표시하고 planning으로 생성하여 차단안내·이력·일정에 반영하며 작업명세탭을 연다.
- 근거: P2813–2843,6795–6811; **필수 통과: M3-03**.
- 불일치: 없음.

### UAT-WIZ-04 · MOD-06, MOD-08

- 전제: 제목 또는 목적 입력.
- 동작/사건: Wizard 닫기 후 취소/생성취소 선택.
- [ ] **UAT-WIZ-04** [E2E] 아래 기대를 모두 만족한다.
  - a) 확인 취소는 입력을 유지하고 생성취소만 초안을 버리며 Task를 생성하지 않는다.
- 근거: P7104–7108; **필수 통과: M3-02**.
- 불일치: 없음.

### UAT-TASK-01 · UI-03E, UI-03-01

- 전제: 상세Task와 선행차단·검증·Gate 데이터.
- 동작/사건: 9개탭과 요약 확인.
- [ ] **UAT-TASK-01** [E2E] 아래 기대를 모두 만족한다.
  - a) ID/WBS/제목/분류/담당·검증/우선순위/선행/체크수/검증/Gate/일정·진척 및 탭별 건수가 서버값과 일치하고 상태를 색+텍스트로 표시한다.
  - b) 차단 배너는 미충족 선행의 링크와 FS/SS 사유를 표시하고 링크는 해당 선행 Task로 이동한다.
- 근거: P924–977,1028–1108; P924–977; **필수 통과: M3-03**.
- 불일치: 없음.

### UAT-TASK-02 · UI-03-01

- 전제: 개요 편집.
- 동작/사건: 제목/목적/완료조건·시간범위·토큰·고정시작일 변경 후 저장/취소.
- [ ] **UAT-TASK-02** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 필수·0<시간≤400·낙관≤예상≤비관·토큰정수·날짜형식을 검증하고 취소는 원본보존, 성공은 전후이력·서버일정·명세와공유하는범위/제외를 갱신한다.
  - b) 담당과 검증 Agent가 같으면 경고를 표시한다.
- 근거: P1111–1127,5362–5388; P1115–1116; **필수 통과: M3-03**.
- 불일치: 없음.

### UAT-TASK-03 · UI-03-01A

- 전제: 개발·검증 등급 자동값.
- 동작/사건: 각각 변경·고정 후 해제.
- [ ] **UAT-TASK-03** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 모델/Effort·근거·주체·고정여부를 구분하고 최저선미달 경고·재추정·이력·일정갱신을 표시하며 해제 후 Planning판단을 따른다.
- 근거: P1064–1085,6195–6209; owner Q-06; **필수 통과: M3-03**.
- 불일치: 없음.

### UAT-TASK-04 · UI-03-01B, UI-12-03A

- 전제: 미착수위반Task와 이미시작Task.
- 동작/사건: 분할제안 또는 예외사유 기록.
- [ ] **UAT-TASK-04** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 미착수는검증가능AC를분배한CP·선행재연결·원Task취소로 처리하고 시작Task는자동분할하지않으며 예외근거·주체·시각을 이력에 남긴다.
- 근거: P1086–1094,4556–4581; **필수 통과: M3-08**.
- 불일치: 없음.

### UAT-TASK-05 · UI-03-02, UI-03F

- 전제: 명세 섹션 없음/있음.
- 동작/사건: 각섹션 편집과 AC/산출물 표 행추가·삭제·저장.
- [ ] **UAT-TASK-05** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 6그룹13섹션을 구조화해 제공하고 Given/When/Then·검증방법 및 산출물경로/유형/필수/검증조건/제출을 보존하며 필수빈칸은저장거부, 메시지만으로명세를바꾸지않는다.
- 근거: P1131–1157,2952–2983; **필수 통과: M3-03**.
- 불일치: 없음.

### UAT-TASK-06 · UI-03-03

- 전제: FS선행 미완료, SS선행 실제시작 및 시작전취소가능 fixture.
- 동작/사건: 선행상태변경·자기참조/중복/순환추가·관계삭제·선행취소CP미리보기/반영.
- [ ] **UAT-TASK-06** [API+E2E] 아래 기대를 모두 만족한다.
  - a) FS는 완료 전 차단하고 SS는 실제 시작 사건으로만 충족한다.
  - b) 자기참조·중복·순환은 미반영하고 오류/순환경로를 보이며 관계 삭제는 확인 뒤 이력을 남긴다.
  - c) 시작 전 취소 선행의 SS 관계는 취소 반영과 원자적으로 제거하고 취소를 시작으로 간주하지 않는다.
  - d) 다른 미충족 선행이 남으면 계속 차단한다.
  - e) 취소 CP는 removedDependencies와 unblockedSuccessors/remainingBlockers로 제거 관계·실제 풀리는 후속·계속 차단되는 후속을 구분한다.
- 근거: P1159–1211,3677–3711; G650–655; plan a60216d D-27/contracts §2.1; **필수 통과: M3-05**.
- 불일치: MM-09.

### UAT-TASK-07 · UI-03-04, UI-03F

- 전제: DB/API/FE/DevOps 및 관련영역Task.
- 동작/사건: 설계섹션과 엔티티/블록 추가·편집·삭제.
- [ ] **UAT-TASK-07** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 필요영역만기본제공하고 DB컬럼/FK/인덱스·API요청응답/검증오류·FE화면/상태·DevOps환경/명령을구조화하며 삭제확인·전후이력을 제공한다.
- 근거: P1213–1267,2952–2983,5453–5636; **필수 통과: M3-03**.
- 불일치: 없음.

### UAT-TASK-08 · UI-03-04, UI-03F

- 전제: 설계 편집기.
- 동작/사건: 중복테이블·없는FK·nullable PK·없는인덱스컬럼·중복Endpoint·잘못된HTTP/환경변수 입력.
- [ ] **UAT-TASK-08** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 중복 테이블·없는 FK·nullable PK·없는 인덱스 컬럼은 해당 필드/행 오류로 저장을 막는다.
  - b) 중복 Endpoint·잘못된 HTTP/환경변수도 구체 오류로 저장을 막는다.
  - c) 실패 때 초안을 유지한다.
  - d) 유효 저장 뒤 관계 테이블 계산과 비밀 환경값 마스킹을 확인한다.
- 근거: P5549–5591; **필수 통과: M3-03**.
- 불일치: 없음.

### UAT-TASK-09 · UI-03-05

- 전제: 필수·선택 체크리스트와 빈목록.
- 동작/사건: 항목추가와 완료토글.
- [ ] **UAT-TASK-09** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 빈내용추가는거부하고 필수/선택·방법·Evidence·비고를표시하며 완료수/Gate/이력을갱신하고 필수미완료면자동완료되지않는다.
- 근거: P1269–1301,5342–5353; **필수 통과: M3-03**.
- 불일치: 없음.

### UAT-TASK-10 · UI-03-06, UI-03-07, UI-03-08

- 전제: 재작업·검증이 누적된Task.
- 동작/사건: 실행/검증/이력탭과 실행 화면 링크 선택.
- [ ] **UAT-TASK-10** [E2E] 아래 기대를 모두 만족한다.
  - a) 이전Attempt/Verification을덮어쓰지않고 실제등급·조정사유·지정/실제하위Agent·실패/파일/증거·전후이력을표시한다.
  - b) 실행 탭의 실행 화면 링크는 해당 Task의 실행 화면으로 이동한다.
- 근거: P1303–1349; P1303–1324; **필수 통과: M3-06**.
- 불일치: 없음.

### UAT-TASK-11 · UI-03, UI-03D, UI-07-01A

- 전제: 목록 또는 상세에키보드포커스.
- 동작/사건: ↑↓ 또는 J/K·Enter·Esc 조작.
- [ ] **UAT-TASK-11** [E2E] 아래 기대를 모두 만족한다.
  - a) 이전다음Task와선택항목을열고 Esc로상세를펼쳐목록복귀하며 텍스트입력중탐색키가초안입력을침해하지않는다.
- 근거: G283; review B5 권고 채택; **필수 통과: M3-07**.
- 불일치: MM-29.

### UAT-PLAN-01 · UI-05, UI-05-01

- 전제: Planning 세션에일치/미조정이견 존재.
- 동작/사건: 두Agent분석비교·이견안선택·CP생성.
- [ ] **UAT-PLAN-01** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 독립분석을나란히보이고 미조정/시뮬레이션문제는생성차단하며 조정결과와동일Diff의CP를만들어정책대로대기/자동반영한다.
- 근거: P1614–1683,5704–5724; **필수 통과: M5-04**.
- 불일치: 없음.

### UAT-PLAN-02 · UI-05-02

- 전제: 자동 재조정 켜짐/꺼짐, 일정 변경 사건.
- 동작/사건: 자동 사건 처리·꺼짐의 pending 조회·팀장 재조정 실행 후 RP 이력과 변경 Task 펼침.
- [ ] **UAT-PLAN-02** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 자동 켜짐은 정책에 따라 재조정한다.
  - b) 꺼짐은202 pending만 기록하고 기준선을 바꾸지 않는다.
  - c) Planning의 재조정 실행은 POST /api/replans/run으로 재계산·확정한다.
  - d) RP별 계기/주체/새기준/예상범위/가동률·Task 전후날짜와 차이를 표시하고 이전 버전을 보존한다.
- 근거: P1618–1637,4284–4303; plan a60216d D-10/contracts §2.2 replans; **필수 통과: M3-05**.
- 불일치: 없음.

### UAT-CP-01 · UI-09, UI-09A, MOD-07

- 전제: 팀장 또는메시지에서새CP작성.
- 동작/사건: 7가지변경행추가·삭제·제목/사유입력 후제출.
- [ ] **UAT-CP-01** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 7가지 유효 변경을 Diff와 영향에 표시한다.
  - b) 필수 누락·순환·없는 부모·완료 Task 수정 각각은 구체 오류로 거부한다.
  - c) 행 추가/삭제와 제목/사유가 제출 데이터와 일치한다.
  - d) 제출한 review 상태는 WBS를 변경하지 않는다.
- 근거: P2849–2885,5764–5805; **필수 통과: M3-05**.
- 불일치: 없음.

### UAT-CP-02 · UI-09A

- 전제: CP review·changes·approved 각각.
- 동작/사건: 의견없이반려/수정요청, 의견입력처리, 항목제외·재제출·반영.
- [ ] **UAT-CP-02** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 의견필수검증과승인이력을보존하고 반영직전서버재시뮬레이션결과만원자적적용하며 완료Task·기존검증은보존한다.
- 근거: P1697–1741,5725–5763; **필수 통과: M3-05**.
- 불일치: 없음.

### UAT-CP-03 · UI-09A, UI-05

- 전제: cpAuto 켜짐/꺼짐과충돌제안.
- 동작/사건: Agent합의CP 제출.
- [ ] **UAT-CP-03** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 켜짐은문제없는안만자동승인/반영/재조정하고 문제있으면사유와보류, 꺼짐은팀장승인후반영까지WBS미변경이며 UI의상태·영향이저장결과와일치한다.
- 근거: P5725–5763; G328–332; **필수 통과: M3-05**.
- 불일치: 없음.

### UAT-EXEC-01 · UI-06, UI-06D

- 전제: ready·착수승인Task, 필요한환경정상.
- 동작/사건: 팀장 시작버튼 클릭.
- [ ] **UAT-EXEC-01** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 선행·자원·준비·설치조건을검사한후1개시도를시작하고 개발→①통과→QA로자동진행하며 시작버튼없이첫시도가시작되지않는다.
  - b) 왼쪽 Task/시도 목록·중앙 다음 작업/결과/기록·오른쪽 연결 메시지의3영역과 개발→QA→재작업→재검증→Completion Gate→Task 완료의6단계 흐름을 구분하고 현재 단계의 다음 작업을 표시한다.
  - c) M5-05의①은 자리표시로 흐름 연결만 확인하고 실제①검사 통과는 EXEC-02/M7-06에서 별도 판정한다.
- 근거: P1747–1764; owner Q-02/Q-04; plan D-18; P1747–1764; G§4.6; **필수 통과: M5-05**.
- 불일치: 없음.

### UAT-EXEC-02 · UI-06, UI-06A, UI-03-06

- 전제: 개발/재작업 세션 종료.
- 동작/사건: Runner가 성공/실패 결과·변경파일·사용량을 보고하고 사유 없는 실패도 전송.
- [ ] **UAT-EXEC-02** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 실제 결과를 새 시도에 기록하고 일치 산출물 제출·①검사 결과를 반영한다.
  - b) ①통과 전 QA로 넘기지 않는다.
  - c) 실패 사유 누락은 거부하고 유효 실패는 사유와 failed를 표시한다.
  - d) 팀장 수동 결과입력으로 Runner 검사를 대체하지 않는다.
- 근거: P1767–1779,5870–5901; plan D-18; **필수 통과: M7-04**.
- 불일치: 없음.

### UAT-EXEC-03 · UI-06A, UI-06B, UI-12-01C

- 전제: 실제토큰사용량보고.
- 동작/사건: 음수·소수·NaN·미보고null·정상정수를각각보고.
- [ ] **UAT-EXEC-03** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 실사용량은0이상정수만수락하고무효값은400·사용량불변이며미보고는null/미보고로표시하고K표시는정상단위변환하며임의0으로만들지않는다.
- 근거: P5870–5876,5883–5914; review MM-11 권고 채택; **필수 통과: M4-02**.
- 불일치: MM-11.

### UAT-EXEC-04 · UI-06, UI-06B, UI-03-07

- 전제: qa 또는verifying 실행.
- 동작/사건: PASS/FAIL/BLOCKED를각각보고.
- [ ] **UAT-EXEC-04** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) PASS는gate, FAIL은rework, BLOCKED는대표상태유지·verif=blocked이며 원인해결후새검증시도를만들고 이전Verification·Evidence를보존한다.
- 근거: P5902–5920; owner Q-05 §0.1; **필수 통과: M5-05**.
- 불일치: 없음.

### UAT-EXEC-05 · UI-06B, UI-07-01A

- 전제: 검증보고및체크리스트.
- 동작/사건: 명령/실제결과누락·FAIL결함없음과유효증거보고.
- [ ] **UAT-EXEC-05** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 필수누락은거부하고 유효검증에명령/기대/실제/결함/Evidence와선택체크연결을표시하며BLOCKED가체크완료를바꾸지않는다.
- 근거: P1781–1799,5902–5920; **필수 통과: M5-05**.
- 불일치: 없음.

### UAT-EXEC-06 · UI-06, UI-06C, UI-06D

- 전제: 착수 전 실패·BLOCKED·같은 종류 연속 프로세스 실패·QA/통합 FAIL 및 한도 소진 fixture.
- 동작/사건: 실패/성공/중단 전이와 자동 재시도·재작업·한도 뒤 수동 다시 시도.
- [ ] **UAT-EXEC-06** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 같은 종류 연속 프로세스 실패는 자동2회/총3회이고 성공하면 카운터0으로 복귀한다.
  - b) QA+통합 FAIL 합산 자동 재작업은3회이며 재작업 중 프로세스 실패는 재작업 횟수를 늘리지 않고 중단·BLOCKED·재개는 두 카운터에 포함하지 않는다.
  - c) 시작 전 실패는 항상 다시 시도 버튼을 제공하고 BLOCKED는 원인 해결 후 새 검증 시도를 만들며 자동 반복하지 않는다.
  - d) 한도 소진 뒤 사유·팀장 조치를 표시하고 수동 버튼은1회 실행만 허용하며 카운터를 초기화하지 않는다.
- 근거: P1801–1809; owner Q-04/Q-05; plan a60216d contracts §3.5; **필수 통과: M7-06**.
- 불일치: MM-07.

### UAT-EXEC-07 · UI-06, UI-03-01A

- 전제: 재작업정책과중단시도.
- 동작/사건: 자동재작업·사용량부족·중단재개를각각실행.
- [ ] **UAT-EXEC-07** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 정책범위와최저선을지키며상향/하향/유지근거·실제모델/Effort를기록하고중단재개는새시도·같은등급을유지한다.
  - b) 최상위 등급에서 정책 임계 횟수만큼 반복 재작업하면 팀장 알림을 표시한다.
- 근거: P5806–5856; owner Q-06; G208; P5822; **필수 통과: M5-05**.
- 불일치: 없음.

### UAT-EXEC-08 · UI-06, UI-12-01B, UI-12-01D, UI-12-01E

- 전제: 같은 host에서 offline/선행차단/사용량0/준비fail/보유미확인/동일충돌묶음/상한도달 각각.
- 동작/사건: 새실행요청.
- [ ] **UAT-EXEC-08** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 대상별구체보류사유를화면에표시하고시도·자원을중복생성하지않으며조건해소후에만시작한다.
- 근거: P6080–6092,5806–5856; **필수 통과: M5-02**.
- 불일치: 없음.

### UAT-GATE-01 · UI-03E, UI-06D, UI-07-03

- 전제: Gate5조건중하나실패 또는②미통과/미병합.
- 동작/사건: QA PASS·완료요청·늦은결함변경을발생.
- [ ] **UAT-GATE-01** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 5조건별판정·미충족사유를보이고 done을거부하며UI수동완료버튼/열린확인창이서버검사를우회하지못한다.
- 근거: P3689–3699,5389–5397; G491,668; owner Q-02; **필수 통과: M7-06**.
- 불일치: MM-01.

### UAT-GATE-02 · UI-06D, UI-03E, UI-07-03

- 전제: 착수승인·같은head/명세의①/QA/②통과 및PR병합확인.
- 동작/사건: 서버가완료판정사건처리.
- [ ] **UAT-GATE-02** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 같은트랜잭션에서Gate와검증근거를재판정하여자동done·완료시각·이력·후속차단해소를기록하고 팀장최종완료승인을요구하지않는다.
- 근거: owner Q-02/Q-05; plan M7-06; **필수 통과: M7-06**.
- 불일치: MM-01.

### UAT-MSG-01 · UI-03-09, UI-06E

- 전제: Task별작성초안과긴메시지.
- 동작/사건: 탭/Task이동·펼침·유형/Agent/시도선택·전송.
- [ ] **UAT-MSG-01** [API+E2E] 아래 기대를 모두 만족한다.
  - a) Task별초안을유지하고빈본문거부, 공식명세미변경, 전달상태와업무응답을분리하며시도/검증/CP링크와새응답을표시한다.
- 근거: P1351–1395,5399–5431; **필수 통과: M3-06**.
- 불일치: 없음.

### UAT-MSG-02 · UI-03-09, UI-06E

- 전제: liveInject 미지원, running/qa/verifying 각각.
- 동작/사건: 메시지전송 후 다음시도시작.
- [ ] **UAT-MSG-02** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 세실행상태모두다음실행대기로보관하고 다음실행에서전달/ack되며ack만으로Task완료하지않는다; 즉시전달활성은Q-07답전보류한다.
- 근거: P5419–5425; G355,1031; **필수 통과: M5-05**.
- 불일치: MM-08.

### UAT-MSG-03 · UI-03-09, UI-06E

- 전제: Runner연결끊김 또는Queued메시지.
- 동작/사건: 전송실패후재연결·재전송, Queued취소.
- [ ] **UAT-MSG-03** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 원인과Failed/재전송을표시하고성공ack·실제Agent응답을기록하며취소메시지는전달하지않고이전메시지를덮어쓰지않는다.
- 근거: P1373–1392,5413–5431; **필수 통과: M5-05**.
- 불일치: 없음.

### UAT-VERIFY-01 · UI-07, UI-07-01, UI-07-01A

- 전제: 검증결과없음/여러판정·Agent fixture.
- 동작/사건: 필터·행선택·이전다음·펼치기.
- [ ] **UAT-VERIFY-01** [E2E] 아래 기대를 모두 만족한다.
  - a) 기록없음/필터결과없음을구분하고판정/Agent필터·레일/상세·목록밖·Task/시도이동을제공하며결과등록은Runner보고에연결한다.
  - b) 결과·Evidence·Completion Gate 탭 건수가 서버 데이터와 일치한다.
- 근거: P1902–1945; P1902–1907; **필수 통과: M3-07**.
- 불일치: 없음.

### UAT-VERIFY-02 · UI-07-01A, UI-07-02

- 전제: Verification·Evidence와체크리스트.
- 동작/사건: 증거추가·중복추가·연결토글·Evidence행선택.
- [ ] **UAT-VERIFY-02** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 빈/중복경로를거부하고검증소속과체크연결을보존하며행에서소속결과로이동, 검증에없는체크증거는별도경고한다.
  - b) Evidence 추가/연결 후 탭 건수가 실제 목록과 일치한다.
- 근거: P1934–1957,6241–6252; P1902–1907; **필수 통과: M3-07**.
- 불일치: 없음.

### UAT-VERIFY-03 · UI-07-03

- 전제: 통과/미통과Task와없는목록.
- 동작/사건: 전체/미통과만선택.
- [ ] **UAT-VERIFY-03** [E2E] 아래 기대를 모두 만족한다.
  - a) Task×5조건·각사유·합계가서버Gate와일치하고없으면미통과Task없음안내, Task선택은상세로이동한다.
- 근거: P1959–1968; **필수 통과: M3-07**.
- 불일치: 없음.

### UAT-HISTORY-01 · UI-10, UI-03-08

- 전제: 다른기간·주체·유형·Task의이력.
- 동작/사건: 기간/검색/Task/유형/주체필터와초기화.
- [ ] **UAT-HISTORY-01** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 서버기간필터를포함해해당이력만최신순표시하고전후값/주체/Task이동을제공하며기록없음과조건불일치를구분한다.
- 근거: P1972–1991; G336; **필수 통과: M3-07**.
- 불일치: MM-18.

### UAT-DASH-01 · UI-01

- 전제: 지연·승인대기·실행·FAIL·Gate·메시지·환경알림 fixture.
- 동작/사건: KPI·6행동패널·분포·최근결과·알림선택.
- [ ] **UAT-DASH-01** [E2E] 아래 기대를 모두 만족한다.
  - a) 숫자와해당WBS필터/화면/설정탭이일치하고등급별시도·판정·FAIL·재작업률/토큰을보이며빈패널마다발생조건안내를표시한다.
  - b) 등급 통계에 상향 열을 표시하고 최상위 등급 반복 재작업의 정책 임계 알림을 해당 Task와 연결한다.
- 근거: P1858–1900,6274–6333; P1886–1890; G208; **필수 통과: M3-07**.
- 불일치: 없음.

### UAT-RUNNER-01 · UI-12-01, UI-12-01B

- 전제: readiness ok/warn/fail각항목.
- 동작/사건: Runner재점검결과보고.
- [ ] **UAT-RUNNER-01** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 항목별결과·시각·조치와탭배지/알림을표시하고fail인Agent만새실행을막으며UI의조치완료선택만으로실제점검을정상처리하지않는다.
- 근거: P2282–2286,4590–4599; **필수 통과: M4-02**.
- 불일치: 없음.

### UAT-RUNNER-02 · UI-12-01B, UI-12-01E

- 전제: 최신CLI버전으로변경됨.
- 동작/사건: 관측검증버전불일치보고 후재검증등록.
- [ ] **UAT-RUNNER-02** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 미검증·보수계산·재검증안내를표시하고고정/0.167.0하향버튼을제공하지않으며유효한조합검증결과등록뒤에만등급을갱신한다.
- 근거: P4595–4599; owner Q-12; plan D-26; **필수 통과: M8-04**.
- 불일치: 없음.

### UAT-RUNNER-03 · UI-12-01C

- 전제: 최근7일세션기록·사용량보고.
- 동작/사건: 중단·사용량한도·리셋보고.
- [ ] **UAT-RUNNER-03** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 가동률근거·중단구간·Agent별남은사용량/리셋을표시하고한도는해당Agent보류·리셋뒤해제하며보고없는실행중/슬롯행을제품에서제거한다.
  - b) 재부팅/끊김은 기존 시도를 interrupted로 보존하고 Task를 paused로 표시하며 재연결 후에도 이전 결과를 덮어쓰지 않고 재개 조치를 제공한다.
- 근거: P2289–2323,2313; G180; P2320; plan contracts §4.3; **필수 통과: M4-02**.
- 불일치: MM-24.

### UAT-RUNNER-04 · UI-12-01D

- 전제: 자동/직접상한·3종PC사양fixture.
- 동작/사건: 새host·메모리압박·429·안정기간보고.
- [ ] **UAT-RUNNER-04** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 자동 권장 상한과 수동 권장 초과 경고를 표시한다.
  - b) 메모리 압박/429/안정 기간 보고에 따라 현재 한도·자원과 이전→이후/사유 이력을 갱신한다.
  - c) PC 변경 시 기존 시도를 중단하고 새 PC 이력·일정 재계산을 수행한다.
- 근거: P2326–2393,6135–6184; **필수 통과: M4-02**.
- 불일치: 없음.

### UAT-RUNNER-05 · UI-12-01E, UI-06

- 전제: 검증됨/부분/미검증CLI세션과예산.
- 동작/사건: 관측수증가·출력단절·프로세스그룹종료를보고.
- [ ] **UAT-RUNNER-05** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 미검증은max(예산,관측)을보유하고단절시수를줄이지않고새실행보류하며출력완료만으로슬롯반환하지않고그룹종료확정후해제한다.
  - b) 예산 저장 결과를 보유 계산·합계와 다음 실행 지시문에 반영하되 관측 미확인 세션의 수는 줄이지 않는다.
- 근거: P2351–2376,4110–4135; G6.7; G§12-26; plan contracts §3.4; **필수 통과: M5-03**.
- 불일치: 없음.

### UAT-GITHUB-01 · UI-12-01A

- 전제: gh/토큰방식.
- 동작/사건: 형식오류·권한4종누락·인증만료·복구를각각보고.
- [ ] **UAT-GITHUB-01** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 토큰형식오류를거부하고권한하나라도없으면정상연결/등록불가·누락권한안내, 만료시실패/배지/알림·입력작업보류, 실제재확인성공때복구한다.
  - b) 실패 상태는 프로젝트 입력 자료 배너에도 같은 원인을 표시한다.
- 근거: P4804–4812; G1040; **필수 통과: M4-04**.
- 불일치: MM-12.

### UAT-GITHUB-02 · UI-12-01A, UI-12-04B, UI-12-05A

- 전제: 비밀입력저장.
- 동작/사건: 응답·로그·초기화전내보내기와화면재조회.
- [ ] **UAT-GITHUB-02** [API+E2E] 아래 기대를 모두 만족한다.
  - a) GitHub/SMTP/Telegram비밀은쓰기전용이며마스킹/등록여부/허용끝4자리만표시하고평문토큰·비밀번호를응답/로그/내보내기/Agent환경에노출하지않는다.
- 근거: G1040,1051,1070; plan contracts §8; **필수 통과: M8-03**.
- 불일치: 없음.

### UAT-POLICY-01 · UI-12-02, UI-12-02A

- 전제: 기존Task와새Task.
- 동작/사건: 기본Agent·허용모델·등급정책변경.
- [ ] **UAT-POLICY-01** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 기본은새Task에만적용,마지막허용모델해제는거부하고허용변경에맞춰등급/근거/추정/일정을갱신하며ownerQ-06매핑밖ultra/미확인을사용하지않는다.
  - b) 기본 담당=검증 Agent 경고·Workflow 안내를 표시하고 팀장 고정 Task 링크는 해당 Task로 이동한다.
- 근거: P2396–2433; owner Q-06; P2399–2401,2429–2430; **필수 통과: M3-08**.
- 불일치: 없음.

### UAT-POLICY-02 · UI-12-02B, UI-03-01A, UI-03-06

- 전제: 실제검토된하위Agent정의.
- 동작/사건: 사용끄기·정의허용해제·시도시작·설치실패.
- [ ] **UAT-POLICY-02** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 정의/지시문/버전/hash와지정/실제사용/미사용주의를보이고해제시Task지정재판단,설치실패는시작미생성·원인/재시도이며원본10개Mock정의를운영seed에승격하지않는다.
  - b) 전체 끄기는 기존 지정 기록을 유지하고 기본 Agent만 실행하며 정의별 허용 해제의 재판단과 구분한다.
  - c) 정의 외부 참고 링크를 연다.
- 근거: P2435–2450; plan D-24/M5-06; P1081,2435–2450; **필수 통과: M5-06**.
- 불일치: 없음.

### UAT-POLICY-03 · UI-12-03, UI-12-03A

- 전제: 크기/파일수/불확실성위반Task.
- 동작/사건: 분할상하한·파일상한·10규칙변경.
- [ ] **UAT-POLICY-03** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 설정과위반목록/배지가같이갱신되고위반Task링크가개요점검으로이동하며테스트포함·계층별계약먼저를유지한다.
- 근거: P2451–2473; **필수 통과: M3-08**.
- 불일치: 없음.

### UAT-POLICY-04 · UI-12-03B, UI-12-03C

- 전제: 불가일없음/있음과기록72h미만·이상.
- 동작/사건: 정책/임계값/초기가동률변경·불가일추가/해제.
- [ ] **UAT-POLICY-04** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 날짜형식/중복을거부하고불가일용량0과재조정정책을반영하며Q-03가중치·진행률/완료율을정확히표시하고고정Agent5개문구를제거한다.
- 근거: P2474–2510; owner Q-03; **필수 통과: M3-08**.
- 불일치: MM-24.

### UAT-POLICY-05 · UI-12-06

- 전제: 활성데이터와무결성오류fixture.
- 동작/사건: 정합성점검.
- [ ] **UAT-POLICY-05** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 항목별결과/상세·시각을표시하고실서비스에는Prototype구현현황·상태/오류주입·Mock지연전환컨트롤이없다.
- 근거: P2646–2673; plan D-17/D-23; **필수 통과: M3-08**.
- 불일치: MM-21, MM-30.

### UAT-DESIGN-01 · UI-04, UI-04-01

- 전제: 계약스냅샷없음/있음·승인대기·읽기오류.
- 동작/사건: 설계6탭과구성/계약조회·다시읽기.
- [ ] **UAT-DESIGN-01** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 빈안내·대기점선/반려취소선·파일형식/커밋/상태를보이고읽기오류는마지막성공버전과원인/재시도·알림을표시하며실제재해석성공뒤에만해제한다.
  - b) 승인 대기/불일치 건수의 탭 배지와 경고 배너를 실제 상태에 맞게 표시한다.
- 근거: P1483–1508; G412–460; G453; **필수 통과: M6-07**.
- 불일치: 없음.

### UAT-DESIGN-02 · UI-04-02

- 전제: 팀장지정·Agent제안·재량결정.
- 동작/사건: 승인/반려·변경제안승인/반려.
- [ ] **UAT-DESIGN-02** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 권한별조건/근거/대안/시각을보이고팀장지정은Agent변경불가,변경승인전기존결정유지·반려복구·버전증가를기록한다.
- 근거: P1510–1522,4815–4830; **필수 통과: M6-07**.
- 불일치: 없음.

### UAT-DESIGN-03 · UI-04-03, UI-04-03A, UI-04-04, UI-04-04A, UI-03-04

- 전제: 4종인터페이스·4종저장소fixture.
- 동작/사건: 방식/저장소필터·검색·행/이전다음·Task전체설계링크.
- [ ] **UAT-DESIGN-03** [E2E] 아래 기대를 모두 만족한다.
  - a) 목록/레일/상세를전환하고REST요청응답/오류/테이블↔PostgreSQL사용API가양방향연결되며WS/SSE/Kafka·Neo4j/QuestDB/Redis각필드를표시한다.
  - b) 담당 Task 링크는 해당 Task 상세로 이동한다.
- 근거: P1524–1582,1217; P1524–1582; **필수 통과: M6-07**.
- 불일치: 없음.

### UAT-DESIGN-04 · UI-04-05, UI-04-06

- 전제: 소유권과호환/비호환drift.
- 동작/사건: 코드수정요청 또는계약반영선택.
- [ ] **UAT-DESIGN-04** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 원본/복제/동기화/허용지연을표시하고요청ID·실제메시지/Runnerjob을생성하며계약은결과커밋보고전resolved로만들지않고비호환변경은승인경로로보낸다.
  - b) 설계 버전별 변경 주체·시각·호환 깨짐 여부를 표시한다.
- 근거: P1584–1610,4831–4835; G449; plan contracts §2.3; P1594–1610; **필수 통과: M6-07**.
- 불일치: MM-06.

### UAT-CI-01 · UI-08, UI-08-01, UI-08-01A

- 전제: main/Task/PR실행기록과실패단계.
- 동작/사건: 단계필터·실행선택·이전다음·펼치기.
- [ ] **UAT-CI-01** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) main 요약/배지와 커밋·Task·시도·PR·GitHub 상태가 실제 보고와 일치한다.
  - b) 필터·선택·이전/다음·펼침은 해당 실행을 가리킨다.
  - c) 단계별 시간·실패 로그·근거 위치를 표시한다.
  - d) 미실행 단계는 건너뜀으로 표시한다.
- 근거: P1405–1449; **필수 통과: M7-05**.
- 불일치: 없음.

### UAT-CI-02 · UI-08-01A, UI-08-02

- 전제: 검증PASS인PR과통합실패.
- 동작/사건: 실패후다시실행하고Runner가다시실패/성공각각보고.
- [ ] **UAT-CI-02** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 새CI ID와실제결과를기록하고실패면미병합·자동재작업/한도초과조치를표시하며통과와예상head병합확인없이병합됨/정상으로바꾸지않는다.
  - b) 실패한 실행 기록에만 다시 실행을 제공하고 성공/진행 중 기록에는 제공하지 않는다.
- 근거: P4729–4745; G475,491; owner Q-04; P1405–1448; **필수 통과: M7-06**.
- 불일치: MM-07.

### UAT-CI-03 · UI-08-02

- 전제: 검증대기/통합확인중/실패/병합됨PR.
- 동작/사건: 대기열과직렬통합진행확인.
- [ ] **UAT-CI-03** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 실제대상Task/PR·상태·시각이보이고통합확인은한번에하나며실패원인Task재작업요청이실제시도/메시지로추적된다.
- 근거: P1452–1455; G475–491; **필수 통과: M7-05**.
- 불일치: MM-07.

### UAT-CI-04 · UI-08-01A, UI-08-04

- 전제: Agent가prototype/또는.agentwbs/변경.
- 동작/사건: ①Task검사실행.
- [ ] **UAT-CI-04** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 첫보호검사에서변경경로·거부사유를남기고뒤단계/QA로넘기지않으며실패로그가Agent에전달된다.
- 근거: P4746–4754; G474,1039; **필수 통과: M7-05**.
- 불일치: 없음.

### UAT-CI-05 · UI-08-03, UI-08-01A

- 전제: 정상서비스와포트충돌환경각각.
- 동작/사건: 배포확인요청.
- [ ] **UAT-CI-05** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 실제운영빌드/기동/health/브라우저접속을수행하고URL·단계·스크린샷·결과를새기록으로남기며실패때이전정상배포를유지하고원인/알림을표시한다.
  - b) 최근 배포의 실제 시각·결과를 표시하고 상세 링크는 해당 CI 실행을 연다.
- 근거: P1458–1464; G477; P1458–1464; **필수 통과: M7-05**.
- 불일치: 없음.

### UAT-CI-06 · UI-08-04, UI-08-05

- 전제: 고정main파이프라인과불안정테스트.
- 동작/사건: 정의조회·격리/해제후검사실행.
- [ ] **UAT-CI-06** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 4단계·조건·기준커밋·야간/재시도/서비스설정을표시하고격리상태를영속저장하며격리테스트실패는결과를남기되통과를막지않고해제뒤다시판정에포함한다.
  - b) 불안정 테스트의 담당 Task 링크는 해당 Task 상세를 연다.
- 근거: P1465–1481; G479–485; P1477–1481; **필수 통과: M7-05**.
- 불일치: 없음.

### UAT-REPORT-01 · UI-11

- 전제: Asia/Seoul 고정시각, 서버정지기간 존재.
- 동작/사건: 일간07시·월요일07시·서버재시작사건.
- [ ] **UAT-REPORT-01** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 전날/지난주보고서를누락없이중복없이생성하고누락보충표시·종류필터·목록/문서를표시하며사용자Mock정기생성버튼이없다.
- 근거: P2089–2122; G363–377; **필수 통과: M6-01**.
- 불일치: 없음.

### UAT-REPORT-02 · UI-11A

- 전제: 고정시각2026-11-05 20:00KST.
- 동작/사건: 빈날짜/역전/미래/94일·93일경계, 이번주/지난주/최근30일선택.
- [ ] **UAT-REPORT-02** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 잘못된기간은구체사유로거부하고이번주는11-02~11-05·지난주는10-26~11-01·최근30일은10-07~11-05를채우며선택보기의custom보고서를생성한다.
- 근거: P6381–6382,4991–4998; **필수 통과: M6-01**.
- 불일치: 없음.

### UAT-REPORT-03 · UI-11, UI-11B, UI-11C

- 전제: 보고서스냅샷생성후Task/일정변경.
- 동작/사건: int/ext전환·보고서재조회.
- [ ] **UAT-REPORT-03** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 같은스냅샷의숫자가일치하고생성후스냅샷을수정하지않으며재조정횟수와현재예상을별도표시하고보고용에Task ID/시도/모델/Effort/토큰/RP내부용어가없다.
  - b) 팀장용 보고서의 Task 링크는 해당 Task의 현재 WBS 상세로 이동하며 보고서 스냅샷은 유지한다.
- 근거: P2132–2242; G371–396; P2141–2226; **필수 통과: M6-01**.
- 불일치: 없음.

### UAT-REPORT-04 · UI-11B

- 전제: plan milestones §4.0의12섹션값/빈상태fixture.
- 동작/사건: 팀장용문서와PDF열기.
- [ ] **UAT-REPORT-04** [E2E+PDF검사] 아래 기대를 모두 만족한다.
  - a) 12섹션의필수필드·미충족Gate·다음작업·명령→결과·전체Task모든열을문서안에서판단할수있고값없음에도안내를보인다.
- 근거: P2141–2226; G381–392; plan milestones §4.0; **필수 통과: M6-02**.
- 불일치: 없음.

### UAT-REPORT-05 · UI-11D, UI-11B, UI-11C

- 전제: 보고서선택, 정상/실패PDF변환fixture.
- 동작/사건: PDF다운로드.
- [ ] **UAT-REPORT-05** [API+E2E+PDF검사] 아래 기대를 모두 만족한다.
  - a) 서버가동일HTML로A4/14mm·폰트포함·부록새페이지PDF를생성하고잘못된좌표오프셋/내용잘림이없으며실패시본문은유지하고재시도/기간분리안내를보인다; iframe인쇄창만으로합격하지않는다.
- 근거: P5000–5012; G410; review B3; **필수 통과: M6-02**.
- 불일치: MM-31.

### UAT-REPORT-06 · UI-11D

- 전제: 브라우저인쇄미리보기와보고서.
- 동작/사건: Ctrl+P 또는브라우저인쇄미리보기열기.
- [ ] **UAT-REPORT-06** [수동+시각] 아래 기대를 모두 만족한다.
  - a) 본문이출력가능영역좌상단을기준으로시작하고메뉴180px/헤더64px오프셋을남기지않으며전체열과페이지분할을확인한다.
- 근거: P532–538,594; review B3; **필수 통과: M8-01**.
- 불일치: MM-31.

### UAT-MAIL-01 · UI-12-04, UI-12-04A

- 전제: 수신자없음/있음.
- 동작/사건: 잘못된주소·대소문자중복·구독0개추가, 유효추가·구독/보기/PDF/중지/삭제.
- [ ] **UAT-MAIL-01** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 오류를구분하고하나이상구독으로만추가되며둘다끄면중지, 저장뒤재조회에반영하고삭제해도발송기록을보존한다.
- 근거: P2511–2541,4933–4948; **필수 통과: M6-03**.
- 불일치: 없음.

### UAT-MAIL-02 · UI-12-04B

- 전제: SMTP미설정/정상/실패.
- 동작/사건: host/port/from오류저장·정상저장·연결확인.
- [ ] **UAT-MAIL-02** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 필수/포트1~65535/주소를검증하고비밀번호를재노출하지않으며실제연결결과535실패·조치/배지/알림과복구를보이고Mock인증실패버튼은없다.
- 근거: P2542–2566; **필수 통과: M6-03**.
- 불일치: 없음.

### UAT-MAIL-03 · UI-11D, MOD-03, MOD-04

- 전제: 일간/주간/기간보고서·활성수신자.
- 동작/사건: 미리보기와메일로보내기.
- [ ] **UAT-MAIL-03** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 미리보기HTML/제목/수신자/첨부가실발송과일치하고종류별활성구독자기본선택·0명거부·일간int고정·주간/기간보기선택을제공한다.
  - b) 보고서의 발송 기록을 펼쳐 해당 보고서의 수신자/결과를 조회하고 수신자가 없으면 수신자 설정 링크로 이동한다.
  - c) 미리보기 iframe의 sandbox로 스크립트 실행을 막는다.
  - d) 해당 모달도 STATE-10의 포커스 이동/순환·Esc·복원·유일 제목 규칙을 통과한다.
- 근거: P2725–2761; P2131–2133,2725–2761; G405; **필수 통과: M6-03**.
- 불일치: 없음.

### UAT-MAIL-04 · MOD-03, UI-12-04C

- 전제: fake SMTP가실제수신가능.
- 동작/사건: 테스트·수동·정기발송후본문/대체텍스트/첨부확인.
- [ ] **UAT-MAIL-04** [API+SMTP+E2E] 아래 기대를 모두 만족한다.
  - a) 640px table/inline요약본문·text/plain·선택PDF를실제수신하고스크립트/외부이미지가없으며보고용내부용어제거·공용주소링크정책이맞고발송근거ID가남는다.
- 근거: P4003–4034; G1049–1052; **필수 통과: M6-03**.
- 불일치: 없음.

### UAT-MAIL-05 · UI-12-04C, UI-11D, UI-01

- 전제: SMTP가명시적실패응답.
- 동작/사건: 보고서발송후15분경과·수동재발송.
- [ ] **UAT-MAIL-05** [API+SMTP+E2E] 아래 기대를 모두 만족한다.
  - a) 15분뒤1회실제자동재시도하고계속실패면미해결배지/알림을유지하며성공뒤해제, 행별/전체재전송은같은스냅샷·새발송기록이고삭제된수신자는재발송거부한다.
- 근거: P4036–4054,4967–4987; G407; **필수 통과: M6-03**.
- 불일치: MM-16.

### UAT-MAIL-06 · UI-12-04C

- 전제: SMTP수락직후워커중단.
- 동작/사건: 서버재시작.
- [ ] **UAT-MAIL-06** [API+SMTP+E2E] 아래 기대를 모두 만족한다.
  - a) 수락여부미확정상태를표시하고자동재발송하지않으며정기보고서생성은실패시키지않는다.
- 근거: plan contracts §4.4, milestones M6-03; **필수 통과: M6-03**.
- 불일치: 없음.

### UAT-TG-01 · UI-12-05, UI-12-05A

- 전제: 전용시험토큰·대화와fake BotAPI.
- 동작/사건: 토큰→봇확인→대상→테스트→켜기→저장.
- [ ] **UAT-TG-01** [API+BotAPI+E2E] 아래 기대를 모두 만족한다.
  - a) 실제요청결과로만검증상태를갱신하고테스트성공전켜기거부,저장뒤끝4자리만표시하며사용자에게가상토큰/Mock응답컨트롤을요구하지않는다.
- 근거: P2582–2607; G499–565; **필수 통과: M6-04**.
- 불일치: 없음.

### UAT-TG-02 · UI-12-05A

- 전제: 저장토큰과테스트성공.
- 동작/사건: 토큰/ChatID/이름변경·빈교체·마스킹값저장·변경/교체취소.
- [ ] **UAT-TG-02** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 토큰/ChatID변경은테스트초기화·이름만변경은유지,전화번호/@이름거부·음수ID허용,빈/마스킹교체거부,취소는원래등록설정으로복귀한다.
- 근거: P6553–6592; **필수 통과: M6-04**.
- 불일치: 없음.

### UAT-TG-03 · UI-12-05A, UI-12-05B, UI-12-05C, SYS-02

- 전제: 연결·규칙·접속주소각각저장전수정.
- 동작/사건: 각저장에500/네트워크/400주입 후수정·재시도.
- [ ] **UAT-TG-03** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 세폼모두저장값미반영·초안유지·적절한오류조치를제공하고성공응답후에만초안을닫는다.
- 근거: P5044,6581–6588; G70; **필수 통과: M6-04**.
- 불일치: MM-03.

### UAT-TG-04 · MOD-02, UI-12-05A

- 전제: 봇에개인·그룹업데이트, 빈결과, webhook사용각각.
- 동작/사건: 최근대화조회·후보선택·이대화선택.
- [ ] **UAT-TG-04** [API+BotAPI+E2E] 아래 기대를 모두 만족한다.
  - a) 후보name/type/ID를표시하되자동선택/저장하지않고입력만채우며빈결과재시도와Webhook직접입력안내를제공하고Webhook을해제하지않는다.
  - b) 해당 모달도 STATE-10의 포커스 이동/순환·Esc·복원·유일 제목 규칙을 통과한다.
- 근거: P2705–2724,6593–6597; **필수 통과: M6-04**.
- 불일치: 없음.

### UAT-TG-05 · UI-12-05B, UI-12-05D, UI-01

- 전제: done/fail규칙켜짐·서버상태전이fixture.
- 동작/사건: ①/QA/②/병합사건과동일종류프로세스실패를한도전후로발생.
- [ ] **UAT-TG-05** [API+BotAPI+E2E] 아래 기대를 모두 만족한다.
  - a) done은Gate+②+병합후만,프로세스fail은자동재시도2회소진뒤만발송하고QAFAIL은확정시발송하며실제근거없이통과/병합/한도초과문구를보내지않는다.
- 근거: P3957–3961; G508–517; owner Q-04; **필수 통과: M7-06**.
- 불일치: MM-02.

### UAT-TG-06 · UI-12-05B, UI-12-05D

- 전제: 규칙6종·Task/CP/CI/준비/GitHub/입력/기술결정사건.
- 동작/사건: 규칙저장/취소·업무전이·규칙꺼짐전이·긴제목발생.
- [ ] **UAT-TG-06** [API+BotAPI+E2E] 아래 기대를 모두 만족한다.
  - a) 규칙대로현재프로젝트알림만일반텍스트로발송하고꺼진이벤트를나중에몰아보내지않으며확정사실/미확정원인을구분하고대상이름절단후4096자이하·비밀미포함을보장한다.
  - b) 꺼진 이벤트의 미리보기에는 발송되지 않는다는 경고를 표시한다.
- 근거: P2608–2620,3922–3991; G540,1075; P2617; **필수 통과: M6-04**.
- 불일치: MM-13.

### UAT-TG-07 · UI-12-05B, UI-12-05D

- 전제: PR-A/PR-B각각같은단계실패키.
- 동작/사건: 같은원인반복·PR-A만성공·PR-B다시실패·PR-B해소후재발.
- [ ] **UAT-TG-07** [API+BotAPI+E2E] 아래 기대를 모두 만족한다.
  - a) 반복은dup만늘리고A성공은B키를해소하지않으며B해소뒤재발만새알림으로기록한다.
- 근거: P3988–3991; G523; **필수 통과: M6-04**.
- 불일치: MM-14.

### UAT-TG-08 · UI-12-05A, UI-12-05D

- 전제: 401/400/403/통신실패/429 retry_after각각.
- 동작/사건: 봇확인·테스트·업무발송.
- [ ] **UAT-TG-08** [API+BotAPI+E2E] 아래 기대를 모두 만족한다.
  - a) 오류별상태/원인/이력·배지를보이고401/400/403은자동재시도하지않으며429는실제retry_after대기후재시도·테스트최종상태도일치하고Task/Agent실행은불변이다.
- 근거: P3659–3662,6571–6590; G1071; **필수 통과: M6-04**.
- 불일치: MM-15.

### UAT-TG-09 · UI-12-05C, UI-12-05D, MOD-03

- 전제: 공용접속주소빈값/localhost/LAN주소.
- 동작/사건: 주소저장·메일/Telegram미리보기·이력행WBS에서확인.
- [ ] **UAT-TG-09** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 빈값링크생략·localhost경고·유효주소공통적용이며이력선택은Task/CP/CI/설정/프로젝트/설계의올바른URL로이동하고수락을읽음/도착으로표시하지않는다.
  - b) 전송 이력은 전체/업무/테스트로 필터하고 행을 펼치면 실제 발송한 메시지를 표시한다.
- 근거: P2621–2645,6601–6604; P2639–2640; **필수 통과: M7-05**.
- 불일치: 없음.

### UAT-APPROVE-01 · UI-03E, UI-03-02, UI-03-08

- 전제: 명세 완료 planning Task, 팀장/승인권한 없는 요청.
- 동작/사건: 착수 승인 요청 후 승인/반려를 각각 실행.
- [ ] **UAT-APPROVE-01** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 명세 미완료면 요청을 거부하고 완료면 approval로 전이한다.
  - b) 팀장 승인은 ready, 반려는 planning으로 돌아간다.
  - c) 권한 없는 승인은 거부하고 각 요청/승인/반려의 주체·시각·사유를 이력에 보존한다.
  - d) 착수 승인만으로 실행/완료하지 않는다.
- 근거: owner Q-02/Q-05 #2·#3; plan a60216d contracts §2.1 approve/reject; M3-03; **필수 통과: M3-03**.
- 불일치: 없음.

### UAT-EXEC-09 · UI-06, UI-06D, UI-03-06

- 전제: 같은 host에서 M2 API·fake Runner, 실행 중 Task와 물리 보유 해제 전/후 보고.
- 동작/사건: 중단 후 재개 버튼을 누르고 보유 해제 보고 뒤 재개.
- [ ] **UAT-EXEC-09** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 기존 시도는 interrupted로 보존하고 Task는 paused로 표시한다.
  - b) 보유 미해제면 재개를 거부하고 사유를 표시한다.
  - c) 해제 확인 뒤 재개는 같은 단계·같은 등급의 새 시도를 만들고 중단 횟수는 재시도/재작업에 가산하지 않는다.
- 근거: owner Q-05 #10; plan a60216d contracts §2.1 runs/resume·§3.4·§4.3; **필수 통과: M3-06**.
- 불일치: 없음.

### UAT-EXEC-09-RUNNER · UI-06, UI-12-01C

- 전제: 같은 host에서 실제 Runner·fake CLI 프로세스 그룹, 실행 중 Task.
- 동작/사건: Runner 중단/재연결 후 물리 그룹 종료를 확인하고 재개.
- [ ] **UAT-EXEC-09-RUNNER** [API+Runner+E2E] 아래 기대를 모두 만족한다.
  - a) 기존 중단 시도와 paused를 보존한다.
  - b) 실제 보유 미해제면409 CLAIM_REJECTED를 표시한다.
  - c) 그룹 종료/해제 확인 후에만 같은 단계·같은 등급의 새 시도를 실제 시작한다.
- 근거: plan a60216d contracts §3.4·§4.3; M5-03/M5-05; **필수 통과: M5-05**.
- 불일치: 없음.

### UAT-PROJECT-UI · UI-02A, UI-02B, UI-02C, UI-02E

- 전제: M2 API·fake Runner의 접근/분석/입력변경 보고 fixture.
- 동작/사건: 등록·제약 수정·단계 실패/재시도·입력 변경 분석 UI 조작.
- [ ] **UAT-PROJECT-UI** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 접근 결과와 main 커밋·필수 경로·제약·판단 근거/대안을 표시한다.
  - b) wait/run/done/fail·끊김 보고와 로그/원인/조치를 표시하고 보고 없는 시간 경과로 성공하지 않는다.
  - c) 재시도는 실패 단계 요청, 등록 취소는 초기화 확인으로 연결한다.
  - d) uiux/docs 변경·src 제외·새md/삭제·확인시각과 선택 입력버전을 표시한다.
- 근거: P712–786,2000–2018; G217–250; plan M3-04; **필수 통과: M3-04**.
- 불일치: MM-04, MM-23, MM-27, MM-30.

### UAT-RESET-UI · MOD-05, UI-02A, UI-02B

- 전제: M2 API·fake Runner offline와 이전 epoch 보고 fixture.
- 동작/사건: 초기화 후 등록 화면/정리 대기 확인 및 새 분석 시도.
- [ ] **UAT-RESET-UI** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 서버 초기화 응답 뒤 등록 전 화면과 정리 대기를 표시한다.
  - b) 정리 결과 전 분석을 막고 옛 epoch 보고의409를 표시한다.
  - c) 실제 Git 원격 정리 성공을 이 항목으로 인정하지 않는다.
- 근거: P4708–4724; plan M3-04/M4-01; **필수 통과: M3-04**.
- 불일치: 없음.

### UAT-PLAN-UI · UI-05, UI-05-01

- 전제: M2 API·fake Planning의 일치/이견/시뮬레이션 실패 보고.
- 동작/사건: 분석 비교·이견 조정·CP 생성.
- [ ] **UAT-PLAN-UI** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 독립 분석·근거·Diff를 나란히 표시한다.
  - b) 미조정/실패 상태는 CP 생성을 막는다.
  - c) 조정 결과와 동일 Diff를 제출하고 대기/자동반영은 API 결과를 따른다.
- 근거: P1614–1683; plan M3-05; **필수 통과: M3-05**.
- 불일치: 없음.

### UAT-EXEC-UI · UI-06, UI-06A, UI-06B, UI-06C, UI-06D

- 전제: M2 API·fake Runner, ready/running/rework/qa/verifying/gate·실패 보고 fixture.
- 동작/사건: 첫 시작·결과/검증 조회·재시도/재작업·보류/재개 화면 조작.
- [ ] **UAT-EXEC-UI** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 왼쪽 Task/시도 목록·중앙 다음 작업/결과/기록·오른쪽 연결 메시지의3영역과 개발→QA→재작업→재검증→Gate→완료의6단계·현재 단계/다음 작업과 실제 등급/근거를 표시한다.
  - b) 첫 시작 요청 없이 실행하지 않고 API 보류 사유를 표시한다.
  - c) 실패 사유 필수/failed,①전 QA 차단·PASS/FAIL/BLOCKED·명령/결과/Evidence를 표시한다.
  - d) contracts §3.5의 자동/수동 예외·카운터·최상위 반복 알림을 보고값대로 표시한다.
  - e) fake 흐름은 Gate 대기에서 멈추고 실제 프로세스/CI/병합 성공을 판정하지 않는다.
- 근거: P1747–1848,5806–5920; owner Q-04/Q-05; plan M3-06; **필수 통과: M3-06**.
- 불일치: MM-07.

### UAT-MSG-UI · UI-03-09, UI-06E

- 전제: M2 API·fake Runner, liveInject 미지원의 running/qa/verifying 및 offline 보고.
- 동작/사건: 전송·Queued 취소·실패 후 재전송·ack/응답 조회.
- [ ] **UAT-MSG-UI** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 세 실행 상태 모두 다음 실행 대기로 보인다.
  - b) 취소는 전달 대상에서 제거하고 실패 원인/재전송·ack와 업무 응답을 구분한다.
  - c) 실제 CLI 전달 성공 판정은 MSG-02/03에서 한다.
- 근거: P1351–1395,5413–5431; G355; plan M3-06; **필수 통과: M3-06**.
- 불일치: MM-08.

### UAT-RUNNER-UI · UI-00, UI-12-01, UI-12-01B, UI-12-01C, UI-12-01D, UI-12-01E

- 전제: M2 API·fake Runner의 heartbeat/readiness/usage/PC변경/보유/CLI버전 fixture.
- 동작/사건: 각 보고를 갱신하고 상한·예산을 저장.
- [ ] **UAT-RUNNER-UI** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 헤더/설정 연결 상태와 readiness 결과·조치·배지/알림이 일치한다.
  - b) 가동률·중단 시도·재연결·남은 사용량/리셋을 표시하고 유령 슬롯행은 없다.
  - c) 상한 권장/초과 경고·자원/변경 이력을 표시한다.
  - d) CLI 미검증은 보수 계산·재검증 안내이며 최신 유지·고정/하향 버튼 없음이다.
  - e) 예산 변경 응답에 따라 보유 계산·합계를 갱신하되 관측 미확인 세션 수는 줄이지 않고 물리 해제 확정 전 슬롯을 반환하지 않는다.
- 근거: P2276–2393; plan M3-08/D-23/D-26; G§12-26; **필수 통과: M3-08**.
- 불일치: MM-24.

### UAT-GITHUB-UI · UI-12-01A

- 전제: M2 API·fake GitHub의 정상·권한 누락·인증 만료 응답.
- 동작/사건: 인증 설정/재확인.
- [ ] **UAT-GITHUB-UI** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 형식 오류를 거부한다.
  - b) 권한4종·누락/복구·배지/알림·입력작업 보류를 API 결과와 일치시키고 토큰을 재노출하지 않는다.
  - c) 실제 GitHub adapter 검증은 GITHUB-01에서 한다.
- 근거: P2260–2274,4804–4812; plan M3-08; **필수 통과: M3-08**.
- 불일치: MM-12.

### UAT-POLICY-UI · UI-12-02B, UI-03-01A, UI-03-06

- 전제: M2 API·fake 정의/설치 보고, 지정 하위 Agent 있음.
- 동작/사건: 전체 끄기·개별 허용 해제·지시문/참고 링크 펼침.
- [ ] **UAT-POLICY-UI** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 정의/지시문/버전/hash·지정/실제 사용을 표시한다.
  - b) 전체 끄기는 지정 유지·기본 Agent 실행과 미사용 주의를 표시하고 개별 해제는 재판단 결과를 표시한다.
  - c) 설치 실패는 원인/재시도를 표시하고 새 실행을 시작하지 않는다.
  - d) 실제 정의 설치·CLI 사용 판정은 POLICY-02에서 한다.
- 근거: P1081,2435–2450; plan M3-08/D-24; **필수 통과: M3-08**.
- 불일치: 없음.

### UAT-STATE-02-UI · SYS-01, UI-03

- 전제: M2 API, 이미 로드한 WBS 목록.
- 동작/사건: 필터/정렬 API 응답을 지연한 뒤 응답.
- [ ] **UAT-STATE-02-UI** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 이전 목록과 상단 진행막대를 유지하고 성공 응답 뒤 새 조건의 데이터로 교체한다.
- 근거: G79–83; plan M3-01; **필수 통과: M3-02**.
- 불일치: 없음.

### UAT-SHELL-04-UI · UI-00, UI-03, UI-06

- 전제: M3 fake Runner 화면 fixture, 1280/1920px.
- 동작/사건: 셸·WBS·실행 화면 및 제품 모달 열기.
- [ ] **UAT-SHELL-04-UI** [시각+수동] 아래 기대를 모두 만족한다.
  - a) 메뉴180/56px·헤더64px·Pretendard GOV·상태 색+텍스트·각 모달 폭·20/24px 페이지 패딩을 재현한다.
  - b) 본문12px 이상·페이지 가로 넘침 없음·필수 열 접근을 확인한다.
  - c) 전체 제품 시각 인수는 SHELL-04에서 한다.
- 근거: P14–644; G1206–1207; plan M0-04/M3-06; **필수 통과: M3-06**.
- 불일치: MM-28, MM-29.

### UAT-RESP-01-UI · UI-00, UI-03B, UI-09A

- 전제: 1024/768px WBS/CP 표, M3 API fixture.
- 동작/사건: 헤더/도구막대와 오른쪽 열 탐색.
- [ ] **UAT-RESP-01-UI** [E2E+시각] 아래 기대를 모두 만족한다.
  - a) viewport meta가 실제 기기 폭과 일치한다.
  - b) 페이지/도구막대는 비의도 넘침이 없고1280 미만 표는 영역 내 가로 스크롤로 모든 열을 읽는다.
  - c) overflow:hidden으로 자르지 않는다.
- 근거: plan a60216d D-28/M3-01/M3-02/M3-05; **필수 통과: M3-05**.
- 불일치: MM-29.

### UAT-RESP-02-UI · UI-09A

- 전제: 390px휴대폰·유효인증·CP 직접 상세 URL.
- 동작/사건: CP 링크를 직접 열고 로그인 복귀.
- [ ] **UAT-RESP-02-UI** [E2E+시각] 아래 기대를 모두 만족한다.
  - a) 지정 CP 상세의 핵심 필드·상태·Diff·근거 링크를 잘림 없이 읽는다.
  - b) 휴대폰 편집/승인/전체 목록 기능을 필수화하지 않는다.
  - c) Telegram 발송 링크/CI는 RESP-02의 후속 통합 판정이다.
- 근거: plan a60216d D-28/M3-03/M3-05; **필수 통과: M3-05**.
- 불일치: MM-29.

### UAT-EMPTY-01 · UI-03-01, UI-03-03, UI-03-06, UI-03-07, UI-03-08, UI-03-09, UI-03-05

- 전제: 초기 승인 직후 실행/의존/검증/이력/메시지/체크 없음.
- 동작/사건: Task9탭 열기.
- [ ] **UAT-EMPTY-01** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 탭은 계속 탐색 가능하고 해당 목록의 기록 없음·등급 실행 기록 없음 문구를 표시한다.
  - b) 값 없는 수치/시도를 만들어 표시하지 않으며 데이터 생성 조건/진입 동작은 acceptance-coverage의 화면별 표와 일치한다.
- 근거: P1193–1208,1287,1307,1322,1343,1355; G37,86,1083; **필수 통과: M3-03**.
- 불일치: 없음.

### UAT-EMPTY-02 · UI-05, UI-05-01, UI-05-02, UI-09

- 전제: 초기 승인 직후 세션/재조정/CP 없음.
- 동작/사건: Planning/변경 제안 열기.
- [ ] **UAT-EMPTY-02** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 세션/재조정/CP가 없는 각 영역은 비어 있음과 생기는 조건을 안내하고 제안 선택/변경 행을 허위 생성하지 않는다.
- 근거: P1638,1671,1692–1703; G37,86; **필수 통과: M3-05**.
- 불일치: 없음.

### UAT-EMPTY-03 · UI-06, UI-06D, UI-06E

- 전제: 선택 Task 실행 시도·체크·연결 메시지 없음.
- 동작/사건: 실행 화면 열기.
- [ ] **UAT-EMPTY-03** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 실행 시도 없음·체크리스트 없음·연결 메시지 없음 문구를 각 영역에 표시하고 새 실행 조건/메시지 진입을 안내하며 존재하지 않는 시도를 선택하지 않는다.
- 근거: P1793,1840–1845; G86; **필수 통과: M3-06**.
- 불일치: 없음.

### UAT-EMPTY-04 · UI-07-01, UI-07-01A, UI-07-02, UI-10, UI-01

- 전제: 검증/Evidence/이력/최근결과/등급시도 없음.
- 동작/사건: 검증·Evidence·이력·대시보드 열기.
- [ ] **UAT-EMPTY-04** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 기록 없음·연결 Evidence 없음·체크 없음·등급 시도 없음의 각 안내를 해당 영역에 표시하고 생기는 조건을 안내한다.
  - b) 검증 결과/이력 기존 데이터가 있을 때 무매칭 필터를 선택하면 조건 불일치 안내로 바뀌고 필터 초기화로 원래 행을 복원한다.
- 근거: P1889–1896,1915,1935–1954,1988; G37,86; **필수 통과: M3-07**.
- 불일치: 없음.

### UAT-EMPTY-05 · UI-08-01, UI-08-02, UI-08-05

- 전제: CI 실행·병합 대기열·불안정 테스트 없음.
- 동작/사건: CI 각 탭 열기 후 존재하는 실행에 무매칭 필터 적용/초기화.
- [ ] **UAT-EMPTY-05** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 기록 없는 화면은 실행/대기열/불안정 테스트 없음 및 생기는 조건을 표시한다.
  - b) 실행은 있으나 필터만 불일치하면 조건 불일치로 구분하고 초기화 뒤 행이 돌아온다.
- 근거: P1410–1418,1454,1478; G37,86; **필수 통과: M7-05**.
- 불일치: 없음.

### UAT-EMPTY-06 · UI-11, UI-11B, UI-11C

- 전제: 보고서 없음·보고서 내 기간 데이터 없음·다른 종류 보고서만 있음.
- 동작/사건: 보고서 화면/종류 필터와 빈 섹션 열기.
- [ ] **UAT-EMPTY-06** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 보고서 자체 없음은 정기/기간 생성 조건을 안내하고 종류 무매칭은 해당 종류 보고서 없음으로 구분한다.
  - b) 기간의 완료/진행/시도/재조정/중단/메시지/예정 각 섹션도 빈 안내를 표시한다.
- 근거: P2109,2122,2144–2241; G37,86; **필수 통과: M6-01**.
- 불일치: 없음.

### UAT-EMPTY-07 · UI-12-04C, UI-11D

- 전제: 메일 발송 기록 없음.
- 동작/사건: 설정/보고서 발송 기록 열기.
- [ ] **UAT-EMPTY-07** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 발송 기록 없음과 보고서 생성 후 구독자별 발송 기록이 남는 조건을 표시하고 가짜 성공 로그를 만들지 않는다.
- 근거: P2572,2133; G86,405; **필수 통과: M6-03**.
- 불일치: 없음.

### UAT-EMPTY-08 · UI-12-05D

- 전제: 전송 이력 없음 또는 업무 기록만 있음.
- 동작/사건: 전체/테스트 필터와 초기화.
- [ ] **UAT-EMPTY-08** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 이력 없음은 연결 설정/테스트 전송 조건을 안내하고 실제 기록은 있으나 선택 종류가 없으면 조건 불일치로 구분하며 전체 선택 시 기록을 복원한다.
- 근거: P2631–2640; G86; **필수 통과: M6-04**.
- 불일치: 없음.

### UAT-EMPTY-09 · UI-04-03, UI-04-04, UI-04-05, UI-04-06

- 전제: 인터페이스/저장소/소유권/불일치 없음과 검색 무매칭 fixture.
- 동작/사건: 설계 탭 검색·필터·초기화.
- [ ] **UAT-EMPTY-09** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 정의/불일치 없음과 검색/필터 조건 불일치를 구분해 표시하고 생성 조건을 안내한다.
  - b) 초기화는 검색어도 지워 기존 행을 복원한다.
- 근거: P1524–1610,4857–4932; G86; **필수 통과: M6-07**.
- 불일치: 없음.

### UAT-EMPTY-10 · UI-03, UI-03B

- 전제: Task 없는 목록과 Task는 있으나 무매칭 조건.
- 동작/사건: 검색/필터·초기화.
- [ ] **UAT-EMPTY-10** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 기록 없음과 조건에 맞는 Task 없음을 구분하고 검색/필터 초기화로 기존 행을 복원하며 새 Task 생성 진입을 제공한다.
- 근거: P809,895; G86; **필수 통과: M3-02**.
- 불일치: 없음.

### UAT-RESP-02-TASK · UI-03E

- 전제: 390px휴대폰·유효인증·Task 직접 상세 URL.
- 동작/사건: Task 링크 열기와 로그인 복귀.
- [ ] **UAT-RESP-02-TASK** [E2E+시각] 아래 기대를 모두 만족한다.
  - a) 지정 Task 상세의 핵심 필드·상태·실패 사유·근거 링크를 잘림 없이 읽고 휴대폰 편집/승인을 필수로 요구하지 않는다.
- 근거: plan a60216d D-28/M3-03; **필수 통과: M3-03**.
- 불일치: MM-29.

### UAT-EMPTY-11 · UI-12-01C, UI-12-01D, UI-12-02A, UI-12-03A, UI-12-03C

- 전제: 세션/중단/조절/고정/분할위반/불가일 기록 없음.
- 동작/사건: Runner·Agent·일정 설정 열기.
- [ ] **UAT-EMPTY-11** [API+E2E] 아래 기대를 모두 만족한다.
  - a) 각 영역은 기록 없음/충돌 대기 없음·생기는 조건을 안내하고 임의 세션이나 경고를 만들지 않는다.
- 근거: P2301,2349–2355,2389,2430,2471,2487; G37,86; **필수 통과: M3-08**.
- 불일치: 없음.

### UAT-TASK-10-CI · UI-03-06, UI-08-01A

- 전제: CI 참조가 있는 Task 실행 시도.
- 동작/사건: Task 실행 탭의 CI 참조 선택.
- [ ] **UAT-TASK-10-CI** [E2E] 아래 기대를 모두 만족한다.
  - a) 참조한 CI 실행의 상세로 이동하고 CI ID·Task·시도 연결이 선택한 기록과 일치한다.
- 근거: P1303–1324,1405–1449; plan a60216d M3-03/M7-05; **필수 통과: M7-05**.
- 불일치: 없음.

## 불일치 → 판정 항목

| 불일치 | 판정 ID |
|---|---|
| MM-01 | UAT-GATE-01, UAT-GATE-02 |
| MM-02 | UAT-TG-05 |
| MM-03 | UAT-STATE-06, UAT-TG-03 |
| MM-04 | UAT-PROJECT-08, UAT-PROJECT-UI |
| MM-05 | UAT-WIZ-02 |
| MM-06 | UAT-DESIGN-04 |
| MM-07 | UAT-EXEC-06, UAT-CI-02, UAT-CI-03, UAT-EXEC-UI |
| MM-08 | UAT-MSG-02, UAT-MSG-UI |
| MM-09 | UAT-TASK-06 |
| MM-10 | UAT-PROJECT-10 |
| MM-11 | UAT-EXEC-03 |
| MM-12 | UAT-PROJECT-02, UAT-GITHUB-01, UAT-GITHUB-UI |
| MM-13 | UAT-TG-06 |
| MM-14 | UAT-TG-07 |
| MM-15 | UAT-TG-08 |
| MM-16 | UAT-MAIL-05 |
| MM-17 | UAT-STATE-01, UAT-STATE-04, UAT-STATE-05 |
| MM-18 | UAT-HISTORY-01 |
| MM-19 | UAT-RESET-01, UAT-RESET-02, UAT-RESET-03 |
| MM-20 | UAT-STATE-08 |
| MM-21 | UAT-SHELL-01, UAT-POLICY-05 |
| MM-22 | UAT-SHELL-02 |
| MM-23 | UAT-PROJECT-01, UAT-PROJECT-05, UAT-RESET-01, UAT-PROJECT-UI |
| MM-24 | UAT-RUNNER-03, UAT-POLICY-04, UAT-RUNNER-UI |
| MM-25 | UAT-WBS-04 |
| MM-26 | UAT-SHELL-05 |
| MM-27 | UAT-PROJECT-01, UAT-PROJECT-02, UAT-PROJECT-04, UAT-PROJECT-06, UAT-PROJECT-08, UAT-PROJECT-UI |
| MM-28 | UAT-SHELL-04, UAT-SHELL-04-UI |
| MM-29 | UAT-SHELL-01, UAT-SHELL-04, UAT-RESP-01, UAT-RESP-02, UAT-STATE-10, UAT-TASK-11, UAT-SHELL-04-UI, UAT-RESP-01-UI, UAT-RESP-02-UI, UAT-RESP-02-TASK |
| MM-30 | UAT-STATE-06, UAT-STATE-07, UAT-PROJECT-02, UAT-PROJECT-05, UAT-POLICY-05, UAT-PROJECT-UI |
| MM-31 | UAT-REPORT-05, UAT-REPORT-06 |
