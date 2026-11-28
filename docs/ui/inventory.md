# Agent WBS 프로토타입 UI 인벤토리

> 처음 읽는다면 [README.md](README.md)의 ID 읽는 법과 용어집을 먼저 본다.
> 인벤토리(inventory)는 "있는 것을 빠짐없이 적은 목록"이다. 이 문서는 프로토타입의 화면·버튼·조건을 빠짐없이 적는다.

## 조사 범위

- 조사일: 2026-11-25.
- 범위: `prototype/uiux/Main.dc.html` 1–7121 전체.
  - CSS 14–644
  - 템플릿 646–2902
  - 로직 2904–7118
- 같은 폴더의 README와 런타임/폰트 의존성도 보았다.
- `prototype/docs/Agent-WBS-설계의도-및-구현가이드.md` 1–1210도 보았다.

제품 구현 코드는 작성하지 않았다.
조사 시점에 이 worktree에는 `agent-wbs/`, `agent-runner/` 구현 디렉토리가 아직 없었다.
이 문서는 구현 완료 상태 보고가 아니라 **구현 목표와 검증 대상을 식별한 기준**이다.

## 화면 ID 붙이는 규칙

화면 ID는 이 문서에서 부여한 안정 식별자(이름이 바뀌어도 그대로 유지하는 이름표)다.

- `UI-01`~`UI-12`: 실제 12개 메뉴.
- `UI-02A/B`: 프로젝트 메뉴를 대신하는 등록/초기분석 화면.
- `UI-13`: 현재 정상 메뉴에서는 도달하지 않는 대체화면.
- 하위 번호: 탭·패널·편집기.
- `MOD-*`: 모달.
- `SYS-*`: 공통 상태.

모달은 재사용 컨테이너 기준으로 8개다.
Task 상세의 구조화 편집기는 인라인 영역(화면 안에 펼쳐지는 영역)이므로 모달에 중복 집계하지 않았다.
공용 확인 모달의 제목별 용도는 [아래 보충](#공용-확인창의-모든-용도)에 따로 적었다.

## 읽는 순서

화면 ID → 상태/필드/액션 결과 → 발생별 `EV-*` → 조건 `CD-*` 및 반복 `LP-*` 순서로 읽는다.

- `EV-*`: 이벤트(버튼 클릭 등)가 템플릿에 나오는 위치 하나.
- `CD-*`: 조건 분기(`sc-if`) 하나.
- `LP-*`: 반복(`sc-for`) 하나.

실제 제품의 URL은 가이드의 구현 요구일 뿐이다.
원본은 단일 HTML 내부 `nav/sel/tab` 메모리 상태를 쓴다.
그래서 추정 URL을 원본 진입 경로로 적지 않았다.

## 브라우저 확인에 대해

저자의 최초 Orca 브라우저 확인은 **불가능했다**.

- 로컬 정적 서버를 띄우고 Orca `tab create --headless --url http://127.0.0.1:18765/Main.dc.html`을 호출했다.
- `desktop_browser_bridge_unavailable`로 거부됐다.
- 그래서 저자는 그 실행에서 실제 렌더·클릭·인쇄를 확인하지 못했다.

이후 Claude 독립 리뷰가 Playwright(브라우저 자동 조작 도구)로 14화면·31탭·8모달 등을 확인했다.
제공된 스크린샷/결과 JSON을 이 개정에서 검토했다.

- 범위·미확인 항목과 파일 대응은 [screenshots.md](screenshots.md)에 구분했다.
- 정확한 오류는 [브라우저 증거](evidence/browser.md)에 있다.
- Node VM 메모리 로직 검사(원본 JavaScript를 Node 가상 환경에서 돌린 검사)는 브라우저 검증과 구분한다.

## 이 문서와 제품 기준의 관계

제품 판정 우선순위: owner 결정 → 계획 기준선 a60216d → 가이드 → 원본.

- 이 문서의 생성 영역은 원본 관측이다. 제품의 기대 동작은 acceptance.md를 따른다.
- [불일치](mismatches.md)는 원본과 다른 인수 기대를 명시한다.
- Mock 버튼과 상태 주입 UI는 제품 구현 대상 업무기능에 포함하지 않는다.
- 다만 그 버튼으로 드러나는 **결과 화면과 오류 상태**는 구현 대상이다.
  - 예: "오류 주입" 버튼 자체는 만들지 않지만, 그 버튼으로 볼 수 있던 저장 실패 화면은 제품에서 실제 오류가 났을 때 보여야 한다.

## 재현·증거

```sh
node docs/ui/probe.mjs
python3 docs/ui/extract.py
python3 docs/ui/extract.py --check
```

- [catalog.tsv](catalog.tsv): 사람이 분류한 화면 ID/범위/상태/필드/결과의 정본. 범위를 바꾸면 문서를 재생성한다.
- [template-audit.json](evidence/template-audit.json): 모든 이벤트·조건·반복·필드·인라인 스타일·아이콘·로직 색인.
  - 각 이벤트에 상위 `sc-if`, 반복 별칭, disabled 속성, 바인딩 후보 줄을 보존했다.
- [data-model.json](evidence/data-model.json): 실제 샘플 필드·열거값·로직 조사 결과. 실제 외부 시스템 연결은 없다.
  - `probe.mjs`가 이 파일을 다시 쓴다. 원본의 날짜 계산이 실행 시각에 따라 달라지므로, probe는 기존 증거를 만든 시각 2026-11-25 21:21 Asia/Seoul로 시계와 시간대를 고정한다. 두 번 연속 실행해도 같은 파일이 나온다.
- 자동 대조:
  - 정규식의 이벤트 개수와 HTMLParser 결과, 조건/반복 개수를 독립적으로 대조한다.
  - 모든 추출 ID가 본문에 있는지 assert(맞지 않으면 즉시 실패하는 검사)한다.
  - **미분류 개수와 문서 ID 누락 개수 모두 0**이다.
  - 후보 줄 색인은 이름 기반 검색이다. 컴파일러 수준의 함수 연결 증명은 아니다.

## 공통 상태와 권한 경계

모든 메뉴는 첫 로딩/실패/재시도를 공통으로 제공한다.
목록은 기록 없음과 필터 불일치를 구분한다(각 분기의 정확한 위치는 CD 표).

- 저장 500·네트워크·400 오류는 상단 막대로 보여 준다.
- 409(버전 충돌)는 충돌 모달로 보여 준다.
- 편집 내용은 실패 시 보존한다.

원본에는 실제 권한 관리 화면/로그인/사용자 전환이 없다.

- 제품에는 owner Q-01로 로그인 화면 1개(UI-AUTH)를 추가한다.
- 단일 팀장 가정이다.
- 등록 전 메뉴 잠금은 프로젝트 상태에 따른 잠금이다(권한 잠금이 아니다).
- API 스키마 예시의 팀장 세션/Runner 토큰은 백엔드의 경계이지 별도의 UI가 아니다.

## 공용 확인창의 모든 용도

`ask` 호출 위치를 전수 확인했다.
각 항목은 MOD-08을 재사용한다.
확인 전에 데이터가 바뀌면 안 된다. 사용자가 "취소"를 누를 수 있어야 하기 때문이다.

| 용도 | 원본 로직 | 확인 후 결과 |
|---|---|---|
| 편집 내용 버리기 | 5054 | 개요/명세/구조화 편집을 닫고 이동 |
| 선행 관계 삭제 | 5242–5245 | 의존성 삭제·차단 재계산·이력 |
| Task 완료 처리 | 5389–5397 | done·실제 완료시각·이력 (Gate/CI 결함은 불일치 참조) |
| DB 테이블/API Endpoint 삭제 | 5616–5624 | 해당 설계 엔티티 삭제·이력 |
| 기술 설계 섹션 제거 | 5628–5636 | 섹션과 그 내용 제거·이력 |
| Task 생성 취소 | 7104–7108 | Wizard 입력 폐기 |

## 정상 메뉴 이동의 연결

화면끼리 어디로 이동할 수 있는지 정리했다. 화살표 왼쪽 화면에서 오른쪽 화면들로 이동한다.

- 대시보드 → WBS 필터/Planning/실행/검증/Gate/메시지/설정 탭/설계/CI.
- 프로젝트 → 출처 버전 WBS/Phase WBS/Planning/CP/초기화.
- WBS → 선후행 Task(복귀 스택), 전체 설계(API·테이블), 작업 실행, CI.
- Planning → CP 및 이동 Task.
- 실행 → Task·검증·CI·메시지.
- 검증 → Task·실행·Evidence 소속 결과.
- CI → Task 및 실행 상세.
- 설계 → Task·REST↔PostgreSQL.
- 보고서/메일 → 생성 시점 내용과 현재 Task 상세(과거 링크가 없으면 404).
- Telegram 이력 → Task/CP/CI/Runner 설정/프로젝트/기술 결정.

외부 링크와 iframe 구성도 추출에 포함한다.

## 상태 미리보기의 모든 진입값

원본에는 화면 상태를 강제로 바꿔 보는 "미리보기" 도구가 있다.
진입은 설정 → 점검·Prototype → 화면 상태 미리보기다.
실제 제품에서는 이 도구 대신 동일한 데이터/Runner/API 상태를 만들어 확인한다.

- 일반 상태 목록은6648줄이다.
- 오류 목록은6649–6652줄이다.
- 실제 처리는 preview4600–4643줄이다.

| 키 | 상태 | 열리는 화면·전이 |
|---|---|---|
| active | 진행 중 프로젝트 | 기본 Mock 복원 → 대시보드 |
| none | 미등록 | 빈 등록 화면, 프로젝트·설정만 접근 |
| reg | 미등록·저장소 확인 완료 | 예시 등록 입력·확인 결과 |
| boot | 초기 분석 진행 | Claude 단계 일시정지 |
| techwait | 기술 결정 확정 대기 | 개별 승인/반려와 기술 결정 확정 |
| draft | WBS 초안 승인 대기 | 초안·분할점검·재분석·최초승인 |
| fresh | 승인 직후 기록 없음 | Task11, 실행/검증/메시지/CP/보고서0 → 대시보드 |
| cleanup | 초기화 후 정리 대기 | Runner offline·cleanup·초기화 이력 |
| offline | Runner 연결 끊김 | 활성 프로젝트 복원→실행중 시도 중단→작업 실행 |

| 키 | 오류·조건 | 표시 / 회복 동작 |
|---|---|---|
| e500 | 다음 저장 서버500 | 저장 미반영·입력유지·재시도/닫기 |
| net | 다음 저장 응답없음 | NETWORK_ERROR·재시도/닫기 |
| e400 | 다음 저장 서버검증400 | VALIDATION_FAILED·수정안내, 재시도 없음 |
| conflict | 다음 저장409 | 충돌 모달·내변경버림/재적용 |
| pdf | 다음 PDF 실패 | 보고서 이동·PDF 누를 때 오류·재시도 |
| loading | 응답지연 | 현재메뉴 skeleton6초 후 불러오기실패 |
| loaderr | 불러오기실패 | 현재메뉴503·마지막시각·재시도 |
| missing | 없는 Task | WBS TASK-0099·404·닫기 |
| subfail | 다음 하위Agent 설치실패 | 작업실행 이동·실행 요청 시 EACCES·시도 미생성·재시도 |
| notready | Runner준비실패 | Codex로그인만료·Runner설정·실행차단·대시보드알림 |
| cliver | CLI미검증 | Codex0.168.0·미검증·준비주의·보수계산 |
| obscut | 하위Agent관측끊김 | 실행세션미확인·보유·새실행보류·복구 버튼 |
| cifail | 통합확인실패 | 실패CI상세·PR#9병합보류·알림 |
| pathguard | 보호경로변경 | Task검사실패·변경경로로그·알림 |
| deployfail | 배포확인실패 | 배포탭·health check/포트오류·기록·알림 |
| ghauth | GitHub인증실패 | Runner설정·실패·입력확인중단·알림 |
| contractfail | 계약읽기실패 | 설계구성탭·파일실패·마지막성공버전·다시읽기 |
| mailfail | 메일발송실패 | SMTP535·보고서메일탭·발송실패기록·알림 |
| bootfail | 초기분석실패 | GitLFS checkout실패·조치안내·재시도/초기화 |
| infail | 차이분석실패 | 영향분석단계실패·완료단계유지·재시도 |
| tgblock | Telegram전송실패 | 알림탭·403·실패이력·배지·대시보드알림 |

위21개 버튼과 별도로 발생하는 오류도 있다.

- 등록 URL·필수구조·형식검증
- 의존성 순환
- DB/API 에디터 검증
- Telegram Mock 응답6종·찾기 empty/webhook 등

이것들은 각 화면 필드·조건 표에 포함했다.
따라서21은 오류상태 전체의 개수가 아니라 미리보기 버튼 개수다.

## 재현 시각·문구 정본과 owner 추가 화면

### 시각 비교의 기준 시각

시각 비교는 독립 리뷰의 desktop-clock20261105 자료를 우선 사용한다.
이 자료는 **2026-11-05 20:00:00 Asia/Seoul(UTC 11:00:00), 1920×1080**으로 시계를 고정했다.

- 왜 시각을 고정하나: nowStr(P3390)은 실제 시계를 쓴다. 실행일이 바뀌면 보고서 누락분·가동률·예상일·실행시간이 달라진다.
- desktop 모달/편집/오류 사진은 **2026-11-25 20:00 KST**다. 다른 날짜의 수치를 픽셀 기준으로 섞어 쓰지 않는다.
- 소스를 수정하지 않고 브라우저 시계를 페이지 로드 전에 고정하는 재현 예는 screenshots.md에 있다.

### 문구의 정본

각 화면의 **고정 라벨·필드명·빈 상태·안내 문구 정본은 아래 화면의 P 시작–끝 줄**이다.

- catalog 필드 요약은 문구 복사본이 아니다.
- 예: UI-03-01은1028–1129, UI-11B는2141–2226, UI-12-01D는2326–2393, UI-02A는703–748이다.
- 추출 EV 문구·필드 속성도 보조 색인이다. 모든 고정 문구를 대체하지 않는다.
- zip 안내·고정슬롯·Prototype UI 등 폐기 문구와 owner 추가/변경 문구는 mismatches/acceptance가 우선한다.

### UI-AUTH — 로그인(owner 추가 화면, 원본 줄 없음)

- 흐름: 미로그인 상태로 보호 화면에 가면 로그인으로 보낸다.
- 제공하는 것:
  - 날짜 PIN 6칸 입력(YYMMDD, 숫자 키패드·붙여넣기·자동 이동·백스페이스)
  - 로그인 실패/횟수제한
  - 이 PC 새1회용링크 발급 안내
  - 링크 소비 후 URL 토큰제거·성공복귀
- 원본 화면14개 집계에는 섞지 않고, 제품 추가1개로 별도 추적한다.
- 근거: owner Q-01·plan architecture §4/contracts §2.4·M3-01.

### 죽은 슬롯 행 EV-0314

추출 EV-0314(P2313)는 정상 제품 액션이 아니다.

- 반복 부모가 공급하지 않는 ag.run/ag.slotOpts에 연결된 **죽은 슬롯 행**이다. 제품에서 제거한다(MM-24).
- 이벤트 이름에 바인딩 후보가 있거나 화면 분류 누락0이라고 해서 실제 실행 가능함을 뜻하지 않는다.

### 원본 이벤트 밖의 요구

- 제품의 빈 상태/조건 불일치·발생 조건과 오류별 UAT는 [acceptance-coverage.md](acceptance-coverage.md)에 연결했다.
- 착수 승인·보유 해제 뒤 재개는 원본 이벤트 밖의 owner Q-02/Q-05 요구다. acceptance/data-needs에 명시하며 원본 이벤트 집계에 포함하지 않는다.

<!-- GENERATED: extract.py -->

## 집계와 대조

| 구분 | 개수 |
|---|---:|
| 인벤토리 항목 | 104 |
| 최상위 메뉴 | 12 |
| 이벤트 속성 발생 | 486 |
| 클릭 액션 발생 | 377 |
| 고유 핸들러 표현식 | 361 |
| sc-if 조건 발생 | 529 |
| sc-for 반복 발생 | 293 |
| 입력 요소 발생 | 109 |
| 분류 누락 | 0 |
| 인수 항목 | 149 |

종류별: 공통 1, 화면 14, 패널 34, 메뉴 1, 편집기 8, 탭 31, 대체화면 1, 공통상태 3, 모달 8, 단계 3.

집계를 읽을 때 주의할 점:

- 같은 반복 행의 실제 데이터 건수는 세지 않고 템플릿 발생 위치를 센다.
- `open/pick` 같은 반복 별칭은 화면·줄 번호·상위 조건·반복 문맥으로 구분한다.
- 분류 누락 0은 정적 추출(실행 없이 파일만 읽은 결과)의 문서 연결 결과이며, 브라우저 동작 검증 성공을 뜻하지 않는다.

## 화면·탭·패널·모달 인벤토리

### UI-00 — 앱 셸·전역 메뉴 (공통)

- 출처: [원본 646–673](../../prototype/uiux/Main.dc.html#L646); 로직 7053-7088.
- 진입: 최초 진입; 좌측 메뉴.
- 상태: 펼침/접힘; Runner 연결/끊김; 등록 전 잠금.
- 필드·표시 데이터: 프로젝트명; Runner; 사용자 팀장; NAV 12개.
- 액션·결과·이동: 햄버거로 메뉴 180px↔56px 전환 / 메뉴 선택 시 해당 화면과 선택 강조가 바뀜 / 등록/초기 승인 전에는 프로젝트와 설정만 접근됨 / Runner 버튼은 프로토타입 연결 상태를 전환함.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0001 | 651 | onclick {{toggleNav}} | Navigation 접기/펼치기 |  |
| EV-0002 | 658 | onclick {{toggleRunner}} | Runner {{runnerL}} MOCK |  |
| EV-0003 | 666 | onclick {{n.go}} | {{n.label}} {{n.phase}} |  |

### UI-01 — 대시보드 (화면)

- 출처: [원본 1858–1900](../../prototype/uiux/Main.dc.html#L1858); 로직 6274-6333.
- 진입: 메뉴 대시보드; 승인 직후; 상태 미리보기 active/fresh.
- 상태: 지표/패널 데이터 있음; 패널 빈 상태; 확인 알림 있음/없음.
- 필드·표시 데이터: 일정·진척 KPI; Task 지표; 행동 패널 6개; 유형/영역 분포; 실행 등급별 결과; 최근 8건.
- 액션·결과·이동: KPI와 행동 패널에서 해당 WBS 필터 또는 관련 화면으로 이동 / 유형/영역 분포 선택이 WBS 필터를 적용 / 실행 등급별 시도/판정/FAIL/재작업률/상향/토큰 표시 / 최근 실행·검증이 관련 상세로 이동.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0233 | 1863 | onclick {{k.go}} | {{k.l}} {{k.v}} {{k.sub}} | {{isDash}} |
| EV-0234 | 1865 | onclick {{al.open}} | 실행 보기 | {{isDash}} ∧ {{db.hasAlerts}} |
| EV-0235 | 1865 | onclick {{al.done}} | 확인 | {{isDash}} ∧ {{db.hasAlerts}} |
| EV-0236 | 1868 | onclick {{k.go}} | {{k.l}} {{k.v}} {{k.sub}} | {{isDash}} |
| EV-0237 | 1876 | onclick {{it.go}} | {{it.id}} {{it.t}} {{it.tag}} | {{isDash}} |
| EV-0238 | 1882 | onclick {{b.go}} | {{b.l}} {{b.en}} {{b.n}} | {{isDash}} |
| EV-0239 | 1885 | onclick {{b.go}} | {{b.l}} {{b.en}} {{b.n}} | {{isDash}} |
| EV-0240 | 1897 | onclick {{r.go}} | {{r.at}} {{r.kind}} {{r.id}} {{r.task}} {{r.t}} {{r.tag}} | {{isDash}} |

### UI-02 — 프로젝트 (화면)

- 출처: [원본 1993–2087](../../prototype/uiux/Main.dc.html#L1993); 로직 6461-6494.
- 진입: 메뉴 프로젝트; 초기화 후에는 UI-02A.
- 상태: 등록 active; GitHub 실패; 정보 읽기/편집.
- 필드·표시 데이터: 프로젝트 ID/이름/상태/시작/목표/책임자/설명; 기간·규모·작업량; Agent 참여; WBS 구조.
- 액션·결과·이동: 프로젝트 정보 편집 저장/취소 가능 / 이름/시작일/날짜 형식 검증 / 저장 후 정보 표시 갱신(명시적 이력·재조정 누락은 MM-10) / WBS 구조 행 선택이 Phase 필터로 이동 / Planning/CP 요약이 해당 메뉴로 이동.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0264 | 1995 | onclick {{inp.mockReg}} | Mock: 최초 등록 화면 보기 | {{isProject}} |
| EV-0272 | 2032 | onclick {{pj.edit}} | 편집 | {{isProject}} ∧ {{pj.reading}} |
| EV-0273 | 2052 | onchange {{pj.set.name}} | input | {{isProject}} ∧ {{pj.editing}} |
| EV-0274 | 2053 | onclick {{o.pick}} | {{o.l}} | {{isProject}} ∧ {{pj.editing}} |
| EV-0275 | 2054 | onchange {{pj.set.start}} | input | {{isProject}} ∧ {{pj.editing}} |
| EV-0276 | 2055 | onchange {{pj.set.target}} | input | {{isProject}} ∧ {{pj.editing}} |
| EV-0277 | 2057 | onchange {{pj.set.desc}} | textarea | {{isProject}} ∧ {{pj.editing}} |
| EV-0278 | 2058 | onclick {{pj.cancel}} | 취소 | {{isProject}} ∧ {{pj.editing}} |
| EV-0279 | 2058 | onclick {{pj.save}} | 저장 | {{isProject}} ∧ {{pj.editing}} ∧ disabled={{pj.invalid}} |
| EV-0280 | 2069 | onclick {{pj.goPls}} | 이견 조정이 필요한 Planning {{pj.plN}} | {{isProject}} |
| EV-0281 | 2070 | onclick {{pj.goCps}} | 승인 · 반영 대기 Change Proposal {{pj.cpN}} | {{isProject}} |
| EV-0282 | 2078 | onclick {{r.go}} | div | {{isProject}} |
| EV-0283 | 2078 | onclick {{r.go}} | {{r.title}} | {{isProject}} |
| EV-0284 | 2083 | onclick {{inp.reset}} | 프로젝트 초기화… | {{isProject}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 2052 | input | {{pj.ed.name}} | {} |
| 2054 | input | {{pj.ed.start}} | {} |
| 2055 | input | {{pj.ed.target}} | {} |
| 2057 | textarea | {{pj.ed.desc}} | {"rows": "3"} |

### UI-02A — 프로젝트 등록 (화면)

- 출처: [원본 703–748](../../prototype/uiux/Main.dc.html#L703); 로직 6894-6905.
- 진입: 미등록 상태; 초기화; 설정 미리보기 none/reg.
- 상태: 빈 입력; 저장소 확인 중/성공/실패; Runner 끊김; 정리 대기.
- 필드·표시 데이터: 이름*; GitHub URL*; 목표일; 기술 제약 name/lv/cond; 팀장 지시; 구조 표; md 목록; 초기화 기록.
- 액션·결과·이동: URL은 GitHub 저장소까지만 허용하고 tree/blob 주소 거부 / 이름과 성공한 저장소 확인 없이 등록 거부 / 기술 제약 추가/삭제와 필수·조건부 선호·금지 선택 가능 / 예시 값은 가상 등록 입력을 채움 / 접근 확인 결과에 main 커밋과 필수 경로 누락을 표시 / 등록하면 초기 분석으로 이동.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0008 | 707 | onclick {{su.mockBack}} | Mock: 원래 프로젝트로 돌아가기 | {{isSetup}} ∧ {{su.isNone}} |
| EV-0009 | 710 | onclick {{su.reg.sample}} | 예시 값 채우기 | {{isSetup}} ∧ {{su.isNone}} |
| EV-0010 | 712 | onchange {{su.reg.onName}} | 예: Verum-SDN Agent WBS — Self Development | {{isSetup}} ∧ {{su.isNone}} |
| EV-0011 | 713 | onchange {{su.reg.onUrl}} | https://github.com/owner/repo | {{isSetup}} ∧ {{su.isNone}} |
| EV-0012 | 714 | onclick {{su.reg.goGh}} | GitHub 연결 설정 | {{isSetup}} ∧ {{su.isNone}} |
| EV-0013 | 720 | onchange {{su.reg.onTarget}} | input | {{isSetup}} ∧ {{su.isNone}} |
| EV-0014 | 722 | onchange {{tc.onName}} | 기술 | {{isSetup}} ∧ {{su.isNone}} |
| EV-0015 | 722 | onclick {{o.pick}} | {{o.l}} | {{isSetup}} ∧ {{su.isNone}} |
| EV-0016 | 722 | onchange {{tc.onCond}} | 조건 | {{isSetup}} ∧ {{su.isNone}} ∧ {{tc.isCond}} |
| EV-0017 | 722 | onclick {{tc.del}} | 삭제 | {{isSetup}} ∧ {{su.isNone}} |
| EV-0018 | 723 | onclick {{su.reg.addTech}} | + 기술 제약 추가 | {{isSetup}} ∧ {{su.isNone}} |
| EV-0019 | 725 | onchange {{su.reg.onInstr}} | 예: prototype/uiux/ 와 prototype/docs/ 설계 문서를 분석하고 Task 식별을 시작하자. 보고서 화면은 나중에. | {{isSetup}} ∧ {{su.isNone}} |
| EV-0020 | 727 | onclick {{su.reg.check}} | {{su.reg.bCheck.l}} | {{isSetup}} ∧ {{su.isNone}} ∧ disabled={{su.reg.bCheck.dis}} |
| EV-0021 | 727 | onclick {{su.reg.submit}} | {{su.reg.bSubmit.l}} | {{isSetup}} ∧ {{su.isNone}} ∧ disabled={{su.reg.bSubmit.dis}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 712 | input | {{su.reg.name}} | {"placeholder": "예: Verum-SDN Agent WBS — Self Development"} |
| 713 | input | {{su.reg.url}} | {"placeholder": "https://github.com/owner/repo"} |
| 720 | input | {{su.reg.target}} | {"type": "date"} |
| 722 | input | {{tc.name}} | {"placeholder": "예: PostgreSQL 16", "aria-label": "기술"} |
| 722 | input | {{tc.cond}} | {"placeholder": "조건 — 예: 시계열 데이터가 있으면", "aria-label": "조건"} |
| 725 | textarea | {{su.reg.instr}} | {"rows": "3", "placeholder": "예: prototype/uiux/ 와 prototype/docs/ 설계 문서를 분석하고 Task 식별을 시작하자. 보고서 화면은 나중에."} |

### UI-02B — 초기 분석 진행 (화면)

- 출처: [원본 749–788](../../prototype/uiux/Main.dc.html#L749); 로직 4493-4535.
- 진입: 등록·초기 분석 시작; boot/bootfail 미리보기.
- 상태: 9단계 wait/run/done/fail; Runner 대기; 일시정지; 재시도.
- 필드·표시 데이터: PL-000; 입력 버전/커밋; Runner 보고; 팀장 지시; 단계/오류/조치.
- 액션·결과·이동: Mock 단계가 순서대로 진행하고 Runner 끊김·정리 대기에서 정지 / 단계 실패에 원인과 조치 및 재시도/등록 취소 제공 / 재시도는 실패 단계부터 진행 / 등록 취소가 초기화 확인으로 연결.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0022 | 750 | onclick {{su.boot.cancel}} | 등록 취소 (초기화) | {{isSetup}} ∧ {{su.isBoot}} |
| EV-0023 | 752 | onclick {{su.boot.retry}} | 다시 시도 | {{isSetup}} ∧ {{su.isBoot}} ∧ {{su.boot.fail}} |
| EV-0024 | 752 | onclick {{su.boot.cancel}} | 등록 취소 (초기화) | {{isSetup}} ∧ {{su.isBoot}} ∧ {{su.boot.fail}} |
| EV-0025 | 755 | onclick {{su.boot.pause}} | {{su.boot.pauseL}} | {{isSetup}} ∧ {{su.isBoot}} |

### UI-02C — 초기 기술 결정 확정 (패널)

- 출처: [원본 760–773](../../prototype/uiux/Main.dc.html#L760); 로직 4844-4856.
- 진입: 초기 분석 tech 단계; techwait 미리보기.
- 상태: 팀장 지정 확정; Agent 제안 pending/approved/rejected.
- 필드·표시 데이터: 결정 ID/제목/선택/권한/상태/조건/근거/대안.
- 액션·결과·이동: 각 Agent 제안을 승인 또는 반려 / 미결 제안이 있으면 기술 결정 확정 진행 거부 / 확정 후 WBS 초안 작성 진행.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0026 | 769 | onclick {{x.reject}} | 반려 | {{isSetup}} ∧ {{su.isBoot}} ∧ {{su.boot.hasTech}} ∧ {{x.canPick}} |
| EV-0027 | 769 | onclick {{x.approve}} | 승인 | {{isSetup}} ∧ {{su.isBoot}} ∧ {{su.boot.hasTech}} ∧ {{x.canPick}} |
| EV-0028 | 771 | onclick {{su.boot.techOk}} | 기술 결정 확정 | {{isSetup}} ∧ {{su.isBoot}} ∧ {{su.boot.hasTech}} ∧ {{su.boot.techWait}} |

### UI-02D — WBS 초안·최초 승인 (패널)

- 출처: [원본 774–786](../../prototype/uiux/Main.dc.html#L774); 로직 4536-4564.
- 진입: 초기 분석 draft/approve 단계; draft 미리보기.
- 상태: 초안 없음/있음; 분할 위반; 승인 대기/처리 중.
- 필드·표시 데이터: Phase/WP/Task 트리; 분류/작업량/선행; 분할 점검; 재분석 지시.
- 액션·결과·이동: 재분석은 Codex 분석부터 다시 진행하고 확정 기술 결정을 유지 / 최초 승인 시 Task 11건과 생성 이력 및 기준 일정 v1 생성 / 승인 후 WBS 첫 Task 개요로 이동.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0029 | 781 | onchange {{su.boot.onRe}} | 수정이 필요하면 적고 「재분석 요청」 — 예: 메시지 기능을 별도 Work Package로 분리해줘 | {{isSetup}} ∧ {{su.isBoot}} ∧ {{su.boot.hasDraft}} |
| EV-0030 | 782 | onclick {{su.boot.re}} | 재분석 요청 | {{isSetup}} ∧ {{su.isBoot}} ∧ {{su.boot.hasDraft}} |
| EV-0031 | 782 | onclick {{su.boot.approve}} | {{su.boot.bApprove.l}} | {{isSetup}} ∧ {{su.isBoot}} ∧ {{su.boot.hasDraft}} ∧ disabled={{su.boot.bApprove.dis}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 781 | textarea | {{su.boot.reInstr}} | {"rows": "2", "placeholder": "수정이 필요하면 적고 「재분석 요청」 — 예: 메시지 기능을 별도 Work Package로 분리해줘"} |

### UI-02E — 입력 변경·버전·차이 분석 (패널)

- 출처: [원본 1996–2029](../../prototype/uiux/Main.dc.html#L1996); 로직 4644-4693.
- 진입: 프로젝트 입력 자료; 입력 변경 알림; infail 미리보기.
- 상태: 변경 있음/없음; GitHub 실패; 분석 run/done/fail.
- 필드·표시 데이터: repo URL/branch/base; 입력 v/commit/md/changes/srcV; 감지 커밋·파일; 지시; 분석 단계/CP.
- 액션·결과·이동: 확인으로 감지 시각 갱신 / 분석 안 함은 skipped 기록을 남김 / 이 버전으로 분석은 커밋을 새 입력 버전으로 고정 / 차이 분석 완료 시 신규/수정 CP를 만들고 정책에 따라 반영 / 버전별 출처 Task 수 선택이 WBS로 이동 / 실패 단계 재시도와 CP 상세 이동 가능.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0265 | 1997 | onclick {{inp.mock}} | Mock: 새 커밋 push | {{isProject}} |
| EV-0266 | 1997 | onclick {{inp.fetch}} | {{inp.bFetch.l}} | {{isProject}} ∧ disabled={{inp.bFetch.dis}} |
| EV-0267 | 2012 | onchange {{inp.onInstr}} | 선택 — 예: 이미 완료된 화면은 재작업보다 수정 Task로 분리해줘 | {{isProject}} ∧ {{inp.hasPend}} |
| EV-0268 | 2013 | onclick {{inp.skip}} | 분석 안 함 | {{isProject}} ∧ {{inp.hasPend}} |
| EV-0269 | 2013 | onclick {{inp.analyze}} | {{inp.bAnalyze.l}} | {{isProject}} ∧ {{inp.hasPend}} ∧ disabled={{inp.bAnalyze.dis}} |
| EV-0270 | 2024 | onclick {{inp.job.openCp}} | {{inp.job.cp}} 보기 | {{isProject}} ∧ {{inp.job.has}} ∧ {{inp.job.hasCp}} |
| EV-0271 | 2025 | onclick {{inp.job.retry}} | 다시 시도 | {{isProject}} ∧ {{inp.job.has}} ∧ {{inp.job.fail}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 2012 | textarea | {{inp.instr2}} | {"rows": "2", "placeholder": "선택 — 예: 이미 완료된 화면은 재작업보다 수정 Task로 분리해줘"} |

### UI-03 — WBS 목록 (화면)

- 출처: [원본 791–1403](../../prototype/uiux/Main.dc.html#L791); 로직 6968-7088.
- 진입: 메뉴 WBS; 각 화면 Task 링크.
- 상태: 표/Gantt; 필터 결과 없음; Task 404; 상세 열림/닫힘.
- 필드·표시 데이터: 검색; 8개 select 필터; sort; Phase/WP/Task; 컬럼; 일정.
- 액션·결과·이동: 검색과 유형/영역/상태/Agent/우선순위/Phase/차단/검증 필터가 함께 적용 / 필터 결과에 상위 Phase/WP 유지 / 초기화가 검색과 필터 제거 / 정렬은 WP 내부에 적용 / Task 선택으로 레일+상세 전환.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0032 | 793 | onclick {{miss.close}} | 닫기 | {{isWbs}} ∧ {{miss.show}} |
| EV-0033 | 800 | onclick {{openWiz}} | Task 생성 | {{isWbs}} |
| EV-0037 | 813 | onchange {{onSearch}} | Task ID 또는 제목 검색 | {{isWbs}} |
| EV-0038 | 814 | onchange {{fset.type}} | 전체 분석 설계 구현 구성 테스트 검증 문서화 통합 | {{isWbs}} |
| EV-0039 | 815 | onchange {{fset.domain}} | 전체 FE BE DB DevOps API QA Architecture Common | {{isWbs}} |
| EV-0040 | 816 | onchange {{fset.status}} | 전체 진행 중 (실행~Gate 대기) 계획 중 승인 대기 실행 대기 실행 중 중단 · 재개 대기 QA 진행 재작업 필요 검증 진행 Gate 대기 완료 실패 취소됨 | {{isWbs}} |
| EV-0041 | 817 | onchange {{fset.agent}} | 전체 Claude Codex | {{isWbs}} |
| EV-0042 | 818 | onchange {{fset.priority}} | 전체 긴급 높음 보통 낮음 | {{isWbs}} |
| EV-0043 | 819 | onchange {{fset.phase}} | 전체 1 기반 구성 2 Core WBS 3 Workflow | {{isWbs}} |
| EV-0044 | 820 | onchange {{fset.blocked}} | 전체 차단됨 실행 가능 | {{isWbs}} |
| EV-0045 | 821 | onchange {{fset.verif}} | 전체 미실시 검증 중 PASS FAIL BLOCKED | {{isWbs}} |
| EV-0046 | 822 | onclick {{resetFilters}} | 필터 초기화 | {{isWbs}} ∧ disabled={{noFilter}} |
| EV-0047 | 825 | onclick {{o.pick}} | {{o.l}} | {{isWbs}} |
| EV-0048 | 826 | onchange {{onSort}} | WBS 번호 우선순위 상태 최근 변경 | {{isWbs}} |
| EV-0049 | 827 | onclick {{expandAll}} | 모두 펼치기 | {{isWbs}} |
| EV-0050 | 828 | onclick {{collapseAll}} | 모두 접기 | {{isWbs}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 813 | input | {{search}} | {"type": "search", "placeholder": "Task ID 또는 제목 검색"} |
| 814 | select | {{f.type}} | {} |
| 815 | select | {{f.domain}} | {} |
| 816 | select | {{f.status}} | {} |
| 817 | select | {{f.agent}} | {} |
| 818 | select | {{f.priority}} | {} |
| 819 | select | {{f.phase}} | {} |
| 820 | select | {{f.blocked}} | {} |
| 821 | select | {{f.verif}} | {} |
| 826 | select | {{sort}} | {} |

### UI-03A — WBS 컬럼 설정 (메뉴)

- 출처: [원본 829–838](../../prototype/uiux/Main.dc.html#L829); 로직 7078-7085.
- 진입: WBS 툴바 컬럼.
- 상태: 열림/닫힘; 체크됨/해제.
- 필드·표시 데이터: kind/agent/status/priority/preds/pct/plan/est/updated.
- 액션·결과·이동: WBS 번호와 제목은 항상 표시 / 선택한 컬럼만 표에 표시 / 기본 8개와 선택 최근 변경 컬럼을 원본 순서로 표시.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0051 | 829 | onclick {{toggleColMenu}} | 컬럼 | {{isWbs}} |
| EV-0052 | 834 | onchange {{co.toggle}} | input | {{isWbs}} ∧ {{colMenu}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 834 | input | {{co.on}} | {"type": "checkbox"} |

### UI-03B — Tree Table (패널)

- 출처: [원본 842–898](../../prototype/uiux/Main.dc.html#L842); 로직 5104-5174.
- 진입: WBS 보기 표.
- 상태: Phase/WP 펼침/접힘; 매칭 없음; 선행 차단.
- 필드·표시 데이터: WBS/제목; 분류/담당/상태·검증/우선순위/선행/진척/날짜범위/공수/수정시각.
- 액션·결과·이동: 그룹 캐럿은 선택과 분리해 펼침/접힘 / 모두 펼치기/접기 적용 / Task 행 클릭과 제목 버튼 선택이 상세를 열음 / 상태 텍스트와 색상을 함께 표시.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0053 | 862 | onclick {{r.toggle}} | {{r.toggleL}} | {{isWbs}} ∧ {{isTable}} ∧ {{r.isGroup}} |
| EV-0054 | 872 | onclick {{r.open}} | div | {{isWbs}} ∧ {{isTable}} ∧ {{r.isTask}} |
| EV-0055 | 875 | onclick {{r.open}} | {{r.title}} | {{isWbs}} ∧ {{isTable}} ∧ {{r.isTask}} |
| EV-0056 | 895 | onclick {{resetFilters}} | 필터 초기화 | {{isWbs}} ∧ {{isTable}} ∧ {{noRows}} |

### UI-03C — Gantt (패널)

- 출처: [원본 899–921](../../prototype/uiux/Main.dc.html#L899); 로직 6969-6980.
- 진입: WBS 보기 Gantt.
- 상태: 기준/실제/진행/미착수/낙관·비관; 작업불가일.
- 필드·표시 데이터: 전체 기간; 기준 막대; 예측 막대; 범위선; 현재선; 목표선.
- 액션·결과·이동: 전체 기간을 폭에 맞춤 / 기준 일정과 실제/예측 막대 구분 / 작업 불가일 빗금과 현재·목표선 표시 / Task 막대 선택이 해당 상세로 이동.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0057 | 908 | onclick {{r.toggle}} | {{r.toggleL}} | {{isWbs}} ∧ {{isGantt}} ∧ {{r.isGroup}} |
| EV-0058 | 913 | onclick {{r.open}} | div | {{isWbs}} ∧ {{isGantt}} ∧ {{r.isTask}} |
| EV-0059 | 914 | onclick {{r.open}} | {{r.title}} | {{isWbs}} ∧ {{isGantt}} ∧ {{r.isTask}} |

### UI-03D — Task 레일·상세 헤더 (패널)

- 출처: [원본 804–810](../../prototype/uiux/Main.dc.html#L804); 로직 5075-5103.
- 진입: WBS Task 선택; Task 링크.
- 상태: 목록 안/밖; 검색 결과 없음; 이전/다음 경계.
- 필드·표시 데이터: WP 구분; Task ID/상태/제목; 현재 위치.
- 액션·결과·이동: 상세 열면 260px 레일 표시 / 원래 목록 펼치기로 상세 닫힘 / 이전/다음이 필터·정렬된 레일 순서를 따름 / 링크로 연 Task가 필터 밖이면 목록 밖 표시 / Task 참조 이동 뒤 복귀 스택 동작.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0034 | 805 | onclick {{closeDetail}} | 펼치기 | {{isWbs}} |
| EV-0035 | 806 | oninput {{wr.onQ}} | ID · 제목 검색 | {{isWbs}} |
| EV-0036 | 808 | onclick {{w.pick}} | {{w.id}} {{w.stL}} {{w.title}} | {{isWbs}} ∧ {{w.isTask}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 806 | input | {{wr.q}} | {"type": "search", "placeholder": "ID · 제목 검색"} |

### UI-03E — Task 요약·Gate 펼침 (패널)

- 출처: [원본 924–977](../../prototype/uiux/Main.dc.html#L924); 로직 5204-5327.
- 진입: WBS 상세 공통 헤더.
- 상태: 선행 차단/해소; Gate 0~5/5; 완료/미완료.
- 필드·표시 데이터: Task/WBS/상위; 분류/Agent/검증/우선순위; 선행; 체크리스트; Gate; 일정/진척.
- 액션·결과·이동: 9개 탭과 각 건수 표시 / Gate 펼치면 5개 조건별 판정·사유 표시 / 하나라도 조건 미충족 시 완료 버튼 비활성 / 선행 차단 Task 참조 링크 제공.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0060 | 929 | onclick {{goBack}} | ← {{dt.backId}}로 돌아가기 | {{isWbs}} ∧ {{hasSel}} ∧ {{dt.hasBack}} |
| EV-0061 | 936 | onclick {{wr.prev}} | ↑ 이전 | {{isWbs}} ∧ {{hasSel}} ∧ disabled={{wr.noPrev}} |
| EV-0062 | 937 | onclick {{wr.next}} | ↓ 다음 | {{isWbs}} ∧ {{hasSel}} ∧ disabled={{wr.noNext}} |
| EV-0063 | 952 | onclick {{toggleGate}} | {{dt.gateL}} ▾ | {{isWbs}} ∧ {{hasSel}} |
| EV-0064 | 961 | onclick {{completeTask}} | Task 완료 처리 | {{isWbs}} ∧ {{hasSel}} ∧ {{gateOpen}} ∧ disabled={{dt.cannotComplete}} |
| EV-0065 | 966 | onclick {{b.open}} | {{b.id}} | {{isWbs}} ∧ {{hasSel}} ∧ {{dt.blocked}} |
| EV-0066 | 971 | onclick {{tb.pick}} | {{tb.label}} {{tb.count}} | {{isWbs}} ∧ {{hasSel}} |

### UI-03F — 구조화 명세·기술 설계 공용 편집기 (편집기)

- 출처: [원본 978–1025](../../prototype/uiux/Main.dc.html#L978); 로직 5432-5636.
- 진입: AC/산출물 편집; DB/API 항목·설계 블록 편집.
- 상태: 필드/행 오류; 테이블 빈 행; 읽기/편집.
- 필드·표시 데이터: DESIGN/COLSETS 스키마 필드; 텍스트/seg/check/select/code/table.
- 액션·결과·이동: 필수값·중복명·컬럼/인덱스/FK·API 오류·환경변수 규칙을 저장 전 검사 / 행 추가/삭제 가능 / 취소 시 원본 보존 / 저장 시 이력 전후 기록 / 편집 중 이동 시 버리기 확인.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0067 | 982 | onclick {{cancelEd}} | 취소 | {{isWbs}} ∧ {{hasSel}} ∧ {{edOpen}} |
| EV-0068 | 982 | onclick {{saveEd}} | 저장 | {{isWbs}} ∧ {{hasSel}} ∧ {{edOpen}} ∧ disabled={{ed.invalid}} |
| EV-0069 | 989 | onchange {{fd.set}} | {{fd.l}} | {{isWbs}} ∧ {{hasSel}} ∧ {{edOpen}} ∧ {{ed.hasFields}} ∧ {{fd.isText}} |
| EV-0070 | 990 | onclick {{o.pick}} | {{o.l}} | {{isWbs}} ∧ {{hasSel}} ∧ {{edOpen}} ∧ {{ed.hasFields}} ∧ {{fd.isSeg}} |
| EV-0071 | 1005 | onchange {{cl.set}} | {{cl.aria}} | {{isWbs}} ∧ {{hasSel}} ∧ {{edOpen}} ∧ {{bk.isTable}} ∧ {{cl.isText}} |
| EV-0072 | 1006 | onchange {{cl.set}} | {{cl.aria}} | {{isWbs}} ∧ {{hasSel}} ∧ {{edOpen}} ∧ {{bk.isTable}} ∧ {{cl.isCheck}} |
| EV-0073 | 1007 | onchange {{cl.set}} | BTREE UNIQUE GIN HASH | {{isWbs}} ∧ {{hasSel}} ∧ {{edOpen}} ∧ {{bk.isTable}} ∧ {{cl.sIdx}} |
| EV-0074 | 1008 | onchange {{cl.set}} | 코드 문서 Migration 테스트 설정 | {{isWbs}} ∧ {{hasSel}} ∧ {{edOpen}} ∧ {{bk.isTable}} ∧ {{cl.sOut}} |
| EV-0075 | 1009 | onchange {{cl.set}} | Loading Empty Error Success Disabled | {{isWbs}} ∧ {{hasSel}} ∧ {{edOpen}} ∧ {{bk.isTable}} ∧ {{cl.sState}} |
| EV-0076 | 1012 | onclick {{rw.del}} | {{rw.delL}} | {{isWbs}} ∧ {{hasSel}} ∧ {{edOpen}} ∧ {{bk.isTable}} |
| EV-0077 | 1017 | onclick {{bk.add}} | + {{bk.addL}} | {{isWbs}} ∧ {{hasSel}} ∧ {{edOpen}} ∧ {{bk.isTable}} |
| EV-0078 | 1019 | onchange {{bk.set}} | {{bk.title}} | {{isWbs}} ∧ {{hasSel}} ∧ {{edOpen}} ∧ {{bk.isLines}} |
| EV-0079 | 1020 | onchange {{bk.set}} | {{bk.title}} | {{isWbs}} ∧ {{hasSel}} ∧ {{edOpen}} ∧ {{bk.isCode}} |
| EV-0080 | 1023 | onclick {{cancelEd}} | 취소 | {{isWbs}} ∧ {{hasSel}} ∧ {{edOpen}} |
| EV-0081 | 1023 | onclick {{saveEd}} | 저장 | {{isWbs}} ∧ {{hasSel}} ∧ {{edOpen}} ∧ disabled={{ed.invalid}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 989 | input | {{fd.v}} | {"placeholder": "{{fd.ph}}", "aria-label": "{{fd.l}}"} |
| 1005 | input | {{cl.v}} | {"placeholder": "{{cl.ph}}", "aria-label": "{{cl.aria}}"} |
| 1006 | input | {{cl.on}} | {"type": "checkbox", "aria-label": "{{cl.aria}}"} |
| 1007 | select | {{cl.v}} | {"aria-label": "{{cl.aria}}"} |
| 1008 | select | {{cl.v}} | {"aria-label": "{{cl.aria}}"} |
| 1009 | select | {{cl.v}} | {"aria-label": "{{cl.aria}}"} |
| 1019 | textarea | {{bk.text}} | {"rows": "4", "aria-label": "{{bk.title}}"} |
| 1020 | textarea | {{bk.text}} | {"rows": "8", "aria-label": "{{bk.title}}"} |

### UI-03-01 — Task 개요 (탭)

- 출처: [원본 1028–1129](../../prototype/uiux/Main.dc.html#L1028); 로직 5362-5388.
- 진입: WBS 상세 개요.
- 상태: 읽기/편집; 필수 오류; 같은 Agent 경고; 추정 범위 오류.
- 필드·표시 데이터: 목적/배경/범위/제외/선행조건/완료조건; 낙관·예상·비관/토큰/고정시작일.
- 액션·결과·이동: 개요 편집은 해당 영역만 전환 / 제목·목적·완료조건 필수 / 0<시간≤400 및 낙관≤예상≤비관, 토큰 정수 검증 / 담당=검증 경고 / 저장/취소 후 읽기 복귀 / 범위와 제외 범위는 명세와 같은 데이터.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0082 | 1030 | onclick {{startOv}} | 개요 편집 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tOverview}} ∧ {{ovRead}} |
| EV-0091 | 1102 | onclick {{p.open}} | {{p.id}} {{p.title}} {{p.stL}} | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tOverview}} ∧ {{ovRead}} ∧ {{dt.hasPreds}} |
| EV-0092 | 1113 | onchange {{ovSet.title}} | input | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tOverview}} ∧ {{ovEditing}} |
| EV-0093 | 1114 | onchange {{ovSet.priority}} | 긴급 높음 보통 낮음 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tOverview}} ∧ {{ovEditing}} |
| EV-0094 | 1115 | onchange {{ovSet.assignee}} | Claude Codex | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tOverview}} ∧ {{ovEditing}} |
| EV-0095 | 1116 | onchange {{ovSet.verifier}} | Codex Claude | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tOverview}} ∧ {{ovEditing}} |
| EV-0096 | 1117 | onchange {{ovSet.lo}} | 낙관 실행 시간 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tOverview}} ∧ {{ovEditing}} |
| EV-0097 | 1117 | onchange {{ovSet.est}} | 예상 실행 시간 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tOverview}} ∧ {{ovEditing}} |
| EV-0098 | 1117 | onchange {{ovSet.hi}} | 비관 실행 시간 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tOverview}} ∧ {{ovEditing}} |
| EV-0099 | 1117 | onchange {{ovSet.tok}} | 예상 토큰 (K) | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tOverview}} ∧ {{ovEditing}} |
| EV-0100 | 1118 | onchange {{ovSet.fixStart}} | YYYY-MM-DD | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tOverview}} ∧ {{ovEditing}} |
| EV-0101 | 1119 | onchange {{ovSet.purpose}} | textarea | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tOverview}} ∧ {{ovEditing}} |
| EV-0102 | 1120 | onchange {{ovSet.background}} | textarea | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tOverview}} ∧ {{ovEditing}} |
| EV-0103 | 1121 | onchange {{ovSet.scope}} | textarea | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tOverview}} ∧ {{ovEditing}} |
| EV-0104 | 1122 | onchange {{ovSet.out}} | textarea | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tOverview}} ∧ {{ovEditing}} |
| EV-0105 | 1123 | onchange {{ovSet.precond}} | input | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tOverview}} ∧ {{ovEditing}} |
| EV-0106 | 1124 | onchange {{ovSet.doneCond}} | textarea | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tOverview}} ∧ {{ovEditing}} |
| EV-0107 | 1125 | onclick {{cancelOv}} | 취소 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tOverview}} ∧ {{ovEditing}} |
| EV-0108 | 1125 | onclick {{saveOv}} | 저장 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tOverview}} ∧ {{ovEditing}} ∧ disabled={{ovInvalid}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 1113 | input | {{ovd.title}} | {} |
| 1114 | select | {{ovd.priority}} | {} |
| 1115 | select | {{ovd.assignee}} | {} |
| 1116 | select | {{ovd.verifier}} | {} |
| 1117 | input | {{ovd.lo}} | {"aria-label": "낙관 실행 시간"} |
| 1117 | input | {{ovd.est}} | {"aria-label": "예상 실행 시간"} |
| 1117 | input | {{ovd.hi}} | {"aria-label": "비관 실행 시간"} |
| 1117 | input | {{ovd.tok}} | {"aria-label": "예상 토큰 (K)"} |
| 1118 | input | {{ovd.fixStart}} | {"placeholder": "YYYY-MM-DD"} |
| 1119 | textarea | {{ovd.purpose}} | {"rows": "3"} |
| 1120 | textarea | {{ovd.background}} | {"rows": "3"} |
| 1121 | textarea | {{ovd.scope}} | {"rows": "4"} |
| 1122 | textarea | {{ovd.out}} | {"rows": "3"} |
| 1123 | input | {{ovd.precond}} | {} |
| 1124 | textarea | {{ovd.doneCond}} | {"rows": "2"} |

### UI-03-01A — Task 실행 등급·하위 Agent (패널)

- 출처: [원본 1064–1085](../../prototype/uiux/Main.dc.html#L1064); 로직 6195-6223.
- 진입: Task 개요 실행 등급 변경·고정.
- 상태: 자동/팀장 고정; 최저선 경고; 기록 없음/있음.
- 필드·표시 데이터: 개발·검증 model/effort/locked/basis/by; 지정 subagent와 실제 시도.
- 액션·결과·이동: 개발/검증 등급을 따로 고정 가능 / 최저선 미달은 경고와 함께 표시 / 등급 저장 시 작업량 재추정·일정 재조정·이력 기록 / 고정 해제로 Planning 재판단 / 지정과 실제 사용·미사용을 구분.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0083 | 1068 | onclick {{rr.edit}} | 변경 · 고정 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tOverview}} ∧ {{ovRead}} ∧ {{rr.canEdit}} |
| EV-0084 | 1068 | onclick {{rr.unlock}} | 고정 해제 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tOverview}} ∧ {{ovRead}} ∧ {{rr.canUnlock}} |
| EV-0085 | 1072 | onclick {{o.pick}} | {{o.l}} | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tOverview}} ∧ {{ovRead}} ∧ {{rr.editing}} |
| EV-0086 | 1073 | onclick {{o.pick}} | {{o.l}} | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tOverview}} ∧ {{ovRead}} ∧ {{rr.editing}} |
| EV-0087 | 1075 | onclick {{rr.cancel}} | 취소 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tOverview}} ∧ {{ovRead}} ∧ {{rr.editing}} |
| EV-0088 | 1075 | onclick {{rr.save}} | 저장 · 고정 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tOverview}} ∧ {{ovRead}} ∧ {{rr.editing}} |

### UI-03-01B — 분할 근거·자동 점검 (패널)

- 출처: [원본 1086–1094](../../prototype/uiux/Main.dc.html#L1086); 로직 4565-4588.
- 진입: Task 개요 분할 근거·점검.
- 상태: 통과/의심/위반/주의/판단/예외/꺼짐; 시작 여부.
- 필드·표시 데이터: 근거/by; 규칙별 결과/detail/how; 예외.
- 액션·결과·이동: 미착수 위반 Task는 Planning 분할 CP 생성 가능 / 진행 Task는 분할 대신 예외 사유 기록 / 분할은 후속 선행 관계 재연결 후 원래 Task 취소.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0089 | 1090 | onclick {{x.exc}} | 예외 사유 기록 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tOverview}} ∧ {{ovRead}} ∧ {{x.canExc}} |
| EV-0090 | 1092 | onclick {{dt.run.split.split}} | Planning Agent 분할 제안 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tOverview}} ∧ {{ovRead}} ∧ {{dt.run.split.canSplit}} |

### UI-03-02 — Task 작업 명세 (탭)

- 출처: [원본 1131–1157](../../prototype/uiux/Main.dc.html#L1131); 로직 5204-5235.
- 진입: WBS 상세 작업 명세; 생성 직후.
- 상태: 섹션 미작성/읽기/편집; AC/산출물 없음.
- 필드·표시 데이터: 6그룹 13섹션; req/work/steps/inputs/outputs/files/constraints/errors/out/ac/verify/docs.
- 액션·결과·이동: 섹션별 읽기·편집·저장·취소 제공 / AC는 Given/When/Then/검증방법 표 / 산출물은 경로/유형/필수/검증조건/제출 표 / 메시지는 공식 명세를 자동 변경하지 않음.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0109 | 1140 | onclick {{sec.edit}} | 편집 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tSpec}} ∧ {{sec.canEdit}} |
| EV-0110 | 1149 | onchange {{onSpecText}} | textarea | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tSpec}} ∧ {{sec.editing}} |
| EV-0111 | 1150 | onclick {{cancelSpec}} | 취소 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tSpec}} ∧ {{sec.editing}} |
| EV-0112 | 1150 | onclick {{saveSpec}} | 저장 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tSpec}} ∧ {{sec.editing}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 1149 | textarea | {{specText}} | {"rows": "7"} |

### UI-03-03 — Task 의존성 (탭)

- 출처: [원본 1159–1211](../../prototype/uiux/Main.dc.html#L1159); 로직 5328-5341.
- 진입: WBS 상세 의존성.
- 상태: 선행/후속 없음; 차단/해소; 추가 검색; 자기참조/중복/순환 오류.
- 필드·표시 데이터: pred/succ/type FS·SS; 현재 상태/충족; 검색어/후보.
- 액션·결과·이동: FS는 선행 완료, SS는 선행 시작 기준으로 차단 계산 / 후보 선택 즉시 추가 검증 / 자기참조/중복/순환은 저장 거부하고 순환 경로 표시 / 삭제 확인 후 관계와 이력 갱신 / 참조 클릭·복귀 동작.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0113 | 1161 | onclick {{toggleDepAdd}} | {{depAddL}} | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tDeps}} |
| EV-0114 | 1168 | onclick {{o.pick}} | {{o.l}} | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tDeps}} ∧ {{depOpen}} |
| EV-0115 | 1169 | onchange {{onDepQ}} | 선행으로 추가할 Task ID 또는 제목 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tDeps}} ∧ {{depOpen}} |
| EV-0116 | 1174 | onclick {{cd.pick}} | {{cd.wbs}} {{cd.id}} {{cd.title}} (현재 Task) {{cd.stL}} | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tDeps}} ∧ {{depOpen}} |
| EV-0117 | 1185 | onclick {{p.open}} | {{p.id}} | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tDeps}} |
| EV-0118 | 1190 | onclick {{p.remove}} | 삭제 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tDeps}} |
| EV-0119 | 1201 | onclick {{p.open}} | {{p.id}} | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tDeps}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 1169 | input | {{depQ}} | {"type": "search", "placeholder": "선행으로 추가할 Task ID 또는 제목"} |

### UI-03-04 — Task 기술 설계 (탭)

- 출처: [원본 1213–1267](../../prototype/uiux/Main.dc.html#L1213); 로직 5453-5500.
- 진입: WBS 상세 기술 설계.
- 상태: 영역별 섹션 없음/있음; 항목 없음/미작성.
- 필드·표시 데이터: DB/API/FE/DevOps 섹션; ents/b; DB 관계 테이블.
- 액션·결과·이동: 주·관련 영역에 맞는 섹션만 기본 제공 / 섹션 추가와 제거 확인 / DB 테이블/API Endpoint 추가·편집·삭제 / FK로 관계 테이블 계산 / 비밀 환경변수는 읽기에서 가림 / 전체 설계 링크가 해당 항목으로 이동.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0120 | 1217 | onclick {{k.open}} | {{k.l}} | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tTech}} ∧ {{dt.hasDsLinks}} |
| EV-0121 | 1218 | onclick {{sa.pick}} | {{sa.l}} | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tTech}} ∧ {{dt.hasSecAdd}} |
| EV-0122 | 1224 | onclick {{sec.addEnt}} | + {{sec.addL}} | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tTech}} ∧ {{sec.hasEnt}} |
| EV-0123 | 1224 | onclick {{sec.remove}} | 섹션 제거 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tTech}} |
| EV-0124 | 1237 | onclick {{en.edit}} | 편집 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tTech}} |
| EV-0125 | 1238 | onclick {{en.del}} | 삭제 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tTech}} |
| EV-0126 | 1256 | onclick {{bk.edit}} | 편집 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tTech}} ∧ {{bk.canEdit}} |

### UI-03-05 — Task 체크리스트 (탭)

- 출처: [원본 1269–1301](../../prototype/uiux/Main.dc.html#L1269); 로직 5342-5353.
- 진입: WBS 상세 체크리스트.
- 상태: 등록 없음; 필수 미완료/모두 완료.
- 필드·표시 데이터: id/text/required/done/method/evidence/note.
- 액션·결과·이동: 체크 토글이 완료 수·진척과 Gate를 갱신하고 이력 기록 / 필수/선택을 골라 항목 추가 / 빈 내용 추가 비활성 / Evidence와 검증 방법 표시.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0127 | 1278 | onchange {{ci.toggle}} | {{ci.aria}} | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tChecklist}} |
| EV-0128 | 1293 | onchange {{onClText}} | 체크 내용 (필수) | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tChecklist}} |
| EV-0129 | 1295 | onchange {{onClMethod}} | 검증 방법 (선택) | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tChecklist}} |
| EV-0130 | 1296 | onclick {{o.pick}} | {{o.l}} | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tChecklist}} |
| EV-0131 | 1297 | onclick {{addCl}} | 추가 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tChecklist}} ∧ disabled={{clAddDisabled}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 1278 | input | {{ci.done}} | {"type": "checkbox", "aria-label": "{{ci.aria}}"} |
| 1293 | input | {{clText}} | {"placeholder": "체크 내용 (필수)"} |
| 1295 | input | {{clMethod}} | {"placeholder": "검증 방법 (선택)"} |

### UI-03-06 — Task 실행 이력 (탭)

- 출처: [원본 1303–1317](../../prototype/uiux/Main.dc.html#L1303); 로직 5204-5327.
- 진입: WBS 상세 실행.
- 상태: 시도 없음; 실행 중/완료/실패/중단.
- 필드·표시 데이터: Attempt; Agent/등급/상향/하위 Agent/CI/기간/요약/파일/실패.
- 액션·결과·이동: 새 시도는 이전 결과를 덮어쓰지 않음 / 지정·실제·미사용 구분 / Task 검사 링크는 해당 CI 상세로 이동 / 작업 실행 화면에서 진행 버튼은 해당 Task로 이동.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0132 | 1305 | onclick {{dt.openExec}} | 작업 실행 화면에서 진행 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tExec}} |
| EV-0133 | 1310 | onclick {{a.openCi}} | {{a.ciL}} | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tExec}} ∧ {{a.hasCi}} |

### UI-03-07 — Task 검증·Evidence (탭)

- 출처: [원본 1319–1336](../../prototype/uiux/Main.dc.html#L1319); 로직 5204-5327.
- 진입: WBS 상세 검증·Evidence.
- 상태: 결과 없음; PASS/FAIL/BLOCKED; 결함 없음/있음.
- 필드·표시 데이터: 검증 ID/시도/Agent/시각/명령/예상/실제/Evidence/결함.
- 액션·결과·이동: 검증 결과별 원래 실행 시도 연결 표시 / 명령·예상·실제·증거·결함 표시 / QA 결과 등록은 작업 실행에서 수행.

### UI-03-08 — Task 이력 (탭)

- 출처: [원본 1338–1349](../../prototype/uiux/Main.dc.html#L1338); 로직 5204-5327.
- 진입: WBS 상세 이력.
- 상태: 이력 없음/있음.
- 필드·표시 데이터: 시각/주체/유형/내용/전후.
- 액션·결과·이동: Task별 변경이 최신순으로 표시 / 전후 값과 주체를 함께 표시.

### UI-03-09 — Task 메시지 (탭)

- 출처: [원본 1351–1395](../../prototype/uiux/Main.dc.html#L1351); 로직 5399-5431.
- 진입: WBS 상세 메시지; 실행 메시지 링크.
- 상태: 없음; Draft/Queued/Sent/Acknowledged/Failed/Cancelled; 다음실행 대기; 새 응답.
- 필드·표시 데이터: 유형/대상Agent/시도/본문; 방향/시각/전달/작업상태.
- 액션·결과·이동: Task별 작성 초안 유지 / 빈 본문 전송 비활성 / 긴 메시지 펼치기/접기 / Runner 끊김은 실패와 재전송 표시 / 실행중 주입 미지원이면 다음 실행 대기 / Queued 전송 취소 / ack와 작업 완료를 구분 / 메시지에서 CP 작성 및 실행/검증 이동.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0134 | 1373 | onclick {{m.retry}} | 재전송 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tMsg}} ∧ {{m.failed}} |
| EV-0135 | 1376 | onclick {{m.toggle}} | {{m.toggleL}} | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tMsg}} ∧ {{m.isLong}} |
| EV-0136 | 1377 | onclick {{m.openExec}} | 실행 시도 열기 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tMsg}} ∧ {{m.hasAttempt}} |
| EV-0137 | 1377 | onclick {{m.openVerif}} | 관련 검증 열기 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tMsg}} ∧ {{m.hasAttempt}} |
| EV-0138 | 1378 | onclick {{m.makeCp}} | Change Proposal 작성 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tMsg}} |
| EV-0139 | 1379 | onclick {{m.cancel}} | 전송 취소 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tMsg}} ∧ {{m.canCancel}} |
| EV-0140 | 1385 | onclick {{o.pick}} | {{o.l}} | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tMsg}} |
| EV-0141 | 1386 | onclick {{o.pick}} | {{o.l}} | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tMsg}} |
| EV-0142 | 1387 | onclick {{o.pick}} | {{o.l}} | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tMsg}} |
| EV-0143 | 1389 | onchange {{md.onBody}} | 작업 지시를 입력하세요. &#96;&#96;&#96; 로 코드 블록, &#96;경로&#96; 로 파일 경로를 표시합니다. | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tMsg}} |
| EV-0144 | 1392 | onclick {{md.send}} | 전송 | {{isWbs}} ∧ {{hasSel}} ∧ {{edClosed}} ∧ {{dt.tMsg}} ∧ disabled={{md.cannotSend}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 1389 | textarea | {{md.body}} | {"rows": "6", "placeholder": "작업 지시를 입력하세요. &#96;&#96;&#96; 로 코드 블록, &#96;경로&#96; 로 파일 경로를 표시합니다."} |

### UI-04 — 설계 (화면)

- 출처: [원본 1483–1613](../../prototype/uiux/Main.dc.html#L1483); 로직 4857-4932.
- 진입: 메뉴 설계; Task 기술 설계 링크.
- 상태: 기술 결정 없음; 승인 대기; 계약 읽기 실패; 불일치.
- 필드·표시 데이터: 전체 버전/결정/대기/불일치 요약; 6탭.
- 액션·결과·이동: 승인대기·읽기실패 배너와 탭 배지 표시 / 각 탭 상태 전환 / 읽기 실패는 마지막 성공 버전 유지 안내와 다시 읽기 제공.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0162 | 1488 | onclick {{ds.parseFix}} | 다시 읽기 (Mock: 수정됨) | {{isDesign}} ∧ {{ds.has}} ∧ {{ds.hasParseErr}} |
| EV-0163 | 1489 | onclick {{ds.goPend}} | 기술 결정 보기 | {{isDesign}} ∧ {{ds.has}} ∧ {{ds.hasPend}} |
| EV-0164 | 1490 | onclick {{t.pick}} | {{t.l}} {{t.badge}} | {{isDesign}} ∧ {{ds.has}} |

### UI-04-01 — 구성도·계약 파일 (탭)

- 출처: [원본 1492–1508](../../prototype/uiux/Main.dc.html#L1492); 로직 4857-4932.
- 진입: 설계 첫 탭.
- 상태: 구성/계약 없음; 승인대기 점선; 반려 취소선; 파일 실패.
- 필드·표시 데이터: 계층별 구성요소/tech/note/decision; 연결; 계약 path/kind/fmt/commit/st.
- 액션·결과·이동: 구성요소의 권한·결정 상태 표현 / 계약 파일별 형식·기준 커밋·상태 표시 / Mock 읽기 실패가 배너·알림·파일 상태를 변경.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0165 | 1502 | onclick {{ds.parseBreak}} | Mock: 읽기 실패 | {{isDesign}} ∧ {{ds.has}} ∧ {{ds.tab.map}} |

### UI-04-02 — 기술 결정 (탭)

- 출처: [원본 1510–1522](../../prototype/uiux/Main.dc.html#L1510); 로직 4815-4830.
- 진입: 설계 기술 결정; 승인대기 배너.
- 상태: fixed/approved/pending/rejected/noted/chg.
- 필드·표시 데이터: id/area/title/choice/auth/lv/cond/reason/alts/by/at/chgTo.
- 액션·결과·이동: 권한 3단계별 묶음 / pending 승인/반려 시 버전 증가 / 변경 제안 전에는 기존 결정 유지 / 변경 반려 시 기존 결정 복구 / 팀장 지정 제약은 임의 변경 불가.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0166 | 1519 | onclick {{x.reject}} | 반려 | {{isDesign}} ∧ {{ds.has}} ∧ {{ds.tab.dec}} ∧ {{x.pending}} |
| EV-0167 | 1519 | onclick {{x.approve}} | 승인 | {{isDesign}} ∧ {{ds.has}} ∧ {{ds.tab.dec}} ∧ {{x.pending}} |
| EV-0168 | 1519 | onclick {{x.chgReq}} | 변경 제안 (Mock) | {{isDesign}} ∧ {{ds.has}} ∧ {{ds.tab.dec}} ∧ {{x.canChg}} |

### UI-04-03 — 인터페이스 목록·레일 (탭)

- 출처: [원본 1524–1541](../../prototype/uiux/Main.dc.html#L1524); 로직 4857-4932.
- 진입: 설계 인터페이스; 데이터 사용하는 API.
- 상태: 목록/상세; 검색 결과 없음; 방식별 필터.
- 필드·표시 데이터: REST/WebSocket/SSE/Kafka; key/name/description/status/task.
- 액션·결과·이동: 방식과 검색이 목록에 적용 / 행 클릭은 레일+상세 / 펼치기가 목록으로 복귀 / Task 링크는 WBS 상세.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0169 | 1526 | onclick {{o.pick}} | {{o.l}} | {{isDesign}} ∧ {{ds.has}} ∧ {{ds.listTab}} ∧ {{ds.listMode}} ∧ {{ds.tab.iface}} |
| EV-0170 | 1526 | onclick {{o.pick}} | {{o.l}} | {{isDesign}} ∧ {{ds.has}} ∧ {{ds.listTab}} ∧ {{ds.listMode}} ∧ {{ds.tab.data}} |
| EV-0171 | 1526 | oninput {{ds.onQ}} | 이름 · 설명 검색 | {{isDesign}} ∧ {{ds.has}} ∧ {{ds.listTab}} ∧ {{ds.listMode}} |
| EV-0172 | 1531 | onclick {{r.pick}} | div | {{isDesign}} ∧ {{ds.has}} ∧ {{ds.listTab}} ∧ {{ds.listMode}} |
| EV-0173 | 1538 | onclick {{ds.det.close}} | 펼치기 | {{isDesign}} ∧ {{ds.has}} ∧ {{ds.listTab}} ∧ {{ds.det.has}} |
| EV-0174 | 1539 | onclick {{r.pick}} | {{r.kind}} {{r.stL}} {{r.name}} | {{isDesign}} ∧ {{ds.has}} ∧ {{ds.listTab}} ∧ {{ds.det.has}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 1526 | input | {{ds.q}} | {"type": "search", "placeholder": "이름 · 설명 검색"} |

### UI-04-03A — 인터페이스 상세 (패널)

- 출처: [원본 1542–1567](../../prototype/uiux/Main.dc.html#L1542); 로직 4857-4932.
- 진입: 인터페이스 행; Task API 전체설계 링크.
- 상태: REST/메시지/Kafka 상세; 불일치; 앞뒤 경계.
- 필드·표시 데이터: auth/request/response/validation/errors/tables; 메시지 schema/dir; topic key/parts/retention/delivery/dlq/compat/consumers.
- 액션·결과·이동: REST 요청·응답·검증·오류·테이블 표시 / 테이블 클릭이 데이터 상세로 이동 / WebSocket/SSE 메시지 방향·스키마와 Kafka 전달 규칙 표시 / 이전/다음·목록 밖 표시.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0175 | 1543 | onclick {{ds.det.prev}} | ↑ 이전 | {{isDesign}} ∧ {{ds.has}} ∧ {{ds.listTab}} ∧ {{ds.det.has}} ∧ disabled={{ds.det.noPrev}} |
| EV-0176 | 1543 | onclick {{ds.det.next}} | ↓ 다음 | {{isDesign}} ∧ {{ds.has}} ∧ {{ds.listTab}} ∧ {{ds.det.has}} ∧ disabled={{ds.det.noNext}} |
| EV-0177 | 1548 | onclick {{ds.det.openTask}} | {{ds.det.task}} | {{isDesign}} ∧ {{ds.has}} ∧ {{ds.listTab}} ∧ {{ds.det.has}} ∧ {{ds.det.hasTask}} |
| EV-0178 | 1557 | onclick {{tb.open}} | {{tb.n}} | {{isDesign}} ∧ {{ds.has}} ∧ {{ds.listTab}} ∧ {{ds.det.has}} ∧ {{ds.det.isRest}} ∧ {{ds.det.hasTables}} |

### UI-04-04 — 데이터 목록·레일 (탭)

- 출처: [원본 1524–1541](../../prototype/uiux/Main.dc.html#L1524); 로직 4857-4932.
- 진입: 설계 데이터; REST 테이블 링크.
- 상태: pg/neo4j/questdb/redis; 목록/상세; 검색 없음.
- 필드·표시 데이터: 저장소 선택; 종류/이름/설명/상태/Task.
- 액션·결과·이동: 저장소 선택과 검색이 해당 항목만 표시 / 행 선택이 레일+상세 / 펼치기로 목록 복귀.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0169 | 1526 | onclick {{o.pick}} | {{o.l}} | {{isDesign}} ∧ {{ds.has}} ∧ {{ds.listTab}} ∧ {{ds.listMode}} ∧ {{ds.tab.iface}} |
| EV-0170 | 1526 | onclick {{o.pick}} | {{o.l}} | {{isDesign}} ∧ {{ds.has}} ∧ {{ds.listTab}} ∧ {{ds.listMode}} ∧ {{ds.tab.data}} |
| EV-0171 | 1526 | oninput {{ds.onQ}} | 이름 · 설명 검색 | {{isDesign}} ∧ {{ds.has}} ∧ {{ds.listTab}} ∧ {{ds.listMode}} |
| EV-0172 | 1531 | onclick {{r.pick}} | div | {{isDesign}} ∧ {{ds.has}} ∧ {{ds.listTab}} ∧ {{ds.listMode}} |
| EV-0173 | 1538 | onclick {{ds.det.close}} | 펼치기 | {{isDesign}} ∧ {{ds.has}} ∧ {{ds.listTab}} ∧ {{ds.det.has}} |
| EV-0174 | 1539 | onclick {{r.pick}} | {{r.kind}} {{r.stL}} {{r.name}} | {{isDesign}} ∧ {{ds.has}} ∧ {{ds.listTab}} ∧ {{ds.det.has}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 1526 | input | {{ds.q}} | {"type": "search", "placeholder": "이름 · 설명 검색"} |

### UI-04-04A — 데이터 상세 (패널)

- 출처: [원본 1568–1579](../../prototype/uiux/Main.dc.html#L1568); 로직 4857-4932.
- 진입: 데이터 행; 인터페이스 테이블 링크.
- 상태: PostgreSQL/Neo4j 라벨·관계/QuestDB/Redis.
- 필드·표시 데이터: 컬럼·제약·인덱스·API; 라벨/관계/props; ts/partition/retention/dedup/symbol/ingest; key/use/value/ttl/invalidation/persist.
- 액션·결과·이동: PostgreSQL 컬럼과 사용하는 API 표시 및 역이동 / Neo4j 라벨·관계·제약 표시 / QuestDB 시간축·파티션·보관·중복제거 표시 / Redis 키·만료·무효화·영속성 표시.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0179 | 1572 | onclick {{u.open}} | {{u.n}} | {{isDesign}} ∧ {{ds.has}} ∧ {{ds.listTab}} ∧ {{ds.det.has}} ∧ {{ds.det.isPg}} ∧ {{ds.det.hasUsed}} |

### UI-04-05 — 소유권·흐름 (탭)

- 출처: [원본 1584–1592](../../prototype/uiux/Main.dc.html#L1584); 로직 4857-4932.
- 진입: 설계 소유권·흐름.
- 상태: 정의 없음/있음.
- 필드·표시 데이터: data/src/copy/sync/lag.
- 액션·결과·이동: 데이터별 원본·복제·동기화·지연 허용 표시.

### UI-04-06 — 변경·불일치 (탭)

- 출처: [원본 1594–1610](../../prototype/uiux/Main.dc.html#L1594); 로직 4831-4843.
- 진입: 설계 변경·불일치; 대시보드 알림.
- 상태: 불일치 없음/open/done; 호환 깨짐.
- 필드·표시 데이터: drift id/kind/item/task/where/t/st/res; versions.
- 액션·결과·이동: 불일치 원인·브랜치·대상 Task와 처리 결과 표시 / 계약에 반영/코드 수정 요청이 Mock 처리 상태를 변경 / 설계 버전별 주체·시각·호환 깨짐 표시.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0180 | 1600 | onclick {{r.openTask}} | {{r.task}} | {{isDesign}} ∧ {{ds.has}} ∧ {{ds.tab.chg}} |
| EV-0181 | 1603 | onclick {{r.toCode}} | 코드 수정 요청 | {{isDesign}} ∧ {{ds.has}} ∧ {{ds.tab.chg}} ∧ {{r.open}} |
| EV-0182 | 1603 | onclick {{r.toContract}} | 계약에 반영 | {{isDesign}} ∧ {{ds.has}} ∧ {{ds.tab.chg}} ∧ {{r.open}} |

### UI-05 — Planning (화면)

- 출처: [원본 1614–1685](../../prototype/uiux/Main.dc.html#L1614); 로직 5949-5987.
- 진입: 메뉴 Planning; 프로젝트 계획 변경.
- 상태: 세션 없음/있음; 합의/이견; 미조정.
- 필드·표시 데이터: 세션 선택; 단계; 2개 탭.
- 액션·결과·이동: 세션별 분석·검토·최종 Diff와 연결 CP 표시 / 세션 없음 안내.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0183 | 1617 | onclick {{tb.pick}} | {{tb.l}} | {{isPlanning}} |

### UI-05-01 — 분석 비교·이견 조정 (탭)

- 출처: [원본 1639–1683](../../prototype/uiux/Main.dc.html#L1639); 로직 5704-5724.
- 진입: Planning 세션 탭.
- 상태: 일치/이견; 조정됨/미조정; 변경 없음; 오류.
- 필드·표시 데이터: 독립분석 agent/at/summary/items; review kind/topic/codex/claude/res/memo/ops.
- 액션·결과·이동: 독립 분석 2개를 나란히 비교 / 이견 조정 선택이 최종 Diff에 반영 / 미조정·순환·완료 Task 수정 문제 시 CP 생성 차단 / CP 생성 후 정책에 따라 자동 반영 또는 승인 대기.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0187 | 1642 | onclick {{p.pick}} | {{p.id}} {{p.title}} {{p.stepL}} | {{isPlanning}} ∧ {{pl.isSessions}} |
| EV-0188 | 1646 | onclick {{pl.s.openCp}} | {{pl.s.cpId}} · {{pl.s.cpStL}} | {{isPlanning}} ∧ {{pl.isSessions}} ∧ {{pl.s.hasCp}} |
| EV-0189 | 1664 | onclick {{o.pick}} | {{o.l}} | {{isPlanning}} ∧ {{pl.isSessions}} ∧ {{rv.canAdjust}} |
| EV-0190 | 1664 | onchange {{rv.onMemo}} | 조정 메모 | {{isPlanning}} ∧ {{pl.isSessions}} ∧ {{rv.canAdjust}} |
| EV-0191 | 1675 | onclick {{r.open}} | {{r.target}} | {{isPlanning}} ∧ {{pl.isSessions}} ∧ {{r.canOpen}} |
| EV-0192 | 1679 | onclick {{pl.s.makeCp}} | Change Proposal 작성 | {{isPlanning}} ∧ {{pl.isSessions}} ∧ disabled={{pl.s.cannotCp}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 1664 | input | {{rv.memo}} | {"aria-label": "조정 메모", "placeholder": "조정 메모 (선택) — 판단 근거를 남깁니다"} |

### UI-05-02 — 일정 재조정 이력 (탭)

- 출처: [원본 1618–1637](../../prototype/uiux/Main.dc.html#L1618); 로직 4284-4305.
- 진입: Planning 일정 재조정 이력.
- 상태: 기록 있음/상세 접힘·펼침.
- 필드·표시 데이터: RP/v/at/by/trigger/end/range/rate/moved before/after/delta.
- 액션·결과·이동: RP마다 계기·주체·새 기준·범위·가동률 표시 / 변경 Task 펼치면 전후·차이와 Task 이동 / Mock Planning 실행은 재조정 기록 추가.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0184 | 1620 | onclick {{pl.runPlanner}} | Planning Agent 재조정 실행 (Mock) | {{isPlanning}} ∧ {{pl.isReplans}} |
| EV-0185 | 1628 | onclick {{rp.toggle}} | {{rp.toggleL}} | {{isPlanning}} ∧ {{pl.isReplans}} ∧ {{rp.hasMoved}} |
| EV-0186 | 1632 | onclick {{m.open}} | {{m.task}} | {{isPlanning}} ∧ {{pl.isReplans}} ∧ {{rp.isOpen}} ∧ {{m.canOpen}} |

### UI-06 — 작업 실행 (화면)

- 출처: [원본 1747–1856](../../prototype/uiux/Main.dc.html#L1747); 로직 6019-6092.
- 진입: 메뉴 작업 실행; Task 실행 탭; 메시지 실행 링크.
- 상태: Task/시도 선택; 실행 불가; 개발/QA/재작업/재검증/Gate/완료.
- 필드·표시 데이터: 왼쪽 Task·시도; 중앙 다음 작업·기록; 오른쪽 메시지.
- 액션·결과·이동: 3영역을 구분 / 현재 단계별 다음 액션 제공 / Runner 끊김·차단·사용량0·용량·관측미확인·준비실패·충돌묶음 사유 표시 / 새 시도에 실제 등급과 하위 Agent 설치 기록.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0205 | 1754 | onclick {{it.pick}} | {{it.id}} {{it.stL}} {{it.title}} 단계: {{it.stage}} · 차단 | {{isExec}} |
| EV-0206 | 1755 | onclick {{a.pick}} | {{a.id}} {{a.kind}} · {{a.agent}} {{a.stL}} | {{isExec}} |
| EV-0207 | 1761 | onclick {{ex.t.open}} | Task 상세 열기 | {{isExec}} |
| EV-0208 | 1763 | onclick {{ac.pick}} | {{ac.l}} | {{isExec}} ∧ disabled={{ac.disabled}} |

### UI-06A — 개발 결과 등록 (편집기)

- 출처: [원본 1767–1779](../../prototype/uiux/Main.dc.html#L1767); 로직 5857-5901.
- 진입: 작업 실행 진행 중 개발/재작업 결과 등록.
- 상태: 성공/실패; 필수 오류.
- 필드·표시 데이터: result/summary/files/fail/tok.
- 액션·결과·이동: 성공 시 요약 필수, 실패 시 사유 필수 / 토큰 숫자 입력(원본 검증 누락은 MM-11) / 파일 경로 일치 산출물 제출 처리 / 성공하면 QA 새 시도 자동 요청 / 실패는 이전 결과를 보존.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0209 | 1771 | onclick {{o.pick}} | {{o.l}} | {{isExec}} ∧ {{ex.isDev}} |
| EV-0210 | 1772 | onchange {{ex.f.set.tok}} | input | {{isExec}} ∧ {{ex.isDev}} |
| EV-0211 | 1773 | onchange {{ex.f.set.summary}} | 무엇을 구현했는지 | {{isExec}} ∧ {{ex.isDev}} |
| EV-0212 | 1774 | onchange {{ex.f.set.files}} | textarea | {{isExec}} ∧ {{ex.isDev}} |
| EV-0213 | 1775 | onchange {{ex.f.set.fail}} | textarea | {{isExec}} ∧ {{ex.isDev}} ∧ {{ex.f.isFail}} |
| EV-0214 | 1776 | onclick {{ex.cancel}} | 취소 | {{isExec}} ∧ {{ex.isDev}} |
| EV-0215 | 1776 | onclick {{ex.submit}} | 결과 등록 | {{isExec}} ∧ {{ex.isDev}} ∧ disabled={{ex.invalid}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 1772 | input | {{ex.f.tok}} | {} |
| 1773 | textarea | {{ex.f.summary}} | {"rows": "3", "placeholder": "무엇을 구현했는지"} |
| 1774 | textarea | {{ex.f.files}} | {"rows": "4"} |
| 1775 | textarea | {{ex.f.fail}} | {"rows": "2"} |

### UI-06B — QA·재검증 결과 등록 (편집기)

- 출처: [원본 1781–1799](../../prototype/uiux/Main.dc.html#L1781); 로직 5870-5920.
- 진입: 작업 실행 QA/재검증 결과 등록.
- 상태: PASS/FAIL/BLOCKED; 필수 오류; 체크리스트 없음.
- 필드·표시 데이터: result/cmd/expected/actual/evidence/defects/checks/tok.
- 액션·결과·이동: 명령·실제결과 필수, FAIL은 결함 필수 / Evidence를 검증과 선택 체크리스트에 연결 / PASS는 Gate, FAIL은 재작업, BLOCKED는 대표 상태를 유지하고 verif=blocked로 기록 / 이전 Verification 보존.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0216 | 1785 | onclick {{o.pick}} | {{o.l}} | {{isExec}} ∧ {{ex.isQa}} |
| EV-0217 | 1786 | onchange {{ex.f.set.tok}} | input | {{isExec}} ∧ {{ex.isQa}} |
| EV-0218 | 1787 | onchange {{ex.f.set.cmd}} | input | {{isExec}} ∧ {{ex.isQa}} |
| EV-0219 | 1788 | onchange {{ex.f.set.expected}} | input | {{isExec}} ∧ {{ex.isQa}} |
| EV-0220 | 1789 | onchange {{ex.f.set.actual}} | textarea | {{isExec}} ∧ {{ex.isQa}} |
| EV-0221 | 1790 | onchange {{ex.f.set.evidence}} | textarea | {{isExec}} ∧ {{ex.isQa}} |
| EV-0222 | 1791 | onchange {{ex.f.set.defects}} | 한 줄에 한 결함 — DEF 번호는 자동 부여 | {{isExec}} ∧ {{ex.isQa}} ∧ {{ex.f.isQaFail}} |
| EV-0223 | 1794 | onchange {{c.toggle}} | input | {{isExec}} ∧ {{ex.isQa}} |
| EV-0224 | 1796 | onclick {{ex.cancel}} | 취소 | {{isExec}} ∧ {{ex.isQa}} |
| EV-0225 | 1796 | onclick {{ex.submit}} | 검증 결과 등록 | {{isExec}} ∧ {{ex.isQa}} ∧ disabled={{ex.invalid}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 1786 | input | {{ex.f.tok}} | {} |
| 1787 | input | {{ex.f.cmd}} | {} |
| 1788 | input | {{ex.f.expected}} | {} |
| 1789 | textarea | {{ex.f.actual}} | {"rows": "2"} |
| 1790 | textarea | {{ex.f.evidence}} | {"rows": "2"} |
| 1791 | textarea | {{ex.f.defects}} | {"rows": "3", "placeholder": "한 줄에 한 결함 — DEF 번호는 자동 부여"} |
| 1794 | input | {{c.checked}} | {"type": "checkbox"} |

### UI-06C — 재작업 지시 (편집기)

- 출처: [원본 1801–1809](../../prototype/uiux/Main.dc.html#L1801); 로직 5864-5928.
- 진입: 작업 실행 재작업 실행.
- 상태: 빈 지시/유효; 용량·Runner 차단.
- 필드·표시 데이터: 지시 body; 대상 Task/Agent.
- 액션·결과·이동: 빈 지시는 제출 거부 / 수정 요청 메시지 기록 후 새 재작업 시도 생성 / 정책에 따라 등급 상향, 중단 후 재개는 동일 등급.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0226 | 1805 | onchange {{ex.f.set.body}} | textarea | {{isExec}} ∧ {{ex.isRw}} |
| EV-0227 | 1806 | onclick {{ex.cancel}} | 취소 | {{isExec}} ∧ {{ex.isRw}} |
| EV-0228 | 1806 | onclick {{ex.submit}} | 지시 전송 후 재작업 실행 | {{isExec}} ∧ {{ex.isRw}} ∧ disabled={{ex.invalid}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 1805 | textarea | {{ex.f.body}} | {"rows": "6"} |

### UI-06D — 실행 Gate·선택 시도 (패널)

- 출처: [원본 1811–1840](../../prototype/uiux/Main.dc.html#L1811); 로직 5806-5856.
- 진입: 작업 실행 단계/시도 선택.
- 상태: Gate 불충족/충족; 시도 없음; 검증 있음/없음.
- 필드·표시 데이터: 5개 Gate 조건; Attempt 결과; Verification; CI 링크.
- 액션·결과·이동: Gate 판정 사유와 완료 불가 사유 표시 / 완료 처리 시 확인 창 제공 / 시도별 요약·실패·파일·검증·CI 표시 / 실제 완료 판정은 불일치 MM-01 참조.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0229 | 1815 | onclick {{ex.complete}} | Task 완료 처리 | {{isExec}} ∧ {{ex.gateShow}} ∧ disabled={{ex.cannotComplete}} |
| EV-0230 | 1822 | onclick {{ex.a.openCi}} | {{ex.a.ciL}} | {{isExec}} ∧ {{ex.hasAtt}} ∧ {{ex.a.hasCi}} |

### UI-06E — 실행 연결 메시지 (패널)

- 출처: [원본 1842–1854](../../prototype/uiux/Main.dc.html#L1842); 로직 6019-6079.
- 진입: 작업 실행 오른쪽 메시지.
- 상태: 연결 메시지 없음/있음; 새 응답.
- 필드·표시 데이터: 방향/유형/전달/본문/시각/시도.
- 액션·결과·이동: 실행 기록과 메시지는 분리 / 메시지 작성은 Task 메시지 탭으로 이동 / Task 메시지에서 보기로 관련 상세 이동.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0231 | 1843 | onclick {{ex.writeMsg}} | 메시지 작성 | {{isExec}} |
| EV-0232 | 1850 | onclick {{m.open}} | Task 메시지에서 보기 | {{isExec}} |

### UI-07 — 검증 (화면)

- 출처: [원본 1902–1970](../../prototype/uiux/Main.dc.html#L1902); 로직 6334-6369.
- 진입: 메뉴 검증; QA 결과 링크.
- 상태: 결과/Evidence/Gate 3탭.
- 필드·표시 데이터: 검증·증거·Task별 Gate.
- 액션·결과·이동: 결과 등록은 작업 실행에서만 수행 / 3탭별 건수와 데이터 표시.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0241 | 1905 | onclick {{tb.pick}} | {{tb.l}} {{tb.n}} | {{isVerify}} |

### UI-07-01 — 검증 결과 목록 (탭)

- 출처: [원본 1907–1917](../../prototype/uiux/Main.dc.html#L1907); 로직 6334-6369.
- 진입: 검증 결과 탭.
- 상태: 기록 없음/필터 결과 없음; PASS/FAIL/BLOCKED.
- 필드·표시 데이터: result/agent 필터; id/task/title/attempt/result/agent/at/defN/evN.
- 액션·결과·이동: 판정·Agent 필터 적용 / 기록 없음과 검색 결과 없음 구분 / 행 선택 시 레일+상세.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0242 | 1909 | onclick {{o.pick}} | {{o.l}} | {{isVerify}} ∧ {{vf.isResults}} ∧ {{vf.listMode}} |
| EV-0243 | 1909 | onclick {{o.pick}} | {{o.l}} | {{isVerify}} ∧ {{vf.isResults}} ∧ {{vf.listMode}} |
| EV-0244 | 1913 | onclick {{v.pick}} | div | {{isVerify}} ∧ {{vf.isResults}} ∧ {{vf.listMode}} |
| EV-0245 | 1913 | onclick {{v.pick}} | {{v.id}} | {{isVerify}} ∧ {{vf.isResults}} ∧ {{vf.listMode}} |

### UI-07-01A — 검증 결과 상세·Evidence 연결 (패널)

- 출처: [원본 1918–1944](../../prototype/uiux/Main.dc.html#L1918); 로직 6238-6252.
- 진입: 검증 결과 행/이전·다음.
- 상태: Evidence 없음; 체크리스트 없음; 목록 밖.
- 필드·표시 데이터: 명령/예상/실제/결함; evidence path/kind; checklist link.
- 액션·결과·이동: 검증 상세에 Task와 실행 링크 / Evidence 추가는 빈 경로 거부·중복 처리 / 항목 선택으로 Evidence 연결/해제 / 이전·다음과 펼치기 동작.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0246 | 1921 | onclick {{vf.det.close}} | 펼치기 | {{isVerify}} ∧ {{vf.isResults}} ∧ {{vf.det.has}} |
| EV-0247 | 1922 | onclick {{v.pick}} | {{v.id}} {{v.result}} {{v.task}} {{v.title}} {{v.agent}} · {{v.at}} | {{isVerify}} ∧ {{vf.isResults}} ∧ {{vf.det.has}} |
| EV-0248 | 1926 | onclick {{vf.det.prev}} | ↑ 이전 | {{isVerify}} ∧ {{vf.isResults}} ∧ {{vf.det.has}} ∧ disabled={{vf.det.noPrev}} |
| EV-0249 | 1926 | onclick {{vf.det.next}} | ↓ 다음 | {{isVerify}} ∧ {{vf.isResults}} ∧ {{vf.det.has}} ∧ disabled={{vf.det.noNext}} |
| EV-0250 | 1927 | onclick {{vf.det.openTask}} | {{vf.det.task}} {{vf.det.title}} | {{isVerify}} ∧ {{vf.isResults}} ∧ {{vf.det.has}} |
| EV-0251 | 1927 | onclick {{vf.det.openExec}} | 실행 {{vf.det.attempt}} | {{isVerify}} ∧ {{vf.isResults}} ∧ {{vf.det.has}} |
| EV-0252 | 1937 | onclick {{lk.pick}} | {{lk.l}} | {{isVerify}} ∧ {{vf.isResults}} ∧ {{vf.det.has}} |
| EV-0253 | 1940 | onchange {{vf.det.onAddPath}} | evidence/TASK-0000/... 파일 경로 또는 링크 | {{isVerify}} ∧ {{vf.isResults}} ∧ {{vf.det.has}} |
| EV-0254 | 1940 | onclick {{vf.det.add}} | Evidence 추가 | {{isVerify}} ∧ {{vf.isResults}} ∧ {{vf.det.has}} ∧ disabled={{vf.det.cannotAdd}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 1940 | input | {{vf.det.addPath}} | {"placeholder": "evidence/TASK-0000/... 파일 경로 또는 링크"} |

### UI-07-02 — Evidence 통합 목록 (탭)

- 출처: [원본 1947–1957](../../prototype/uiux/Main.dc.html#L1947); 로직 6334-6369.
- 진입: 검증 Evidence 탭.
- 상태: 없음; 고아 체크리스트 Evidence 경고.
- 필드·표시 데이터: path/kind/verification/task/checklist/result.
- 액션·결과·이동: Evidence 행은 소속 Verification으로 이동 / 검증에 없는 체크리스트 Evidence를 별도 경고.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0255 | 1952 | onclick {{e.open}} | {{e.path}} | {{isVerify}} ∧ {{vf.isEvidence}} |

### UI-07-03 — Completion Gate 현황 (탭)

- 출처: [원본 1959–1968](../../prototype/uiux/Main.dc.html#L1959); 로직 6334-6369.
- 진입: 검증 Completion Gate 탭.
- 상태: 전체/미통과만; 미통과 없음.
- 필드·표시 데이터: Task/status; Checklist/outputs/Verification/defects/approval 판정.
- 액션·결과·이동: 각 Task의 5조건과 합계 표시 / 필터로 미통과만 조회 / Task 선택은 상세 Gate로 연결.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0256 | 1960 | onclick {{o.pick}} | {{o.l}} | {{isVerify}} ∧ {{vf.isGate}} |
| EV-0257 | 1964 | onclick {{g.open}} | {{g.id}} | {{isVerify}} ∧ {{vf.isGate}} |

### UI-08 — 빌드·통합 (화면)

- 출처: [원본 1405–1482](../../prototype/uiux/Main.dc.html#L1405); 로직 4765-4801.
- 진입: 메뉴 빌드·통합; Task CI 링크; 알림.
- 상태: 전체 기록 없음; main 정상/깨짐/없음; 미해결 실패.
- 필드·표시 데이터: main commit/E2E; 실행/실패/대기/배포 요약; 5탭.
- 액션·결과·이동: main 상태와 미해결 실패 수 표시 / 탭 배지와 전환 / Mock 실패가 관련 실행 상세와 알림을 만듦.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0145 | 1409 | onclick {{ciV.intFail}} | 통합 확인 실패 | {{isCi}} |
| EV-0146 | 1409 | onclick {{ciV.guard}} | 보호 경로 변경 | {{isCi}} |
| EV-0147 | 1411 | onclick {{t.pick}} | {{t.l}} {{t.badge}} | {{isCi}} |

### UI-08-01 — CI 실행 기록 (탭)

- 출처: [원본 1413–1449](../../prototype/uiux/Main.dc.html#L1413); 로직 4765-4801.
- 진입: 빌드·통합 실행 기록.
- 상태: stage 전체/task/int/night/deploy; 기록 없음; 목록/상세.
- 필드·표시 데이터: CI id/stage/st/task/ref/pr/at/dur/trig.
- 액션·결과·이동: 단계 필터 적용 / 기록 선택 시 레일+상세 / Task 링크는 WBS.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0148 | 1415 | onclick {{o.pick}} | {{o.l}} | {{isCi}} ∧ {{ciV.tab.runs}} ∧ {{ciV.listMode}} |
| EV-0149 | 1419 | onclick {{r.pick}} | div | {{isCi}} ∧ {{ciV.tab.runs}} ∧ {{ciV.listMode}} |

### UI-08-01A — CI 실행 상세 (패널)

- 출처: [원본 1422–1448](../../prototype/uiux/Main.dc.html#L1422); 로직 4726-4754.
- 진입: CI 행; Task 검사 링크; 실패 알림.
- 상태: pass/fail/run/queued/skip; 로그/스크린샷 있음·없음.
- 필드·표시 데이터: 대상/Task/Attempt/계기/시간/GitHub/병합/URL; 단계 결과/소요; 실패 로그/파일명.
- 액션·결과·이동: 실패 단계 뒤는 건너뜀 표시 / 실패만 다시 실행 가능 / 재실행은 새 CI 기록 생성 / 통합 성공이면 병합/메인 상태 갱신 / 이전·다음·목록 밖과 펼치기 동작.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0150 | 1425 | onclick {{ciV.det.close}} | 펼치기 | {{isCi}} ∧ {{ciV.tab.runs}} ∧ {{ciV.det.has}} |
| EV-0151 | 1426 | onclick {{r.pick}} | {{r.id}} {{r.st}} {{r.stL}} · {{r.task}} {{r.at}} | {{isCi}} ∧ {{ciV.tab.runs}} ∧ {{ciV.det.has}} |
| EV-0152 | 1429 | onclick {{ciV.det.prev}} | ↑ 이전 | {{isCi}} ∧ {{ciV.tab.runs}} ∧ {{ciV.det.has}} ∧ disabled={{ciV.det.noPrev}} |
| EV-0153 | 1429 | onclick {{ciV.det.next}} | ↓ 다음 | {{isCi}} ∧ {{ciV.tab.runs}} ∧ {{ciV.det.has}} ∧ disabled={{ciV.det.noNext}} |
| EV-0154 | 1433 | onclick {{ciV.det.openTask}} | {{ciV.det.task}} | {{isCi}} ∧ {{ciV.tab.runs}} ∧ {{ciV.det.has}} ∧ {{ciV.det.hasTask}} |
| EV-0155 | 1445 | onclick {{ciV.det.retry}} | {{ciV.det.bRetry.l}} | {{isCi}} ∧ {{ciV.tab.runs}} ∧ {{ciV.det.has}} ∧ {{ciV.det.canRetry}} ∧ disabled={{ciV.det.bRetry.dis}} |

### UI-08-02 — 병합 대기열 (탭)

- 출처: [원본 1451–1457](../../prototype/uiux/Main.dc.html#L1451); 로직 4736-4745.
- 진입: 빌드·통합 병합 대기열.
- 상태: 대기열 없음; 대기/확인중/실패/병합됨.
- 필드·표시 데이터: PR/task/title/st/at.
- 액션·결과·이동: 검증 PASS 후 통합 확인 직렬 대기 안내 / 실패 PR은 병합 보류로 표시 / Task 링크 이동.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0156 | 1455 | onclick {{q.openTask}} | {{q.task}} | {{isCi}} ∧ {{ciV.tab.queue}} |

### UI-08-03 — 배포 확인 (탭)

- 출처: [원본 1458–1464](../../prototype/uiux/Main.dc.html#L1458); 로직 4755-4763.
- 진입: 빌드·통합 배포 확인.
- 상태: 실행 전/진행/성공/실패.
- 필드·표시 데이터: URL/최근 CI/결과/시각.
- 액션·결과·이동: 배포 확인 실행이 새 deploy 기록을 생성 / 최근 기록으로 이동 / Mock 포트 충돌 실패는 로그·알림·실패 상태 생성.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0157 | 1461 | onclick {{ciV.dep.openLast}} | {{ciV.dep.last}} | {{isCi}} ∧ {{ciV.tab.deploy}} |
| EV-0158 | 1462 | onclick {{ciV.dep.run}} | {{ciV.dep.bRun.l}} | {{isCi}} ∧ {{ciV.tab.deploy}} ∧ disabled={{ciV.dep.bRun.dis}} |
| EV-0159 | 1462 | onclick {{ciV.dep.fail}} | 배포 확인 실패 | {{isCi}} ∧ {{ciV.tab.deploy}} |

### UI-08-04 — 파이프라인 정의 (탭)

- 출처: [원본 1465–1473](../../prototype/uiux/Main.dc.html#L1465); 로직 3523-3530.
- 진입: 빌드·통합 파이프라인 정의.
- 상태: 읽기 전용.
- 필드·표시 데이터: file/ref; stage/when/steps/gate; 보호 규칙; night/retry/svc/deployUrl.
- 액션·결과·이동: 4단계와 실행 조건·통과 기준 표시 / 정의 파일·기준 커밋 표시 / 야간 시각·재시도·서비스·URL 설정 표시.

### UI-08-05 — 불안정 테스트 (탭)

- 출처: [원본 1475–1481](../../prototype/uiux/Main.dc.html#L1475); 로직 4764-4801.
- 진입: 빌드·통합 불안정 테스트.
- 상태: 없음; 격리/정상.
- 필드·표시 데이터: test/rate/last/st/task.
- 액션·결과·이동: 격리 해제와 다시 격리가 실제 Mock 상태를 변경 / 담당 Task로 이동.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0160 | 1479 | onclick {{f.openTask}} | {{f.task}} | {{isCi}} ∧ {{ciV.tab.flaky}} |
| EV-0161 | 1479 | onclick {{f.toggle}} | {{f.tl}} | {{isCi}} ∧ {{ciV.tab.flaky}} |

### UI-09 — 변경 제안 (화면)

- 출처: [원본 1687–1745](../../prototype/uiux/Main.dc.html#L1687); 로직 5988-6018.
- 진입: 메뉴 변경 제안; Planning/메시지/입력분석 CP.
- 상태: 없음; draft/review/changes/approved/rejected/applied.
- 필드·표시 데이터: CP 목록 id/status/title/source/ops수.
- 액션·결과·이동: CP 목록 선택으로 사유·Diff·영향·승인 이력 표시 / 새 변경 제안으로 공용 모달 진입 / 비어 있을 때 유입 경로 안내.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0193 | 1689 | onclick {{openCpmNew}} | 새 변경 제안 | {{isChange}} |
| EV-0194 | 1693 | onclick {{p.pick}} | {{p.id}} {{p.stL}} {{p.title}} 출처 {{p.src}} · 변경 {{p.n}} | {{isChange}} |

### UI-09A — CP 상세·승인·반영 (패널)

- 출처: [원본 1697–1741](../../prototype/uiux/Main.dc.html#L1697); 로직 5725-5763.
- 진입: CP 선택.
- 상태: 승인대기/수정요청/반려/승인후반영대기/반영완료; 시뮬레이션 오류.
- 필드·표시 데이터: reason/source/ops/diff/impact/comment/approvals/idMap.
- 액션·결과·이동: 승인 전에 WBS가 변경되지 않음 / 문제 있는 변경은 승인·반영 차단 / 수정 요청/반려 시 의견 필수 / 수정 요청 중 항목 제외와 재제출 / 승인 후 WBS 반영 시 동일 시뮬레이션 결과와 Task·의존성·이력·일정 갱신 / 완료 Task와 기존 검증 결과 보존.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0195 | 1699 | onclick {{cpv.p.openSrc}} | 출처: {{cpv.p.srcL}} | {{isChange}} ∧ {{cpv.has}} ∧ {{cpv.p.hasSrc}} |
| EV-0196 | 1707 | onclick {{r.open}} | {{r.target}} | {{isChange}} ∧ {{cpv.has}} ∧ {{r.canOpen}} |
| EV-0197 | 1707 | onclick {{r.remove}} | 제외 | {{isChange}} ∧ {{cpv.has}} ∧ {{r.canRemove}} |
| EV-0198 | 1717 | onclick {{im.open}} | {{im.id}} | {{isChange}} ∧ {{cpv.has}} ∧ {{cpv.p.hasImpact}} ∧ {{im.canOpen}} |
| EV-0199 | 1726 | onchange {{cpv.p.onComment}} | 의견 — 반려 · 수정 요청 시 필수 | {{isChange}} ∧ {{cpv.has}} ∧ {{cpv.p.isReview}} |
| EV-0200 | 1728 | onclick {{cpv.p.changes}} | 수정 요청 | {{isChange}} ∧ {{cpv.has}} ∧ {{cpv.p.isReview}} |
| EV-0201 | 1728 | onclick {{cpv.p.reject}} | 반려 | {{isChange}} ∧ {{cpv.has}} ∧ {{cpv.p.isReview}} |
| EV-0202 | 1728 | onclick {{cpv.p.approve}} | 승인 | {{isChange}} ∧ {{cpv.has}} ∧ {{cpv.p.isReview}} ∧ disabled={{cpv.p.cannotApprove}} |
| EV-0203 | 1732 | onclick {{cpv.p.resubmit}} | 재제출 | {{isChange}} ∧ {{cpv.has}} ∧ {{cpv.p.isChanges}} ∧ disabled={{cpv.p.cannotResubmit}} |
| EV-0204 | 1735 | onclick {{cpv.p.apply}} | WBS 반영 | {{isChange}} ∧ {{cpv.has}} ∧ {{cpv.p.isApproved}} ∧ disabled={{cpv.p.hasIssues}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 1726 | textarea | {{cpv.p.comment}} | {"rows": "2", "placeholder": "의견 — 반려 · 수정 요청 시 필수"} |

### UI-10 — 전체 이력 (화면)

- 출처: [원본 1972–1991](../../prototype/uiux/Main.dc.html#L1972); 로직 6448-6460.
- 진입: 메뉴 이력.
- 상태: 기록 없음/필터 결과 없음.
- 필드·표시 데이터: 내용 검색; Task ID; 유형; 주체; at/actor/kind/task/text/before/after.
- 액션·결과·이동: 검색·Task·유형·주체 필터와 초기화 / 최신순·전후 표시 / Task 링크 이동 / 기간 필터는 원본 미구현 불일치 참조.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0258 | 1976 | onchange {{hv.onQ}} | 변경 내용 · 값 검색 | {{isHist}} |
| EV-0259 | 1977 | onchange {{hv.onTask}} | TASK-0007 | {{isHist}} |
| EV-0260 | 1978 | onclick {{hv.reset}} | 필터 초기화 | {{isHist}} ∧ disabled={{hv.noFilter}} |
| EV-0261 | 1979 | onclick {{o.pick}} | {{o.l}} | {{isHist}} |
| EV-0262 | 1980 | onclick {{o.pick}} | {{o.l}} | {{isHist}} |
| EV-0263 | 1986 | onclick {{h.open}} | {{h.task}} | {{isHist}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 1976 | input | {{hv.q}} | {"type": "search", "placeholder": "변경 내용 · 값 검색"} |
| 1977 | input | {{hv.task}} | {"placeholder": "TASK-0007"} |

### UI-11 — 보고서 (화면)

- 출처: [원본 2089–2249](../../prototype/uiux/Main.dc.html#L2089); 로직 6370-6447.
- 진입: 메뉴 보고서; 메일 이력 보고서 링크.
- 상태: 없음/종류 필터 없음; 문서 로딩; 생성 오류.
- 필드·표시 데이터: daily/weekly/custom; 기간/보기; 보고서 목록·스냅샷.
- 액션·결과·이동: 종류 필터와 보고서 선택 / 정기 생성 Mock 점검은 누락분만 생성 / 생성 시점 스냅샷을 열 때 재계산하지 않음 / 생성 후 일정변경은 별도 안내 / 문서 부분 로딩만 표시.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0290 | 2106 | onclick {{rp.sched.run}} | 정기 생성 점검 (Mock) | {{isReport}} |
| EV-0291 | 2108 | onclick {{f.pick}} | {{f.l}} | {{isReport}} |
| EV-0292 | 2112 | onclick {{r.open}} | {{r.kindL}} {{r.periodL}} 누락분 보충 {{r.id}} · 생성 {{r.atL}} · {{r.byL}} · {{r.audL}} | {{isReport}} |

### UI-11A — 기간 지정 보고서 (편집기)

- 출처: [원본 2093–2102](../../prototype/uiux/Main.dc.html#L2093); 로직 4989-4999.
- 진입: 보고서 상단.
- 상태: 빈 날짜/역전/미래/93일초과 오류; 생성중.
- 필드·표시 데이터: from/to/aud; 날짜 단축 선택.
- 액션·결과·이동: 날짜 둘 다 필수, from≤to≤오늘, 포함 93일까지 허용 / 이번 주/지난 주/최근 30일 단축 기간 적용 / 선택한 보기로 custom 보고서 생성 후 선택.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0285 | 2095 | onchange {{rp.form.onFrom}} | 시작일 | {{isReport}} |
| EV-0286 | 2095 | onchange {{rp.form.onTo}} | 종료일 | {{isReport}} |
| EV-0287 | 2096 | onclick {{q.pick}} | {{q.l}} | {{isReport}} |
| EV-0288 | 2097 | onclick {{o.pick}} | {{o.l}} | {{isReport}} |
| EV-0289 | 2098 | onclick {{rp.form.create}} | {{rp.form.bCreate.l}} | {{isReport}} ∧ disabled={{rp.form.bCreate.dis}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 2095 | input | {{rp.form.from}} | {"type": "date", "aria-label": "시작일"} |
| 2095 | input | {{rp.form.to}} | {"type": "date", "aria-label": "종료일"} |

### UI-11B — 팀장용 보고서 (패널)

- 출처: [원본 2141–2226](../../prototype/uiux/Main.dc.html#L2141); 로직 3797-3869.
- 진입: 보고서 선택·팀장용.
- 상태: 섹션별 없음/있음; 주간·기간 추세; QA실패.
- 필드·표시 데이터: 4 KPI; 확인필요; 완료/진행/QA실패 상세; 실행/재조정/중단/메시지/예정; 전체Task 부록.
- 액션·결과·이동: 세부 Task 판단 정보와 증거를 문서에 포함 / 주간·기간 일별 추세 표시 / 보고서 Task 링크는 현재 WBS 상세 이동 / 전체 Task 부록은 인쇄 새 페이지.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0297 | 2160 | onclick {{t.open}} | {{t.id}} | {{isReport}} ∧ {{rp.doc.has}} ∧ {{rp.doc.isInt}} |
| EV-0298 | 2169 | onclick {{t.open}} | {{t.id}} | {{isReport}} ∧ {{rp.doc.has}} ∧ {{rp.doc.isInt}} |
| EV-0299 | 2178 | onclick {{f.open}} | {{f.task}} | {{isReport}} ∧ {{rp.doc.has}} ∧ {{rp.doc.isInt}} ∧ {{rp.doc.det.hasFail}} |
| EV-0300 | 2216 | onclick {{t.open}} | {{t.id}} | {{isReport}} ∧ {{rp.doc.has}} ∧ {{rp.doc.isInt}} ∧ {{rp.doc.det.hasNext}} |
| EV-0301 | 2223 | onclick {{t.open}} | {{t.id}} | {{isReport}} ∧ {{rp.doc.has}} ∧ {{rp.doc.isInt}} |

### UI-11C — 보고용 보고서 (패널)

- 출처: [원본 2228–2242](../../prototype/uiux/Main.dc.html#L2228); 로직 6370-6447.
- 진입: 주간/기간 보고서 보기 보고용.
- 상태: 주간추세 있음/없음; 완료/계획 없음.
- 필드·표시 데이터: 4 KPI; 요약; 추세; 주요완료; 위험; 다음계획.
- 액션·결과·이동: 팀장용과 동일 스냅샷 숫자 사용 / 내부 Task ID·모델·토큰 대신 요약 문장 표시 / 기간/생성시각·스냅샷 기준 표시.

### UI-11D — 보고서 출력·발송 (패널)

- 출처: [원본 2123–2133](../../prototype/uiux/Main.dc.html#L2123); 로직 4997-5012.
- 진입: 보고서 문서 상단.
- 상태: 발송기록 접힘/펼침; PDF 실패; 보기 전환.
- 필드·표시 데이터: aud; 발송 at/to/st/why; 파일명.
- 액션·결과·이동: 메일 미리보기와 수신자 선택 모달 열림 / 발송기록 펼침 / PDF 다운로드는 프로토타입에서 iframe 인쇄이며 실제 제품은 서버 PDF 필요 / PDF 실패 후 재시도 가능.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0293 | 2125 | onclick {{o.pick}} | {{o.l}} | {{isReport}} ∧ {{rp.doc.has}} ∧ {{rp.doc.canToggle}} |
| EV-0294 | 2127 | onclick {{rp.doc.mailPv}} | 메일 미리보기 | {{isReport}} ∧ {{rp.doc.has}} |
| EV-0295 | 2128 | onclick {{rp.doc.mailSend}} | 메일로 보내기 | {{isReport}} ∧ {{rp.doc.has}} |
| EV-0296 | 2129 | onclick {{rp.doc.print}} | PDF 다운로드 | {{isReport}} ∧ {{rp.doc.has}} |

### UI-12 — 설정 (화면)

- 출처: [원본 2251–2676](../../prototype/uiux/Main.dc.html#L2251); 로직 6647-6781.
- 진입: 메뉴 설정; 알림별 직접 탭 이동.
- 상태: 등록전 허용; 6개 탭; Runner/분할/메일/알림 배지.
- 필드·표시 데이터: runner/agent/plan/report/notify/system.
- 액션·결과·이동: 탭 하나만 표시 / 알림 링크는 해당 탭으로 이동 / 배지는 실제 이상·위반·미해결 발송 수와 일치.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0302 | 2255 | onclick {{t.pick}} | {{t.l}} {{t.badge}} | {{isSettings}} |

### UI-12-01 — Runner·실행 환경 (탭)

- 출처: [원본 2257–2395](../../prototype/uiux/Main.dc.html#L2257); 로직 6667-6679.
- 진입: 설정 기본 탭; 준비/GitHub/관측 알림.
- 상태: 준비 정상/주의/문제; 연결/끊김.
- 필드·표시 데이터: GitHub/연결/준비/가동률/사용량/동시실행.
- 액션·결과·이동: 각 세부 패널 진입과 상태 요약 표시 / 등록 전에도 설정 가능.

### UI-12-01A — GitHub 연결 (패널)

- 출처: [원본 2258–2272](../../prototype/uiux/Main.dc.html#L2258); 로직 4802-4812.
- 진입: 설정 Runner 탭.
- 상태: gh/token; 토큰없음/형식오류/만료/연결됨; 권한누락.
- 필드·표시 데이터: mode/account/repo/tokenSet/expires/scopes contents,pulls,statuses,metadata.
- 액션·결과·이동: gh/토큰 방식 전환 / 잘못된 토큰 거부 / 저장 후 토큰 입력 비움·등록여부만 표시 / 연결 확인 중 버튼 비활성 / 만료 Mock은 실패·배지·알림을 생성.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0303 | 2261 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.runner}} |
| EV-0304 | 2270 | onchange {{cfg.gh.onTok}} | github_pat_… | {{isSettings}} ∧ {{cfg.tab.runner}} ∧ {{cfg.gh.isToken}} |
| EV-0305 | 2270 | onclick {{cfg.gh.save}} | {{cfg.gh.bSave.l}} | {{isSettings}} ∧ {{cfg.tab.runner}} ∧ {{cfg.gh.isToken}} ∧ disabled={{cfg.gh.bSave.dis}} |
| EV-0306 | 2271 | onclick {{cfg.gh.check}} | {{cfg.gh.bCheck.l}} | {{isSettings}} ∧ {{cfg.tab.runner}} ∧ disabled={{cfg.gh.bCheck.dis}} |
| EV-0307 | 2271 | onclick {{cfg.gh.brk}} | 인증 만료 | {{isSettings}} ∧ {{cfg.tab.runner}} |
| EV-0308 | 2271 | onclick {{cfg.gh.fix}} | 복구 | {{isSettings}} ∧ {{cfg.tab.runner}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 2270 | input | {{cfg.gh.tok}} | {"type": "password", "placeholder": "github_pat_…"} |

### UI-12-01B — Runner 연결·준비 상태 (패널)

- 출처: [원본 2273–2288](../../prototype/uiux/Main.dc.html#L2273); 로직 4589-4599.
- 진입: 설정 Runner 탭.
- 상태: 온라인/오프라인; liveInject 지원/미지원; ok/warn/fail.
- 필드·표시 데이터: heartbeat 60; readiness items k/l/v/st/fix/at.
- 액션·결과·이동: 연결 전환은 헤더와 동기화 / liveInject 설정이 다음실행 대기 동작에 반영 / 준비 이상에 조치 방법 표시 / Codex 실패 시 해당 Agent 새 실행 차단 / 재점검/조치완료 Mock 결과 갱신.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0309 | 2276 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.runner}} |
| EV-0310 | 2277 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.runner}} |
| EV-0311 | 2282 | onclick {{cfg.rd.recheck}} | 다시 점검 | {{isSettings}} ∧ {{cfg.tab.runner}} |
| EV-0312 | 2282 | onclick {{cfg.rd.breakCodex}} | Codex 로그인 만료 (Mock) | {{isSettings}} ∧ {{cfg.tab.runner}} |
| EV-0313 | 2286 | onclick {{x.fixIt}} | 조치 완료 (Mock) | {{isSettings}} ∧ {{cfg.tab.runner}} ∧ {{x.canFix}} |

### UI-12-01C — 관측 가동률·사용량·중단 (패널)

- 출처: [원본 2289–2323](../../prototype/uiux/Main.dc.html#L2289); 로직 6080-6134.
- 진입: 설정 Runner 탭.
- 상태: 기록부족 가정; 중단없음; 사용량 정상/한도/리셋.
- 필드·표시 데이터: rate/range/basis/days/gaps; usage remain/reset/at; sessions.
- 액션·결과·이동: 최근7일 가동률과 근거 표시 / Agent 한도 도달 시 해당 시도 중단·리셋 전 보류 / 리셋 후 실행 가능 / 재부팅/전원/오류 중단 기록과 재연결 / 중단 전 시도 보존.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0314 | 2313 | onclick {{o.pick}} | {{o.l}} — 죽은 잔재: ag.run/ag.slotOpts 제공 안 됨. 제품 행 제거(MM-24, 독립 리뷰 B1). | {{isSettings}} ∧ {{cfg.tab.runner}} |
| EV-0315 | 2315 | onclick {{ag.limit}} | 사용량 한도 도달 | {{isSettings}} ∧ {{cfg.tab.runner}} |
| EV-0316 | 2315 | onclick {{ag.reset2}} | 사용량 리셋 | {{isSettings}} ∧ {{cfg.tab.runner}} |
| EV-0317 | 2320 | onclick {{cfg.stopReboot}} | 재부팅 | {{isSettings}} ∧ {{cfg.tab.runner}} ∧ disabled={{cfg.isOff}} |
| EV-0318 | 2320 | onclick {{cfg.stopOff}} | PC 꺼짐 | {{isSettings}} ∧ {{cfg.tab.runner}} ∧ disabled={{cfg.isOff}} |
| EV-0319 | 2320 | onclick {{cfg.stopErr}} | 오류 중단 | {{isSettings}} ∧ {{cfg.tab.runner}} ∧ disabled={{cfg.isOff}} |
| EV-0320 | 2320 | onclick {{cfg.start}} | 재연결 | {{isSettings}} ∧ {{cfg.tab.runner}} ∧ disabled={{cfg.isOn}} |

### UI-12-01D — 동시 실행 상한·PC·Runner 조절 (패널)

- 출처: [원본 2326–2393](../../prototype/uiux/Main.dc.html#L2326); 로직 6135-6184.
- 진입: 설정 Runner 동시 실행.
- 상태: auto/manual; 권장 초과; 메모리압박/429; PC변경.
- 필드·표시 데이터: host CPU/cores/mem/swap/disk/os/perSess; cap total/Claude/Codex/heavy/memGB; cur/res/log.
- 액션·결과·이동: 자동은 PC 권장 상한 적용 / 직접지정은 값 유지 및 권장 초과 경고 / 메모리압박·429로 한도 감소와 기록 / 안정 유지로 한도 증가 / PC 변경은 이전 시도 중단·상한/일정/PC이력 갱신 / 동일 충돌묶음 직렬화.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0321 | 2331 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.runner}} |
| EV-0322 | 2333 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.runner}} ∧ disabled={{cfg.cc.isAuto}} |
| EV-0323 | 2334 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.runner}} ∧ disabled={{cfg.cc.isAuto}} |
| EV-0324 | 2335 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.runner}} ∧ disabled={{cfg.cc.isAuto}} |
| EV-0325 | 2336 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.runner}} ∧ disabled={{cfg.cc.isAuto}} |
| EV-0326 | 2337 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.runner}} |
| EV-0327 | 2349 | onclick {{w.open}} | {{w.id}} | {{isSettings}} ∧ {{cfg.tab.runner}} ∧ {{cfg.cc.hasCgWait}} |
| EV-0334 | 2379 | onclick {{cfg.cc.up}} | 안정 10분 유지 | {{isSettings}} ∧ {{cfg.tab.runner}} |
| EV-0335 | 2379 | onclick {{cfg.cc.memP}} | 메모리 압박 | {{isSettings}} ∧ {{cfg.tab.runner}} |
| EV-0336 | 2379 | onclick {{cfg.cc.rate}} | API 속도 제한 | {{isSettings}} ∧ {{cfg.tab.runner}} |
| EV-0337 | 2380 | onclick {{cfg.cc.toLow}} | 저사양 노트북 (12코어 · 8GB) | {{isSettings}} ∧ {{cfg.tab.runner}} |
| EV-0338 | 2380 | onclick {{cfg.cc.toCur}} | 현재 PC (20코어 · 23GB) | {{isSettings}} ∧ {{cfg.tab.runner}} |
| EV-0339 | 2380 | onclick {{cfg.cc.toHigh}} | 고사양 워크스테이션 (32코어 · 56GB) | {{isSettings}} ∧ {{cfg.tab.runner}} |

### UI-12-01E — 하위 Agent 관측·예산 (패널)

- 출처: [원본 2351–2376](../../prototype/uiux/Main.dc.html#L2351); 로직 4110-4135.
- 진입: 설정 Runner 동시 실행 내.
- 상태: ok/unconf; 검증됨/일부관측/미검증; CLI 버전불일치.
- 필드·표시 데이터: 세션/agent/seen/hold; budget dev/qa; CLI inst/ver/model/grade/options/at.
- 액션·결과·이동: 미검증은 max(예산,관측) 보유 계산 / 출력 단절은 수를 줄이지 않고 보유·새 실행 보류 / 스트림/프로세스그룹 확인으로 해제 / CLI 업데이트는 미검증 경고와 보수 계산 / 슬롯 반환은 실제 제품에서 프로세스 그룹 종료 근거 필요.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0328 | 2357 | onclick {{o.open}} | {{o.id}} | {{isSettings}} ∧ {{cfg.tab.runner}} |
| EV-0329 | 2362 | onclick {{o.cut}} | 출력 끊김 (Mock) | {{isSettings}} ∧ {{cfg.tab.runner}} ∧ {{o.ok}} |
| EV-0330 | 2362 | onclick {{o.fix}} | 스트림 재연결 | {{isSettings}} ∧ {{cfg.tab.runner}} ∧ {{o.un}} |
| EV-0331 | 2362 | onclick {{o.pg}} | 프로세스 그룹 확인 | {{isSettings}} ∧ {{cfg.tab.runner}} ∧ {{o.un}} |
| EV-0332 | 2365 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.runner}} |
| EV-0333 | 2376 | onclick {{cfg.cc.ob.cliver}} | Mock: Codex 0.168.0 업데이트 | {{isSettings}} ∧ {{cfg.tab.runner}} |

### UI-12-02 — Agent (탭)

- 출처: [원본 2396–2450](../../prototype/uiux/Main.dc.html#L2396); 로직 6710-6722.
- 진입: 설정 Agent 탭.
- 상태: 기본개발=검증 경고; 모델허용; 하위Agent사용.
- 필드·표시 데이터: 기본역할; Workflow; 실행정책; 정의.
- 액션·결과·이동: 새 Task 기본 Agent만 변경 / 기존 Task 개요 유지 / Workflow 단계 안내 / 하위 Agent 관리 패널 표시.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0340 | 2400 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.agent}} |
| EV-0341 | 2401 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.agent}} |

### UI-12-02A — 실행 정책·모델 (패널)

- 출처: [원본 2407–2433](../../prototype/uiux/Main.dc.html#L2407); 로직 6760-6781.
- 진입: 설정 Agent 실행 정책.
- 상태: 신규미허용/허용; 최소1개; 팀장고정; 반복재작업알림.
- 필드·표시 데이터: models id/label/rank/allowed/fresh; efforts; onUsage/lowPct/onRework/escNotify/floors.
- 액션·결과·이동: 마지막 허용 모델 해제 거부 / 허용 변경은 미착수 Task 등급 재판단 / 사용량 대기/하향·기준10/20/30 선택 / 재작업 same/up1/top 선택 / 최저선·알림횟수 반영 / 고정 Task 링크 이동.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0342 | 2417 | onclick {{m.toggle}} | {{m.toggleL}} | {{isSettings}} ∧ {{cfg.tab.agent}} |
| EV-0343 | 2424 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.agent}} |
| EV-0344 | 2425 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.agent}} ∧ {{cfg.ex.isDown}} |
| EV-0345 | 2426 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.agent}} |
| EV-0346 | 2428 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.agent}} |
| EV-0347 | 2429 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.agent}} |
| EV-0348 | 2430 | onclick {{lk.open}} | {{lk.id}} {{lk.title}} | {{isSettings}} ∧ {{cfg.tab.agent}} ∧ {{cfg.ex.hasLocked}} |
| EV-0349 | 2431 | onclick {{al.open}} | 실행 보기 | {{isSettings}} ∧ {{cfg.tab.agent}} ∧ {{cfg.ex.hasAlerts}} |
| EV-0350 | 2431 | onclick {{al.done}} | 확인 | {{isSettings}} ∧ {{cfg.tab.agent}} ∧ {{cfg.ex.hasAlerts}} |

### UI-12-02B — 하위 Agent 정의 (패널)

- 출처: [원본 2435–2450](../../prototype/uiux/Main.dc.html#L2435); 로직 3472-3496.
- 진입: 설정 Agent 하위 Agent.
- 상태: 전체 사용/중지; 정의허용/해제; 지시문접힘/펼침.
- 필드·표시 데이터: 10정의 id/agent/role/tools/sandbox/v/hash/text/ref/allowed; 지정수/마지막사용/재작업률.
- 액션·결과·이동: 지시문 펼침 / 정의 허용 해제 시 Task 지정 재판단 / 전체 끄기는 지정 기록 유지하고 기본 Agent 실행 / 외부 참고 링크 제공 / 실제 설치는 worktree 한정 Runner 작업.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0351 | 2438 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.agent}} |
| EV-0352 | 2443 | onclick {{x.toggleOpen}} | {{x.openL}} | {{isSettings}} ∧ {{cfg.tab.agent}} |
| EV-0353 | 2443 | onclick {{x.toggle}} | {{x.tgL}} | {{isSettings}} ∧ {{cfg.tab.agent}} |

### UI-12-03 — 일정·Task (탭)

- 출처: [원본 2451–2510](../../prototype/uiux/Main.dc.html#L2451); 로직 6701-6709.
- 진입: 설정 일정·Task 탭.
- 상태: 분할 위반/없음; 자동정책 켜짐/꺼짐.
- 필드·표시 데이터: 분할/일정 정책/작업불가일/진행가중치.
- 액션·결과·이동: 3개 영역과 분할 배지 표시.

### UI-12-03A — Task 분할 기준 (패널)

- 출처: [원본 2452–2473](../../prototype/uiux/Main.dc.html#L2452); 로직 3509-3520.
- 진입: 설정 일정·Task 분할.
- 상태: 규칙 on/off; 위반 없음/있음.
- 필드·표시 데이터: maxH/minH/maxFiles/testIn/dir/on 10규칙.
- 액션·결과·이동: 상한·하한·파일 상한 변경 후 점검 갱신 / 10규칙별 사용 토글 / 테스트 포함·계층별 계약먼저 고정 표시 / 위반 Task 링크는 개요 분할 점검으로 이동.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0354 | 2457 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.plan}} |
| EV-0355 | 2458 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.plan}} |
| EV-0356 | 2459 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.plan}} |
| EV-0357 | 2466 | onclick {{r.toggle}} | {{r.tgL}} | {{isSettings}} ∧ {{cfg.tab.plan}} |
| EV-0358 | 2472 | onclick {{f.open}} | {{f.id}} | {{isSettings}} ∧ {{cfg.tab.plan}} ∧ {{cfg.spl.hasFlag}} |

### UI-12-03B — 일정 정책·작업 불가일 (패널)

- 출처: [원본 2474–2493](../../prototype/uiux/Main.dc.html#L2474); 로직 6225-6234.
- 진입: 설정 일정·Task 일정 정책.
- 상태: 자동재조정/CP자동 on/off; 날짜중복/형식오류; 불가일없음.
- 필드·표시 데이터: autoReplan/cpAuto/threshold/assumeRate; blackout date/note.
- 액션·결과·이동: 정책 선택 저장 / 불가일 추가는 날짜 필수·형식·중복 검증 / 해제 후 목록/일정 재계산 / 초기가동률은 기록72시간 미만에 적용.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0359 | 2478 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.plan}} |
| EV-0360 | 2479 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.plan}} |
| EV-0361 | 2480 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.plan}} |
| EV-0362 | 2481 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.plan}} |
| EV-0363 | 2486 | onclick {{b.del}} | 해제 | {{isSettings}} ∧ {{cfg.tab.plan}} |
| EV-0364 | 2489 | onchange {{cfg.onBoDate}} | YYYY-MM-DD | {{isSettings}} ∧ {{cfg.tab.plan}} |
| EV-0365 | 2489 | onchange {{cfg.onBoNote}} | 사유 (선택) | {{isSettings}} ∧ {{cfg.tab.plan}} |
| EV-0366 | 2489 | onclick {{cfg.addBo}} | 추가 | {{isSettings}} ∧ {{cfg.tab.plan}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 2489 | input | {{cfg.bo.date}} | {"placeholder": "YYYY-MM-DD"} |
| 2489 | input | {{cfg.bo.note}} | {"placeholder": "사유 (선택)"} |

### UI-12-03C — 일정·진행률 기준 (패널)

- 출처: [원본 2494–2510](../../prototype/uiux/Main.dc.html#L2494); 로직 3395-3398.
- 진입: 설정 일정·Task 읽기 설명.
- 상태: 읽기 전용.
- 필드·표시 데이터: 상태별 STAGE_PCT; 일정 기준 문구.
- 액션·결과·이동: 상태별 0/20/35/40/50/65/80/90/100 가중치 표시 / 진행률과 완료율 차이 설명 / 고정 최대5개 문구는 폐기된 불일치.

### UI-12-04 — 보고서·메일 (탭)

- 출처: [원본 2511–2581](../../prototype/uiux/Main.dc.html#L2511); 로직 6495-6532.
- 진입: 설정 보고서·메일; 메일실패 알림.
- 상태: SMTP미설정/정상/실패; 수신자/기록 없음.
- 필드·표시 데이터: recips/smtp/log; 실패배지.
- 액션·결과·이동: 수신자·SMTP·발송 기록 3영역 표시 / 실패/미설정 배너.

### UI-12-04A — 메일 수신자 (패널)

- 출처: [원본 2512–2541](../../prototype/uiux/Main.dc.html#L2512); 로직 4933-4948.
- 진입: 설정 보고서·메일.
- 상태: 구독/중지; 없음; 형식/중복/미구독 오류.
- 필드·표시 데이터: email/name/daily/weekly/view/pdf/active/at/last.
- 액션·결과·이동: 이메일 형식·대소문자무시 중복·구독1개이상 검증 / 일간/주간 모두 해제하면 중지 / 보기/PDF/받는중 변경 / 테스트·미리보기 / 삭제해도 발송 이력 유지.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0367 | 2522 | onclick {{rc.tDaily}} | 일간 | {{isSettings}} ∧ {{cfg.tab.report}} |
| EV-0368 | 2523 | onclick {{rc.tWeekly}} | 주간 | {{isSettings}} ∧ {{cfg.tab.report}} |
| EV-0369 | 2524 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.report}} |
| EV-0370 | 2525 | onchange {{rc.tPdf}} | PDF 첨부 | {{isSettings}} ∧ {{cfg.tab.report}} |
| EV-0371 | 2528 | onclick {{rc.pv}} | 미리보기 | {{isSettings}} ∧ {{cfg.tab.report}} |
| EV-0372 | 2528 | onclick {{rc.test}} | {{rc.bTest.l}} | {{isSettings}} ∧ {{cfg.tab.report}} ∧ disabled={{rc.bTest.dis}} |
| EV-0373 | 2528 | onclick {{rc.tAct}} | {{rc.actBtn}} | {{isSettings}} ∧ {{cfg.tab.report}} ∧ disabled={{rc.actDis}} |
| EV-0374 | 2528 | onclick {{rc.del}} | 삭제 | {{isSettings}} ∧ {{cfg.tab.report}} |
| EV-0375 | 2533 | onchange {{cfg.mail.fm.onEmail}} | name@example.com | {{isSettings}} ∧ {{cfg.tab.report}} |
| EV-0376 | 2534 | onchange {{cfg.mail.fm.onName}} | 예: 상급자 (주간보고) | {{isSettings}} ∧ {{cfg.tab.report}} |
| EV-0377 | 2535 | onclick {{cfg.mail.fm.tDaily}} | 일간 (매일 07:00) | {{isSettings}} ∧ {{cfg.tab.report}} |
| EV-0378 | 2535 | onclick {{cfg.mail.fm.tWeekly}} | 주간 (월 07:00) | {{isSettings}} ∧ {{cfg.tab.report}} |
| EV-0379 | 2536 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.report}} |
| EV-0380 | 2537 | onchange {{cfg.mail.fm.tPdf}} | input | {{isSettings}} ∧ {{cfg.tab.report}} |
| EV-0381 | 2539 | onclick {{cfg.mail.fm.add}} | 받는 사람 추가 | {{isSettings}} ∧ {{cfg.tab.report}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 2525 | input | {{rc.pdf}} | {"type": "checkbox", "aria-label": "PDF 첨부"} |
| 2533 | input | {{cfg.mail.fm.email}} | {"type": "email", "placeholder": "name@example.com"} |
| 2534 | input | {{cfg.mail.fm.name}} | {"placeholder": "예: 상급자 (주간보고)"} |
| 2537 | input | {{cfg.mail.fm.pdf}} | {"type": "checkbox"} |

### UI-12-04B — SMTP 보기·편집 (편집기)

- 출처: [원본 2542–2566](../../prototype/uiux/Main.dc.html#L2542); 로직 4949-4966.
- 진입: 설정 보고서·메일 수정/SMTP설정.
- 상태: 보기/편집; 미설정; 형식오류; 535실패; 연결중.
- 필드·표시 데이터: host/port/sec/from/user/pwSet; pw 쓰기전용.
- 액션·결과·이동: 서버·포트1~65535·보내는주소 검사 / 비밀번호 입력은 저장 후 재노출 안 함 / 저장 후 연결상태 미확인 / 연결 확인/수정/취소 / Mock 인증실패·복구.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0382 | 2552 | onclick {{cfg.mail.smtp.check}} | {{cfg.mail.smtp.bCheck.l}} | {{isSettings}} ∧ {{cfg.tab.report}} ∧ {{cfg.mail.view}} ∧ disabled={{cfg.mail.smtp.bCheck.dis}} |
| EV-0383 | 2552 | onclick {{cfg.mail.smtp.editOpen}} | 수정 | {{isSettings}} ∧ {{cfg.tab.report}} ∧ {{cfg.mail.view}} |
| EV-0384 | 2552 | onclick {{cfg.mail.smtp.brk}} | SMTP 인증 실패 | {{isSettings}} ∧ {{cfg.tab.report}} ∧ {{cfg.mail.view}} |
| EV-0385 | 2552 | onclick {{cfg.mail.smtp.fix}} | 정상 복구 | {{isSettings}} ∧ {{cfg.tab.report}} ∧ {{cfg.mail.view}} |
| EV-0386 | 2554 | onclick {{cfg.mail.smtp.editOpen}} | SMTP 설정 | {{isSettings}} ∧ {{cfg.tab.report}} ∧ {{cfg.mail.noCfg}} |
| EV-0387 | 2557 | onchange {{cfg.mail.f.onHost}} | smtp.example.com | {{isSettings}} ∧ {{cfg.tab.report}} ∧ {{cfg.mail.edit}} |
| EV-0388 | 2558 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.report}} ∧ {{cfg.mail.edit}} |
| EV-0389 | 2558 | onchange {{cfg.mail.f.onPort}} | 포트 | {{isSettings}} ∧ {{cfg.tab.report}} ∧ {{cfg.mail.edit}} |
| EV-0390 | 2559 | onchange {{cfg.mail.f.onFrom}} | Agent WBS <agent-wbs@example.com> | {{isSettings}} ∧ {{cfg.tab.report}} ∧ {{cfg.mail.edit}} |
| EV-0391 | 2560 | onchange {{cfg.mail.f.onUser}} | 비워 두면 인증 없이 보냄 (사내 릴레이) | {{isSettings}} ∧ {{cfg.tab.report}} ∧ {{cfg.mail.edit}} |
| EV-0392 | 2561 | onchange {{cfg.mail.f.onPw}} | input | {{isSettings}} ∧ {{cfg.tab.report}} ∧ {{cfg.mail.edit}} |
| EV-0393 | 2563 | onclick {{cfg.mail.f.cancel}} | 취소 | {{isSettings}} ∧ {{cfg.tab.report}} ∧ {{cfg.mail.edit}} |
| EV-0394 | 2563 | onclick {{cfg.mail.f.save}} | 저장 | {{isSettings}} ∧ {{cfg.tab.report}} ∧ {{cfg.mail.edit}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 2557 | input | {{cfg.mail.f.host}} | {"placeholder": "smtp.example.com"} |
| 2558 | input | {{cfg.mail.f.port}} | {"aria-label": "포트"} |
| 2559 | input | {{cfg.mail.f.from}} | {"placeholder": "Agent WBS <agent-wbs@example.com>"} |
| 2560 | input | {{cfg.mail.f.user}} | {"placeholder": "비워 두면 인증 없이 보냄 (사내 릴레이)"} |
| 2561 | input | {{cfg.mail.f.pw}} | {"type": "password"} |

### UI-12-04C — 메일 발송 기록 (패널)

- 출처: [원본 2567–2581](../../prototype/uiux/Main.dc.html#L2567); 로직 4967-4987.
- 진입: 설정 보고서·메일.
- 상태: 전체/실패만; 없음; 미해결 실패.
- 필드·표시 데이터: id/at/rep/rid/to/view/pdf/subject/st/err/why.
- 액션·결과·이동: 보고서/메일 미리보기 링크 / 행별·실패전체 다시 보내기는 새 발송 기록 / 수신자/보고서 삭제 시 재발송 거부 / 성공 이후 배지·알림 해제 / 자동15분 재시도는 실제 서버 필요.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0395 | 2568 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.report}} |
| EV-0396 | 2569 | onclick {{cfg.mail.resendAll}} | {{cfg.mail.bAll.l}} | {{isSettings}} ∧ {{cfg.tab.report}} ∧ {{cfg.mail.hasPend}} ∧ disabled={{cfg.mail.bAll.dis}} |
| EV-0397 | 2576 | onclick {{lg.pv}} | 메일 보기 | {{isSettings}} ∧ {{cfg.tab.report}} ∧ {{lg.canPv}} |
| EV-0398 | 2576 | onclick {{lg.retry}} | {{lg.bRetry.l}} | {{isSettings}} ∧ {{cfg.tab.report}} ∧ {{lg.canRetry}} ∧ disabled={{lg.bRetry.dis}} |

### UI-12-05 — 알림 (탭)

- 출처: [원본 2582–2645](../../prototype/uiux/Main.dc.html#L2582); 로직 6605-6646.
- 진입: 설정 알림; Telegram 실패 알림.
- 상태: 설정전/확인필요/테스트성공/401/400/403/통신/429.
- 필드·표시 데이터: Telegram conf/rules/log; 접속URL.
- 액션·결과·이동: 연결·규칙·미리보기·접속주소·이력 구분 / 전송 실패가 Task 실행에 영향 없음 / 실제 API 미호출 Mock 배너.

### UI-12-05A — Telegram 연결 설정 (편집기)

- 출처: [원본 2584–2607](../../prototype/uiux/Main.dc.html#L2584); 로직 6553-6592.
- 진입: 설정 알림.
- 상태: 토큰 keep/replace; 봇 none/ok/err; test none/ok/fail; on/off.
- 필드·표시 데이터: tokenSet/last4; token 쓰기전용; bot/target/chatId/chat/test.
- 액션·결과·이동: 가상 토큰→봇확인→수신대상→테스트→켜기→저장 흐름 / 전화번호/@사용자명 거부·음수 Chat ID 허용 / 토큰/Chat ID 변경 시 테스트 초기화, 이름만 변경 시 유지 / 테스트 성공 전 켜기 거부 / 마스킹값/빈 교체토큰 저장 거부 / 변경/교체 취소.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0399 | 2587 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.notify}} |
| EV-0400 | 2591 | onclick {{cfg.tg.toRep}} | 토큰 교체 | {{isSettings}} ∧ {{cfg.tab.notify}} ∧ {{cfg.tg.tokKeep}} |
| EV-0401 | 2592 | onchange {{cfg.tg.onToken}} | Bot Token | {{isSettings}} ∧ {{cfg.tab.notify}} ∧ {{cfg.tg.tokRep}} |
| EV-0402 | 2592 | onclick {{cfg.tg.fillMock}} | 가상 토큰 채우기 | {{isSettings}} ∧ {{cfg.tab.notify}} ∧ {{cfg.tg.tokRep}} |
| EV-0403 | 2592 | onclick {{cfg.tg.toKeep}} | 교체 취소 (등록 토큰 유지) | {{isSettings}} ∧ {{cfg.tab.notify}} ∧ {{cfg.tg.tokRep}} ∧ {{cfg.tg.canCancelRep}} |
| EV-0404 | 2594 | onclick {{cfg.tg.checkBot}} | {{cfg.tg.bBot.l}} | {{isSettings}} ∧ {{cfg.tab.notify}} ∧ disabled={{cfg.tg.bBot.dis}} |
| EV-0405 | 2595 | onchange {{cfg.tg.onTarget}} | 예: 팀장 개인 알림 | {{isSettings}} ∧ {{cfg.tab.notify}} |
| EV-0406 | 2596 | onchange {{cfg.tg.onChat}} | Chat ID | {{isSettings}} ∧ {{cfg.tab.notify}} |
| EV-0407 | 2596 | onclick {{cfg.tg.find}} | 수신 대상 찾기 | {{isSettings}} ∧ {{cfg.tab.notify}} |
| EV-0408 | 2600 | onclick {{cfg.tg.test}} | {{cfg.tg.bTest.l}} | {{isSettings}} ∧ {{cfg.tab.notify}} ∧ disabled={{cfg.tg.bTest.dis}} |
| EV-0409 | 2603 | onclick {{cfg.tg.setOn}} | 켜기 | {{isSettings}} ∧ {{cfg.tab.notify}} ∧ disabled={{cfg.tg.onDis}} |
| EV-0410 | 2603 | onclick {{cfg.tg.setOff}} | 끄기 | {{isSettings}} ∧ {{cfg.tab.notify}} |
| EV-0411 | 2605 | onclick {{cfg.tg.fresh}} | Mock: 처음 설정 상태로 | {{isSettings}} ∧ {{cfg.tab.notify}} |
| EV-0412 | 2605 | onclick {{cfg.tg.cancel}} | 변경 취소 | {{isSettings}} ∧ {{cfg.tab.notify}} ∧ disabled={{cfg.tg.clean}} |
| EV-0413 | 2605 | onclick {{cfg.tg.save}} | 연결 설정 저장 | {{isSettings}} ∧ {{cfg.tab.notify}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 2592 | input | {{cfg.tg.token}} | {"type": "password", "placeholder": "000000000:MOCK_TOKEN_DO_NOT_USE_…", "aria-label": "Bot Token"} |
| 2595 | input | {{cfg.tg.target}} | {"placeholder": "예: 팀장 개인 알림"} |
| 2596 | input | {{cfg.tg.chatId}} | {"placeholder": "예: 512345678 · 그룹 -4123456789", "aria-label": "Chat ID"} |

### UI-12-05B — Telegram 규칙·미리보기 (패널)

- 출처: [원본 2608–2620](../../prototype/uiux/Main.dc.html#L2608); 로직 6598-6601.
- 진입: 설정 알림.
- 상태: 이벤트 enabled/disabled; 저장전 수정.
- 필드·표시 데이터: done/fail/admin/approve/buildOk/buildFail; pvMsg.
- 액션·결과·이동: 규칙6종 토글 후 저장/취소 / 꺼진 이벤트 미리보기에 경고 / 고정 일반텍스트·확정상태·미확정원인 표시 / 업무알림은 상태전이에서 발생하고 같은원인은 해소 전 중복생략.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0414 | 2611 | onchange {{r.toggle}} | input | {{isSettings}} ∧ {{cfg.tab.notify}} |
| EV-0415 | 2613 | onclick {{cfg.tg.ruleCancel}} | 변경 취소 | {{isSettings}} ∧ {{cfg.tab.notify}} ∧ disabled={{cfg.tg.rClean}} |
| EV-0416 | 2613 | onclick {{cfg.tg.ruleSave}} | 규칙 저장 | {{isSettings}} ∧ {{cfg.tab.notify}} ∧ disabled={{cfg.tg.rClean}} |
| EV-0417 | 2616 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.notify}} |
| EV-0418 | 2619 | onclick {{cfg.tg.pvGo}} | WBS에서 확인 | {{isSettings}} ∧ {{cfg.tab.notify}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 2611 | input | {{r.on}} | {"type": "checkbox"} |

### UI-12-05C — 공용 접속 주소 (편집기)

- 출처: [원본 2621–2626](../../prototype/uiux/Main.dc.html#L2621); 로직 6602-6604.
- 진입: 설정 알림.
- 상태: 빈주소/HTTP(S)/형식오류/localhost경고.
- 필드·표시 데이터: appUrl.
- 액션·결과·이동: 잘못된 URL 저장 거부 / localhost/127.0.0.1 경고 / 빈 값은 메일·Telegram 링크 생략 / 저장 주소가 두 채널에 공통 적용.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0419 | 2623 | onchange {{cfg.tg.onUrl}} | 예: http://192.168.0.10:5173 | {{isSettings}} ∧ {{cfg.tab.notify}} |
| EV-0420 | 2623 | onclick {{cfg.tg.urlSave}} | 저장 | {{isSettings}} ∧ {{cfg.tab.notify}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 2623 | input | {{cfg.tg.url}} | {"placeholder": "예: http://192.168.0.10:5173"} |

### UI-12-05D — Telegram 전송 이력·상세 (패널)

- 출처: [원본 2627–2645](../../prototype/uiux/Main.dc.html#L2627); 로직 6605-6646.
- 진입: 설정 알림 이력 행.
- 상태: 전체/업무/테스트; 없음; 대기/수락/실패/재시도대기.
- 필드·표시 데이터: at/proj/target/ev/to/st/tries/err/kind/dup/msg/nav.
- 액션·결과·이동: 행 선택 시 실제 보낼 메시지 표시 / WBS에서 확인은 Task/CP/CI/설정/프로젝트/설계로 이동 / 수락은 읽음·도착으로 표시하지 않음 / 전송 이력에 토큰 미노출.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0421 | 2628 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.notify}} |
| EV-0422 | 2632 | onclick {{lg.pick}} | div | {{isSettings}} ∧ {{cfg.tab.notify}} |
| EV-0423 | 2639 | onclick {{cfg.tg.sel.go}} | WBS에서 확인 | {{isSettings}} ∧ {{cfg.tab.notify}} ∧ {{cfg.tg.sel.has}} ∧ {{cfg.tg.sel.canGo}} |
| EV-0424 | 2639 | onclick {{cfg.tg.sel.close}} | 닫기 | {{isSettings}} ∧ {{cfg.tab.notify}} ∧ {{cfg.tg.sel.has}} |

### UI-12-06 — 점검·Prototype (탭)

- 출처: [원본 2646–2673](../../prototype/uiux/Main.dc.html#L2646); 로직 6647-6666.
- 진입: 설정 점검·Prototype.
- 상태: 점검전/결과; 화면·오류 주입.
- 필드·표시 데이터: integrity 결과; IMPL; 미리보기/로딩토글.
- 액션·결과·이동: 정합성 점검 결과 항목·상세 표시 / 구현/Mock/제한을 구분 / 미리보기는 제품 인수 대상 업무기능이 아닌 재현 도구.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0425 | 2648 | onclick {{cfg.runCheck}} | 점검 실행 | {{isSettings}} ∧ {{cfg.tab.system}} |

### UI-12-06A — 화면·오류 상태 미리보기 (패널)

- 출처: [원본 2665–2673](../../prototype/uiux/Main.dc.html#L2665); 로직 4600-4643.
- 진입: 설정 점검·Prototype.
- 상태: 일반9상태; 오류21종; 로딩on/off.
- 필드·표시 데이터: _pv/_pvE; fault/load/pdfFail/subFail.
- 액션·결과·이동: 9개 일반 상태와 21개 오류 진입을 모두 식별 / 저장오류4종은 다음1회 저장에 적용 / 불러오기 오류는 현재 메뉴 적용 / 미리보기 후 각 화면 빈/잠금/오류 상태 재현.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0426 | 2667 | onclick {{x.pick}} | {{x.l}} {{x.d}} | {{isSettings}} ∧ {{cfg.tab.system}} |
| EV-0427 | 2668 | onclick {{o.pick}} | {{o.l}} | {{isSettings}} ∧ {{cfg.tab.system}} |
| EV-0428 | 2670 | onclick {{x.pick}} | {{x.l}} {{x.d}} | {{isSettings}} ∧ {{cfg.tab.system}} |

### UI-13 — 미구현 메뉴 대체 화면 (대체화면)

- 출처: [원본 2678–2688](../../prototype/uiux/Main.dc.html#L2678); 로직 7053-7068.
- 진입: isOther 분기; 현재 NAV 정상값에서는 진입 없음.
- 상태: 제작예정.
- 필드·표시 데이터: pg.title/desc/phase/items.
- 액션·결과·이동: 제작 예정과 설명 및 WBS 이동 표시 / 현재 메뉴12개는 별도 구현되어 도달 불가 대체분기임을 구분.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0429 | 2685 | onclick {{goWbs}} | WBS로 이동 | {{isOther}} |

### SYS-01 — 페이지 로딩·전역 갱신 (공통상태)

- 출처: [원본 674–702](../../prototype/uiux/Main.dc.html#L674); 로직 6814-6881.
- 진입: 첫메뉴/재방문/필터/재계산; loading/loaderr 주입.
- 상태: 스켈레톤/상단바/흐림/영역로딩/503오류.
- 필드·표시 데이터: SKELETON 메뉴별 배열; lastL; busy.
- 액션·결과·이동: 첫 메뉴는 배치별 skeleton / 재방문·필터는 이전화면과 상단바 / 재계산은 흐림·클릭차단 / 503은 마지막 성공시각·원인·재시도 / 응답시간은 Mock이고 제품은 실제 응답 기준.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0007 | 698 | onclick {{sys.retry}} | 다시 시도 | {{sys.show}} ∧ {{sys.error}} |

### SYS-02 — 저장 오류 막대 (공통상태)

- 출처: [원본 676–683](../../prototype/uiux/Main.dc.html#L676); 로직 5017-5051.
- 진입: 저장 실패 주입 후 변경.
- 상태: 500/네트워크/400; 409는 MOD-01.
- 필드·표시 데이터: title/code/msg/label/at; fault.
- 액션·결과·이동: 실패 시 데이터 미반영·입력유지 / 500/네트워크 재시도 / 400은 입력수정 안내와 재시도없음 / 닫기·주입해제 제공.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0004 | 676 | onclick {{clearFault}} | 주입 해제 | {{faultArmed}} |
| EV-0005 | 681 | onclick {{err.retry}} | 다시 시도 | {{err.show}} ∧ {{err.canRetry}} |
| EV-0006 | 681 | onclick {{err.close}} | 닫기 | {{err.show}} |

### SYS-03 — Toast 알림 (공통상태)

- 출처: [원본 2897–2899](../../prototype/uiux/Main.dc.html#L2897); 로직 5017-5036.
- 진입: 변경·안내 후 notice.
- 상태: 표시/없음.
- 필드·표시 데이터: noticeText.
- 액션·결과·이동: role=status로 안내 표시 / 데이터 변경 결과를 Toast만으로 대체하지 않음.

### MOD-01 — 동시 수정 충돌 (모달)

- 출처: [원본 2692–2704](../../prototype/uiux/Main.dc.html#L2692); 로직 6844-6865.
- 진입: 409 VERSION_CONFLICT.
- 상태: 충돌.
- 필드·표시 데이터: 먼저 저장된 변경/내변경/시각.
- 액션·결과·이동: 내 변경 버리고 최신 불러오기 또는 내 변경 다시 적용 선택 / 프로토타입의 실제 버전비교 미구현은 MM 참조.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0430 | 2701 | onclick {{err.reload}} | 최신 내용 불러오기 (내 변경 버림) | {{err.conflict}} |
| EV-0431 | 2701 | onclick {{err.reapply}} | 최신 내용에 내 변경 다시 적용 | {{err.conflict}} |

### MOD-02 — Telegram 수신 대상 찾기 (모달)

- 출처: [원본 2705–2724](../../prototype/uiux/Main.dc.html#L2705); 로직 6593-6597.
- 진입: 설정 알림 수신 대상 찾기.
- 상태: guide/loading/list/empty/webhook; 후보선택.
- 필드·표시 데이터: res/cands/pick; 후보 name/type/id/at.
- 액션·결과·이동: 후보 자동선택 안 함 / 선택 후 연결 입력만 채우고 저장하지 않음 / 빈결과 재시도 안내 / Webhook은 자동해제 안 하고 직접입력 경로 / 취소/닫기.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0432 | 2708 | onclick {{tgf.close}} | 닫기 | {{tgf.open}} |
| EV-0433 | 2715 | onclick {{o.pick}} | {{o.l}} | {{tgf.open}} |
| EV-0434 | 2717 | onclick {{c.pick}} | div | {{tgf.open}} ∧ {{tgf.list}} |
| EV-0435 | 2717 | onchange {{c.pick}} | {{c.name}} | {{tgf.open}} ∧ {{tgf.list}} |
| EV-0436 | 2719 | onclick {{tgf.manual}} | Chat ID 직접 입력 | {{tgf.open}} ∧ {{tgf.webhook}} |
| EV-0437 | 2721 | onclick {{tgf.close}} | 닫기 | {{tgf.open}} |
| EV-0438 | 2721 | onclick {{tgf.query}} | {{tgf.bQuery.l}} | {{tgf.open}} ∧ disabled={{tgf.bQuery.dis}} |
| EV-0439 | 2721 | onclick {{tgf.use}} | 이 대화 선택 | {{tgf.open}} ∧ disabled={{tgf.noPick}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 2717 | input | {{c.sel}} | {"type": "radio", "aria-label": "{{c.name}}"} |

### MOD-03 — 메일 미리보기 (모달)

- 출처: [원본 2725–2743](../../prototype/uiux/Main.dc.html#L2725); 로직 6533-6541.
- 진입: 보고서·수신자·발송기록 미리보기.
- 상태: 팀장용/보고용; PDF 첨부 여부.
- 필드·표시 데이터: from/to/subject/attachment/view; iframe srcDoc.
- 액션·결과·이동: 실제 보낼 요약 HTML과 제목·수신·첨부 표시 / 보기 전환 / 스크립트없는 iframe sandbox 표시 / 닫기.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0440 | 2728 | onclick {{mp.close}} | 닫기 | {{mp.open}} |
| EV-0441 | 2736 | onclick {{o.pick}} | {{o.l}} | {{mp.open}} ∧ {{mp.canToggle}} |
| EV-0442 | 2740 | onclick {{mp.close}} | 닫기 | {{mp.open}} |

### MOD-04 — 메일로 보내기 (모달)

- 출처: [원본 2744–2761](../../prototype/uiux/Main.dc.html#L2744); 로직 6542-6552.
- 진입: 보고서 메일로 보내기.
- 상태: 수신자없음/선택됨; SMTP상태; 오류/발송중.
- 필드·표시 데이터: report/recipientIds/view.
- 액션·결과·이동: 해당 종류 활성 구독자 기본 선택 / 0명 제출 거부 / 일간은 팀장용 고정 / 주간/기간은 수신자기본/모두팀장/모두보고 / 추가 설정 링크와 발송후 기록.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0443 | 2747 | onclick {{ms.close}} | 닫기 | {{ms.open}} |
| EV-0444 | 2752 | onclick {{ms.goSet}} | 설정 → 보고서 · 메일에서 추가 | {{ms.open}} ∧ {{ms.noRecips}} |
| EV-0445 | 2753 | onchange {{x.toggle}} | input | {{ms.open}} |
| EV-0446 | 2754 | onclick {{o.pick}} | {{o.l}} | {{ms.open}} ∧ {{ms.notDaily}} |
| EV-0447 | 2758 | onclick {{ms.close}} | 취소 | {{ms.open}} |
| EV-0448 | 2758 | onclick {{ms.send}} | {{ms.bSend.l}} | {{ms.open}} ∧ disabled={{ms.bSend.dis}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 2753 | input | {{x.on}} | {"type": "checkbox"} |

### MOD-05 — 프로젝트 초기화 (모달)

- 출처: [원본 2762–2784](../../prototype/uiux/Main.dc.html#L2762); 로직 4694-4725.
- 진입: 프로젝트 초기화; 등록취소.
- 상태: 이름불일치; 설정유지/삭제; Runner오프라인; 처리중.
- 필드·표시 데이터: 삭제건수; Runner정리항목; keep; confirmName; export.
- 액션·결과·이동: 삭제영향과 제외항목 표시 / 정확한 프로젝트명 입력 전 초기화 거부 / 선택 JSON 내보내기 / 초기화 시 epoch+1·등록전 복귀 / 오프라인은 정리대기·재연결시 먼저정리 / 실제 저장소되돌림은 Runner 필요.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0449 | 2765 | onclick {{su.rs.close}} | 닫기 | {{su.rs.open}} |
| EV-0450 | 2775 | onclick {{o.pick}} | {{o.l}} | {{su.rs.open}} |
| EV-0451 | 2776 | onclick {{su.rs.exp}} | 데이터 내보내기 (선택) | {{su.rs.open}} |
| EV-0452 | 2777 | onchange {{su.rs.onConfirm}} | {{su.rs.name}} | {{su.rs.open}} |
| EV-0453 | 2781 | onclick {{su.rs.close}} | 취소 | {{su.rs.open}} |
| EV-0454 | 2781 | onclick {{su.rs.run}} | {{su.rs.bRun.l}} | {{su.rs.open}} ∧ disabled={{su.rs.runDis}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 2777 | input | {{su.rs.confirm}} | {"placeholder": "{{su.rs.name}}"} |

### MOD-06 — Task 생성 Wizard (모달)

- 출처: [원본 2785–2847](../../prototype/uiux/Main.dc.html#L2785); 로직 6782-6813.
- 진입: WBS Task 생성.
- 상태: 1~3단계; 필수오류; 취소확인.
- 필드·표시 데이터: Task 기본/목적/선행 선택.
- 액션·결과·이동: 이전/다음과 단계별 필수 검증 / 제목·목적 입력 뒤 닫기는 취소확인 / 생성은 고유 Task ID·WBS 배치·초기 planning·이력·일정 생성 / 생성 후 작업명세 탭 열림.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0455 | 2788 | onclick {{closeWiz}} | Task 생성 닫기 | {{wizOpen}} |
| EV-0472 | 2841 | onclick {{closeWiz}} | 취소 | {{wizOpen}} |
| EV-0473 | 2842 | onclick {{wizPrev}} | 이전 | {{wizOpen}} ∧ disabled={{wz.s1}} |
| EV-0474 | 2843 | onclick {{wizNext}} | {{wz.nextL}} | {{wizOpen}} |

### MOD-06A — Task 생성 1 기본정보 (단계)

- 출처: [원본 2791–2803](../../prototype/uiux/Main.dc.html#L2791); 로직 7013-7037.
- 진입: Wizard 첫단계.
- 상태: 필수검증오류.
- 필드·표시 데이터: title/wp/type/domain/rel/est/fixStart/priority/assignee/verifier.
- 액션·결과·이동: 제목·유형·주영역·시간 필수 / 시간0초과400이하 / 고정시작 YYYY-MM-DD / 관련영역 선택과 담당·검증 기본값.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0456 | 2793 | onchange {{wz.set.title}} | 예: Task 목록 조회 API 페이지네이션 | {{wizOpen}} ∧ {{wz.s1}} |
| EV-0457 | 2794 | onchange {{wz.set.wp}} | 1.1 개발 환경 1.2 데이터 모델 2.1 Task API 2.2 WBS UI 3.1 Planning · Gate 3.2 Runner 연동 | {{wizOpen}} ∧ {{wz.s1}} |
| EV-0458 | 2795 | onclick {{o.pick}} | {{o.l}} {{o.en}} | {{wizOpen}} ∧ {{wz.s1}} |
| EV-0459 | 2796 | onclick {{o.pick}} | {{o.en}} {{o.l}} | {{wizOpen}} ∧ {{wz.s1}} |
| EV-0460 | 2797 | onclick {{o.pick}} | {{o.en}} | {{wizOpen}} ∧ {{wz.s1}} |
| EV-0461 | 2798 | onchange {{wz.set.est}} | input | {{wizOpen}} ∧ {{wz.s1}} |
| EV-0462 | 2799 | onchange {{wz.set.fixStart}} | YYYY-MM-DD | {{wizOpen}} ∧ {{wz.s1}} |
| EV-0463 | 2800 | onchange {{wz.set.priority}} | 긴급 높음 보통 낮음 | {{wizOpen}} ∧ {{wz.s1}} |
| EV-0464 | 2801 | onclick {{o.pick}} | {{o.l}} | {{wizOpen}} ∧ {{wz.s1}} |
| EV-0465 | 2801 | onclick {{o.pick}} | {{o.l}} | {{wizOpen}} ∧ {{wz.s1}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 2793 | input | {{wz.d.title}} | {"placeholder": "예: Task 목록 조회 API 페이지네이션"} |
| 2794 | select | {{wz.d.wp}} | {} |
| 2798 | input | {{wz.d.est}} | {} |
| 2799 | input | {{wz.d.fixStart}} | {"placeholder": "YYYY-MM-DD"} |
| 2800 | select | {{wz.d.priority}} | {} |

### MOD-06B — Task 생성 2 목적·범위 (단계)

- 출처: [원본 2805–2811](../../prototype/uiux/Main.dc.html#L2805); 로직 6787-6794.
- 진입: Wizard 다음.
- 상태: 목적·완료조건 필수.
- 필드·표시 데이터: purpose/background/scope/out/doneCond.
- 액션·결과·이동: 목적·완료조건 없으면 다음 차단 / 범위·제외는 줄단위 배열로 등록.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0466 | 2806 | onchange {{wz.set.purpose}} | 이 Task로 무엇을 가능하게 하는가 | {{wizOpen}} ∧ {{wz.s2}} |
| EV-0467 | 2807 | onchange {{wz.set.background}} | 왜 지금 필요한가 | {{wizOpen}} ∧ {{wz.s2}} |
| EV-0468 | 2808 | onchange {{wz.set.scope}} | 한 줄에 한 항목 | {{wizOpen}} ∧ {{wz.s2}} |
| EV-0469 | 2809 | onchange {{wz.set.out}} | 구현하지 않을 내용 — 한 줄에 한 항목 | {{wizOpen}} ∧ {{wz.s2}} |
| EV-0470 | 2810 | onchange {{wz.set.doneCond}} | 무엇이 확인되면 완료인가 | {{wizOpen}} ∧ {{wz.s2}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 2806 | textarea | {{wz.d.purpose}} | {"rows": "3", "placeholder": "이 Task로 무엇을 가능하게 하는가"} |
| 2807 | textarea | {{wz.d.background}} | {"rows": "2", "placeholder": "왜 지금 필요한가"} |
| 2808 | textarea | {{wz.d.scope}} | {"rows": "3", "placeholder": "한 줄에 한 항목"} |
| 2809 | textarea | {{wz.d.out}} | {"rows": "2", "placeholder": "구현하지 않을 내용 — 한 줄에 한 항목"} |
| 2810 | textarea | {{wz.d.doneCond}} | {"rows": "2", "placeholder": "무엇이 확인되면 완료인가"} |

### MOD-06C — Task 생성 3 선행·확인 (단계)

- 출처: [원본 2813–2836](../../prototype/uiux/Main.dc.html#L2813); 로직 6795-6813.
- 진입: Wizard 다음.
- 상태: 선행없음/선행미완료차단.
- 필드·표시 데이터: 선행Task; 생성예정ID/분류/Agent/설계섹션/일정.
- 액션·결과·이동: 선행 다중선택은 FS / 미완료 선행 선택 시 생성후 차단 안내 / 자동 ID와 상위WP·설계영역·초기상태 확인 후 생성.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0471 | 2817 | onchange {{p.toggle}} | input | {{wizOpen}} ∧ {{wz.s3}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 2817 | input | {{p.checked}} | {"type": "checkbox"} |

### MOD-07 — Change Proposal 작성 (모달)

- 출처: [원본 2849–2885](../../prototype/uiux/Main.dc.html#L2849); 로직 5764-5805.
- 진입: 새 변경 제안; 메시지 CP 작성.
- 상태: 행없음/필수오류/시뮬레이션문제; Diff.
- 필드·표시 데이터: title/reason/source; rows op/task/value; preview.
- 액션·결과·이동: 범위추가/완료조건/AC/우선순위/담당/선행추가·삭제 7유형 / 행추가·삭제 / 제목·사유·유효항목 필수 / 오류 있으면 제출차단 / 제출은 review이며 자동 WBS변경 아님.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0475 | 2852 | onclick {{cpm.close}} | 닫기 | {{cpmOpen}} |
| EV-0476 | 2856 | onchange {{cpm.onTitle}} | input | {{cpmOpen}} |
| EV-0477 | 2857 | onchange {{cpm.onReason}} | textarea | {{cpmOpen}} |
| EV-0478 | 2865 | onchange {{r.onType}} | 작업 범위 추가 완료 조건 변경 AC 추가 우선순위 변경 담당 Agent 변경 선행 Task 추가 선행 Task 삭제 | {{cpmOpen}} |
| EV-0479 | 2866 | onchange {{r.onTask}} | 대상 Task ID | {{cpmOpen}} |
| EV-0480 | 2867 | onchange {{r.onValue}} | 변경 값 | {{cpmOpen}} |
| EV-0481 | 2868 | onclick {{r.del}} | {{r.delL}} | {{cpmOpen}} |
| EV-0482 | 2872 | onclick {{cpm.add}} | + 항목 추가 | {{cpmOpen}} |
| EV-0483 | 2882 | onclick {{cpm.close}} | 취소 | {{cpmOpen}} |
| EV-0484 | 2882 | onclick {{cpm.submit}} | 제출 — 승인 요청 | {{cpmOpen}} |

| 입력 줄 | 종류 | 값·체크 바인딩 | 제약/힌트(원문 속성) |
|---:|---|---|---|
| 2856 | input | {{cpm.title}} | {} |
| 2857 | textarea | {{cpm.reason}} | {"rows": "3"} |
| 2865 | select | {{r.type}} | {"aria-label": "변경 유형"} |
| 2866 | input | {{r.task}} | {"aria-label": "대상 Task ID", "placeholder": "TASK-0000"} |
| 2867 | input | {{r.value}} | {"placeholder": "{{r.hint}}", "aria-label": "변경 값"} |

### MOD-08 — 공용 확인창 (모달)

- 출처: [원본 2887–2895](../../prototype/uiux/Main.dc.html#L2887); 로직 5052-5054.
- 진입: 삭제/완료/편집버리기/생성취소.
- 상태: 일반/위험.
- 필드·표시 데이터: cf.title/body/ok/okCls.
- 액션·결과·이동: 취소는 원동작 미실행 / 확인은 등록된 동작1회 수행 / 삭제·완료·편집버리기의 각 제목·영향설명 표시.

| 액션 ID | 원본 줄 | 이벤트·핸들러 | 컨트롤 문구 | 활성 조건 |
|---|---:|---|---|---|
| EV-0485 | 2892 | onclick {{cfCancel}} | 취소 | {{confirmOpen}} |
| EV-0486 | 2892 | onclick {{cfOk}} | {{cf.ok}} | {{confirmOpen}} |

## 모든 조건 분기 대조

`sc-if`는 원본 템플릿의 조건 분기다. 조건이 true일 때 해당 `sc-if` 하위 콘텐츠가 표시되고 false일 때 빠진다. 상위 조건이 false이면 하위는 진입하지 않는다. 정확한 상위 조건과 반복 별칭은 JSON 증거에 보존했다.

| 조건 ID | 화면 ID | 줄 | 원문 조건 |
|---|---|---:|---|
| CD-0001 | UI-00 | 668 | {{n.showLabel}} |
| CD-0002 | SYS-01 | 674 | {{bar.show}} |
| CD-0003 | SYS-01 | 675 | {{dim.show}} |
| CD-0004 | SYS-02 | 676 | {{faultArmed}} |
| CD-0005 | SYS-02 | 677 | {{err.show}} |
| CD-0006 | SYS-02 | 681 | {{err.canRetry}} |
| CD-0007 | SYS-01 | 684 | {{sys.show}} |
| CD-0008 | SYS-01 | 686 | {{sys.loading}} |
| CD-0009 | SYS-01 | 692 | {{sys.error}} |
| CD-0010 | UI-02A | 703 | {{isSetup}} |
| CD-0011 | UI-02A | 705 | {{su.cleanup}} |
| CD-0012 | UI-02A | 706 | {{su.isNone}} |
| CD-0013 | UI-02A | 714 | {{su.reg.ghOk}} |
| CD-0014 | UI-02A | 715 | {{su.reg.hasChk}} |
| CD-0015 | UI-02A | 716 | {{su.reg.hasSt}} |
| CD-0016 | UI-02A | 717 | {{su.reg.hasMd}} |
| CD-0017 | UI-02A | 722 | {{tc.isCond}} |
| CD-0018 | UI-02A | 726 | {{su.reg.hasErr}} |
| CD-0019 | UI-02A | 727 | {{su.reg.bCheck.busy}} |
| CD-0020 | UI-02A | 727 | {{su.reg.bSubmit.busy}} |
| CD-0021 | UI-02A | 743 | {{su.hasResets}} |
| CD-0022 | UI-02A | 744 | {{su.noResets}} |
| CD-0023 | UI-02B | 749 | {{su.isBoot}} |
| CD-0024 | UI-02B | 751 | {{su.boot.waitRunner}} |
| CD-0025 | UI-02B | 752 | {{su.boot.fail}} |
| CD-0026 | UI-02B | 756 | {{x.hasNote}} |
| CD-0027 | UI-02C | 760 | {{su.boot.hasTech}} |
| CD-0028 | UI-02C | 766 | {{x.hasCond}} |
| CD-0029 | UI-02C | 768 | {{x.hasAlts}} |
| CD-0030 | UI-02C | 769 | {{x.canPick}} |
| CD-0031 | UI-02C | 771 | {{su.boot.techWait}} |
| CD-0032 | UI-02D | 776 | {{su.boot.hasDraft}} |
| CD-0033 | UI-02D | 779 | {{t.hasFlag}} |
| CD-0034 | UI-02D | 782 | {{su.boot.bApprove.busy}} |
| CD-0035 | UI-02D | 785 | {{su.boot.noDraft}} |
| CD-0036 | UI-03 | 791 | {{isWbs}} |
| CD-0037 | UI-03 | 793 | {{miss.show}} |
| CD-0038 | UI-03D | 807 | {{wr.hasF}} |
| CD-0039 | UI-03D | 808 | {{w.isWp}} |
| CD-0040 | UI-03D | 808 | {{w.isTask}} |
| CD-0041 | UI-03D | 809 | {{wr.none}} |
| CD-0042 | UI-03A | 830 | {{colMenu}} |
| CD-0043 | UI-03 | 840 | {{compact}} |
| CD-0044 | UI-03B | 842 | {{isTable}} |
| CD-0045 | UI-03B | 847 | {{c.kind}} |
| CD-0046 | UI-03B | 848 | {{c.agent}} |
| CD-0047 | UI-03B | 849 | {{c.status}} |
| CD-0048 | UI-03B | 850 | {{c.priority}} |
| CD-0049 | UI-03B | 851 | {{c.preds}} |
| CD-0050 | UI-03B | 852 | {{c.pct}} |
| CD-0051 | UI-03B | 853 | {{c.plan}} |
| CD-0052 | UI-03B | 854 | {{c.est}} |
| CD-0053 | UI-03B | 855 | {{c.updated}} |
| CD-0054 | UI-03B | 858 | {{r.isGroup}} |
| CD-0055 | UI-03B | 867 | {{r.hasWin}} |
| CD-0056 | UI-03B | 871 | {{r.isTask}} |
| CD-0057 | UI-03B | 878 | {{r.c.kind}} |
| CD-0058 | UI-03B | 878 | {{r.hasRel}} |
| CD-0059 | UI-03B | 879 | {{r.c.agent}} |
| CD-0060 | UI-03B | 880 | {{r.c.status}} |
| CD-0061 | UI-03B | 881 | {{r.c.priority}} |
| CD-0062 | UI-03B | 882 | {{r.c.preds}} |
| CD-0063 | UI-03B | 883 | {{r.noPred}} |
| CD-0064 | UI-03B | 884 | {{r.blocked}} |
| CD-0065 | UI-03B | 885 | {{r.predOk}} |
| CD-0066 | UI-03B | 887 | {{r.c.pct}} |
| CD-0067 | UI-03B | 888 | {{r.c.plan}} |
| CD-0068 | UI-03B | 889 | {{r.c.est}} |
| CD-0069 | UI-03B | 890 | {{r.c.updated}} |
| CD-0070 | UI-03B | 894 | {{noRows}} |
| CD-0071 | UI-03C | 899 | {{isGantt}} |
| CD-0072 | UI-03C | 906 | {{r.isGroup}} |
| CD-0073 | UI-03C | 909 | {{r.hasBars}} |
| CD-0074 | UI-03C | 912 | {{r.isTask}} |
| CD-0075 | UI-03E | 924 | {{hasSel}} |
| CD-0076 | UI-03E | 929 | {{dt.hasBack}} |
| CD-0077 | UI-03E | 942 | {{dt.hasRel}} |
| CD-0078 | UI-03E | 947 | {{dt.blocked}} |
| CD-0079 | UI-03E | 948 | {{dt.unblocked}} |
| CD-0080 | UI-03E | 956 | {{gateOpen}} |
| CD-0081 | UI-03E | 964 | {{dt.blocked}} |
| CD-0082 | UI-03E | 971 | {{tb.hasCount}} |
| CD-0083 | UI-03F | 978 | {{edOpen}} |
| CD-0084 | UI-03F | 984 | {{ed.hasErr}} |
| CD-0085 | UI-03F | 985 | {{ed.hasFields}} |
| CD-0086 | UI-03F | 988 | {{fd.req}} |
| CD-0087 | UI-03F | 988 | {{fd.opt}} |
| CD-0088 | UI-03F | 989 | {{fd.isText}} |
| CD-0089 | UI-03F | 990 | {{fd.isSeg}} |
| CD-0090 | UI-03F | 997 | {{bk.hasHint}} |
| CD-0091 | UI-03F | 998 | {{bk.isTable}} |
| CD-0092 | UI-03F | 1000 | {{h.req}} |
| CD-0093 | UI-03F | 1005 | {{cl.isText}} |
| CD-0094 | UI-03F | 1006 | {{cl.isCheck}} |
| CD-0095 | UI-03F | 1007 | {{cl.sIdx}} |
| CD-0096 | UI-03F | 1008 | {{cl.sOut}} |
| CD-0097 | UI-03F | 1009 | {{cl.sState}} |
| CD-0098 | UI-03F | 1015 | {{bk.noRows}} |
| CD-0099 | UI-03F | 1019 | {{bk.isLines}} |
| CD-0100 | UI-03F | 1020 | {{bk.isCode}} |
| CD-0101 | UI-03 | 1027 | {{edClosed}} |
| CD-0102 | UI-03-01 | 1028 | {{dt.tOverview}} |
| CD-0103 | UI-03-01 | 1030 | {{ovRead}} |
| CD-0104 | UI-03-01 | 1031 | {{ovRead}} |
| CD-0105 | UI-03-01A | 1068 | {{rr.canEdit}} |
| CD-0106 | UI-03-01A | 1068 | {{rr.canUnlock}} |
| CD-0107 | UI-03-01A | 1070 | {{rr.editing}} |
| CD-0108 | UI-03-01A | 1074 | {{rr.hasWarn}} |
| CD-0109 | UI-03-01A | 1081 | {{dt.run.subOff}} |
| CD-0110 | UI-03-01A | 1082 | {{g.none}} |
| CD-0111 | UI-03-01A | 1082 | {{x.bad}} |
| CD-0112 | UI-03-01A | 1083 | {{dt.run.noUsed}} |
| CD-0113 | UI-03-01A | 1084 | {{u.hasSubs}} |
| CD-0114 | UI-03-01A | 1084 | {{u.hasEsc}} |
| CD-0115 | UI-03-01B | 1090 | {{x.canExc}} |
| CD-0116 | UI-03-01B | 1092 | {{dt.run.split.canSplit}} |
| CD-0117 | UI-03-01B | 1093 | {{dt.run.split.hasStartedL}} |
| CD-0118 | UI-03-01 | 1098 | {{sg.code}} |
| CD-0119 | UI-03-01 | 1098 | {{sg.plain}} |
| CD-0120 | UI-03-01 | 1099 | {{sg.code}} |
| CD-0121 | UI-03-01 | 1099 | {{sg.plain}} |
| CD-0122 | UI-03-01 | 1102 | {{dt.hasPreds}} |
| CD-0123 | UI-03-01 | 1106 | {{dt.noOutputs}} |
| CD-0124 | UI-03-01 | 1107 | {{o.hasVerify}} |
| CD-0125 | UI-03-01 | 1111 | {{ovEditing}} |
| CD-0126 | UI-03-01 | 1113 | {{ovErr.title}} |
| CD-0127 | UI-03-01 | 1116 | {{ovErr.same}} |
| CD-0128 | UI-03-01 | 1117 | {{ovErr.range}} |
| CD-0129 | UI-03-01 | 1118 | {{ovErr.fixStart}} |
| CD-0130 | UI-03-01 | 1119 | {{ovErr.purpose}} |
| CD-0131 | UI-03-01 | 1124 | {{ovErr.doneCond}} |
| CD-0132 | UI-03-02 | 1131 | {{dt.tSpec}} |
| CD-0133 | UI-03-02 | 1140 | {{sec.canEdit}} |
| CD-0134 | UI-03-02 | 1141 | {{sec.reading}} |
| CD-0135 | UI-03-02 | 1142 | {{sec.isEmpty}} |
| CD-0136 | UI-03-02 | 1143 | {{sec.isList}} |
| CD-0137 | UI-03-02 | 1143 | {{it.hasPre}} |
| CD-0138 | UI-03-02 | 1143 | {{sg.code}} |
| CD-0139 | UI-03-02 | 1143 | {{sg.plain}} |
| CD-0140 | UI-03-02 | 1144 | {{sec.isTbl}} |
| CD-0141 | UI-03-02 | 1145 | {{sec.isOl}} |
| CD-0142 | UI-03-02 | 1145 | {{sg.code}} |
| CD-0143 | UI-03-02 | 1145 | {{sg.plain}} |
| CD-0144 | UI-03-02 | 1147 | {{sec.editing}} |
| CD-0145 | UI-03-03 | 1159 | {{dt.tDeps}} |
| CD-0146 | UI-03-03 | 1162 | {{dt.blocked}} |
| CD-0147 | UI-03-03 | 1163 | {{dt.runnable}} |
| CD-0148 | UI-03-03 | 1164 | {{depOpen}} |
| CD-0149 | UI-03-03 | 1171 | {{hasDepErr}} |
| CD-0150 | UI-03-03 | 1171 | {{depErr.hasPath}} |
| CD-0151 | UI-03-03 | 1174 | {{cd.self}} |
| CD-0152 | UI-03-03 | 1193 | {{dt.noPredRows}} |
| CD-0153 | UI-03-03 | 1198 | {{dt.noSuccs}} |
| CD-0154 | UI-03-03 | 1208 | {{dt.noSuccRows}} |
| CD-0155 | UI-03-04 | 1213 | {{dt.tTech}} |
| CD-0156 | UI-03-04 | 1217 | {{dt.hasDsLinks}} |
| CD-0157 | UI-03-04 | 1218 | {{dt.hasSecAdd}} |
| CD-0158 | UI-03-04 | 1219 | {{dt.noDesign}} |
| CD-0159 | UI-03-04 | 1224 | {{sec.hasEnt}} |
| CD-0160 | UI-03-04 | 1227 | {{sec.noEnt}} |
| CD-0161 | UI-03-04 | 1231 | {{en.hasMethod}} |
| CD-0162 | UI-03-04 | 1233 | {{en.hasTag}} |
| CD-0163 | UI-03-04 | 1236 | {{en.hasAuth}} |
| CD-0164 | UI-03-04 | 1243 | {{bk.isEmpty}} |
| CD-0165 | UI-03-04 | 1244 | {{bk.isTable}} |
| CD-0166 | UI-03-04 | 1245 | {{bk.isLines}} |
| CD-0167 | UI-03-04 | 1245 | {{sg.code}} |
| CD-0168 | UI-03-04 | 1245 | {{sg.plain}} |
| CD-0169 | UI-03-04 | 1246 | {{bk.isCode}} |
| CD-0170 | UI-03-04 | 1251 | {{sec.hasRel}} |
| CD-0171 | UI-03-04 | 1256 | {{bk.canEdit}} |
| CD-0172 | UI-03-04 | 1257 | {{bk.isEmpty}} |
| CD-0173 | UI-03-04 | 1258 | {{bk.isTable}} |
| CD-0174 | UI-03-04 | 1259 | {{bk.isLines}} |
| CD-0175 | UI-03-04 | 1259 | {{sg.code}} |
| CD-0176 | UI-03-04 | 1259 | {{sg.plain}} |
| CD-0177 | UI-03-04 | 1260 | {{bk.isCode}} |
| CD-0178 | UI-03-05 | 1269 | {{dt.tChecklist}} |
| CD-0179 | UI-03-05 | 1272 | {{dt.clGateFail}} |
| CD-0180 | UI-03-05 | 1273 | {{dt.clGatePass}} |
| CD-0181 | UI-03-05 | 1287 | {{dt.noCl}} |
| CD-0182 | UI-03-06 | 1303 | {{dt.tExec}} |
| CD-0183 | UI-03-06 | 1307 | {{dt.noAtt}} |
| CD-0184 | UI-03-06 | 1310 | {{a.hasCi}} |
| CD-0185 | UI-03-06 | 1310 | {{a.hasSubs}} |
| CD-0186 | UI-03-06 | 1310 | {{a.hasUsed}} |
| CD-0187 | UI-03-06 | 1310 | {{a.miss}} |
| CD-0188 | UI-03-06 | 1310 | {{a.hasEsc}} |
| CD-0189 | UI-03-06 | 1312 | {{a.hasFail}} |
| CD-0190 | UI-03-06 | 1313 | {{a.hasFiles}} |
| CD-0191 | UI-03-07 | 1319 | {{dt.tVerif}} |
| CD-0192 | UI-03-07 | 1322 | {{dt.noVer}} |
| CD-0193 | UI-03-07 | 1331 | {{v.hasDefects}} |
| CD-0194 | UI-03-08 | 1338 | {{dt.tHist}} |
| CD-0195 | UI-03-08 | 1343 | {{dt.noHist}} |
| CD-0196 | UI-03-09 | 1351 | {{dt.tMsg}} |
| CD-0197 | UI-03-09 | 1355 | {{dt.noMsg}} |
| CD-0198 | UI-03-09 | 1362 | {{m.hasAttempt}} |
| CD-0199 | UI-03-09 | 1364 | {{m.hasWork}} |
| CD-0200 | UI-03-09 | 1365 | {{m.isNew}} |
| CD-0201 | UI-03-09 | 1369 | {{ln.isCode}} |
| CD-0202 | UI-03-09 | 1370 | {{ln.isText}} |
| CD-0203 | UI-03-09 | 1370 | {{sg.code}} |
| CD-0204 | UI-03-09 | 1370 | {{sg.plain}} |
| CD-0205 | UI-03-09 | 1373 | {{m.failed}} |
| CD-0206 | UI-03-09 | 1374 | {{m.pendingNext}} |
| CD-0207 | UI-03-09 | 1376 | {{m.isLong}} |
| CD-0208 | UI-03-09 | 1377 | {{m.hasAttempt}} |
| CD-0209 | UI-03-09 | 1379 | {{m.canCancel}} |
| CD-0210 | UI-03-09 | 1390 | {{md.runningWarn}} |
| CD-0211 | UI-03-09 | 1391 | {{md.offlineWarn}} |
| CD-0212 | UI-08 | 1405 | {{isCi}} |
| CD-0213 | UI-08 | 1410 | {{ciV.empty}} |
| CD-0214 | UI-08 | 1411 | {{t.hasBadge}} |
| CD-0215 | UI-08-01 | 1413 | {{ciV.tab.runs}} |
| CD-0216 | UI-08-01 | 1414 | {{ciV.listMode}} |
| CD-0217 | UI-08-01 | 1418 | {{ciV.noRows}} |
| CD-0218 | UI-08-01A | 1422 | {{ciV.det.has}} |
| CD-0219 | UI-08-01A | 1433 | {{ciV.det.hasTask}} |
| CD-0220 | UI-08-01A | 1437 | {{ciV.det.hasMerged}} |
| CD-0221 | UI-08-01A | 1438 | {{ciV.det.hasUrl}} |
| CD-0222 | UI-08-01A | 1440 | {{ciV.det.hasNote}} |
| CD-0223 | UI-08-01A | 1443 | {{ciV.det.hasLog}} |
| CD-0224 | UI-08-01A | 1444 | {{ciV.det.hasShots}} |
| CD-0225 | UI-08-01A | 1445 | {{ciV.det.canRetry}} |
| CD-0226 | UI-08-01A | 1445 | {{ciV.det.bRetry.busy}} |
| CD-0227 | UI-08-02 | 1451 | {{ciV.tab.queue}} |
| CD-0228 | UI-08-02 | 1454 | {{ciV.noQueue}} |
| CD-0229 | UI-08-03 | 1458 | {{ciV.tab.deploy}} |
| CD-0230 | UI-08-03 | 1462 | {{ciV.dep.bRun.busy}} |
| CD-0231 | UI-08-04 | 1465 | {{ciV.tab.pipe}} |
| CD-0232 | UI-08-05 | 1475 | {{ciV.tab.flaky}} |
| CD-0233 | UI-08-05 | 1478 | {{ciV.noFlaky}} |
| CD-0234 | UI-04 | 1483 | {{isDesign}} |
| CD-0235 | UI-04 | 1486 | {{ds.empty}} |
| CD-0236 | UI-04 | 1487 | {{ds.has}} |
| CD-0237 | UI-04 | 1488 | {{ds.hasParseErr}} |
| CD-0238 | UI-04 | 1489 | {{ds.hasPend}} |
| CD-0239 | UI-04 | 1490 | {{t.hasBadge}} |
| CD-0240 | UI-04-01 | 1492 | {{ds.tab.map}} |
| CD-0241 | UI-04-01 | 1495 | {{ds.noLayers}} |
| CD-0242 | UI-04-01 | 1496 | {{c.hasDec}} |
| CD-0243 | UI-04-01 | 1497 | {{ds.hasLinks}} |
| CD-0244 | UI-04-01 | 1504 | {{ds.noFiles}} |
| CD-0245 | UI-04-01 | 1505 | {{ds.hasFiles}} |
| CD-0246 | UI-04-02 | 1510 | {{ds.tab.dec}} |
| CD-0247 | UI-04-02 | 1515 | {{x.hasCond}} |
| CD-0248 | UI-04-02 | 1517 | {{x.hasAlts}} |
| CD-0249 | UI-04-02 | 1518 | {{x.isChg}} |
| CD-0250 | UI-04-02 | 1519 | {{x.pending}} |
| CD-0251 | UI-04-02 | 1519 | {{x.canChg}} |
| CD-0252 | UI-04-03, UI-04-04 | 1524 | {{ds.listTab}} |
| CD-0253 | UI-04-03, UI-04-04 | 1525 | {{ds.listMode}} |
| CD-0254 | UI-04-03, UI-04-04 | 1526 | {{ds.tab.iface}} |
| CD-0255 | UI-04-03, UI-04-04 | 1526 | {{ds.tab.data}} |
| CD-0256 | UI-04-03, UI-04-04 | 1527 | {{ds.tab.data}} |
| CD-0257 | UI-04-03, UI-04-04 | 1530 | {{ds.noRows}} |
| CD-0258 | UI-04-03, UI-04-04 | 1531 | {{r.drift}} |
| CD-0259 | UI-04-03, UI-04-04 | 1535 | {{ds.det.has}} |
| CD-0260 | UI-04-03A | 1548 | {{ds.det.hasTask}} |
| CD-0261 | UI-04-03A | 1550 | {{ds.det.hasDrift}} |
| CD-0262 | UI-04-03A | 1551 | {{ds.det.isRest}} |
| CD-0263 | UI-04-03A | 1555 | {{ds.det.hasValid}} |
| CD-0264 | UI-04-03A | 1556 | {{ds.det.hasErr}} |
| CD-0265 | UI-04-03A | 1557 | {{ds.det.hasTables}} |
| CD-0266 | UI-04-03A | 1559 | {{ds.det.isMsg}} |
| CD-0267 | UI-04-03A | 1563 | {{ds.det.isKafka}} |
| CD-0268 | UI-04-03A | 1566 | {{ds.det.hasRules}} |
| CD-0269 | UI-04-04A | 1568 | {{ds.det.isPg}} |
| CD-0270 | UI-04-04A | 1571 | {{ds.det.hasIdx}} |
| CD-0271 | UI-04-04A | 1572 | {{ds.det.hasUsed}} |
| CD-0272 | UI-04-04A | 1572 | {{ds.det.hasUsed}} |
| CD-0273 | UI-04-04A | 1574 | {{ds.det.isNeoL}} |
| CD-0274 | UI-04-04A | 1575 | {{ds.det.isNeoR}} |
| CD-0275 | UI-04-04A | 1576 | {{ds.det.isQdb}} |
| CD-0276 | UI-04-04A | 1577 | {{ds.det.isRedis}} |
| CD-0277 | UI-04-05 | 1584 | {{ds.tab.own}} |
| CD-0278 | UI-04-05 | 1588 | {{ds.noOwn}} |
| CD-0279 | UI-04-05 | 1589 | {{ds.hasOwn}} |
| CD-0280 | UI-04-06 | 1594 | {{ds.tab.chg}} |
| CD-0281 | UI-04-06 | 1598 | {{ds.noDrifts}} |
| CD-0282 | UI-04-06 | 1602 | {{r.hasRes}} |
| CD-0283 | UI-04-06 | 1603 | {{r.open}} |
| CD-0284 | UI-04-06 | 1608 | {{v.brk}} |
| CD-0285 | UI-05 | 1614 | {{isPlanning}} |
| CD-0286 | UI-05-02 | 1618 | {{pl.isReplans}} |
| CD-0287 | UI-05-02 | 1628 | {{rp.hasMoved}} |
| CD-0288 | UI-05-02 | 1629 | {{rp.isOpen}} |
| CD-0289 | UI-05-02 | 1632 | {{m.canOpen}} |
| CD-0290 | UI-05 | 1638 | {{pl.none}} |
| CD-0291 | UI-05-01 | 1639 | {{pl.isSessions}} |
| CD-0292 | UI-05-01 | 1646 | {{pl.s.hasCp}} |
| CD-0293 | UI-05-01 | 1664 | {{rv.canAdjust}} |
| CD-0294 | UI-05-01 | 1665 | {{rv.hasMemo}} |
| CD-0295 | UI-05-01 | 1666 | {{rv.hasOps}} |
| CD-0296 | UI-05-01 | 1671 | {{pl.s.noOps}} |
| CD-0297 | UI-05-01 | 1675 | {{r.canOpen}} |
| CD-0298 | UI-05-01 | 1675 | {{r.isNewRef}} |
| CD-0299 | UI-05-01 | 1678 | {{pl.s.hasIssues}} |
| CD-0300 | UI-09 | 1687 | {{isChange}} |
| CD-0301 | UI-09 | 1692 | {{cpv.noList}} |
| CD-0302 | UI-09 | 1696 | {{cpv.noneAll}} |
| CD-0303 | UI-09A | 1697 | {{cpv.has}} |
| CD-0304 | UI-09A | 1699 | {{cpv.p.hasSrc}} |
| CD-0305 | UI-09A | 1703 | {{cpv.p.noOps}} |
| CD-0306 | UI-09A | 1707 | {{r.canOpen}} |
| CD-0307 | UI-09A | 1707 | {{r.isNewRef}} |
| CD-0308 | UI-09A | 1707 | {{r.canRemove}} |
| CD-0309 | UI-09A | 1711 | {{cpv.p.hasIssues}} |
| CD-0310 | UI-09A | 1712 | {{cpv.p.hasImpact}} |
| CD-0311 | UI-09A | 1717 | {{im.canOpen}} |
| CD-0312 | UI-09A | 1717 | {{im.isNew}} |
| CD-0313 | UI-09A | 1722 | {{cpv.p.isReview}} |
| CD-0314 | UI-09A | 1727 | {{cpv.p.hasErr}} |
| CD-0315 | UI-09A | 1731 | {{cpv.p.isChanges}} |
| CD-0316 | UI-09A | 1734 | {{cpv.p.isApproved}} |
| CD-0317 | UI-09A | 1738 | {{ap.hasComment}} |
| CD-0318 | UI-06 | 1747 | {{isExec}} |
| CD-0319 | UI-06 | 1754 | {{it.blocked}} |
| CD-0320 | UI-06 | 1764 | {{ex.t.hasReason}} |
| CD-0321 | UI-06A | 1767 | {{ex.isDev}} |
| CD-0322 | UI-06A | 1775 | {{ex.f.isFail}} |
| CD-0323 | UI-06B | 1781 | {{ex.isQa}} |
| CD-0324 | UI-06B | 1791 | {{ex.f.isQaFail}} |
| CD-0325 | UI-06B | 1793 | {{ex.f.noCl}} |
| CD-0326 | UI-06C | 1801 | {{ex.isRw}} |
| CD-0327 | UI-06 | 1810 | {{ex.gateShow}} |
| CD-0328 | UI-06D | 1820 | {{ex.hasAtt}} |
| CD-0329 | UI-06D | 1822 | {{ex.a.hasCi}} |
| CD-0330 | UI-06D | 1822 | {{ex.a.hasSubs}} |
| CD-0331 | UI-06D | 1822 | {{ex.a.hasUsed}} |
| CD-0332 | UI-06D | 1822 | {{ex.a.miss}} |
| CD-0333 | UI-06D | 1822 | {{ex.a.hasEsc}} |
| CD-0334 | UI-06D | 1824 | {{ex.a.hasFail}} |
| CD-0335 | UI-06D | 1825 | {{ex.a.hasFiles}} |
| CD-0336 | UI-06D | 1826 | {{ex.hasV}} |
| CD-0337 | UI-06D | 1834 | {{ex.v.hasDefects}} |
| CD-0338 | UI-06D | 1840 | {{ex.noAtt}} |
| CD-0339 | UI-06E | 1845 | {{ex.noMsg}} |
| CD-0340 | UI-06E | 1848 | {{m.isNew}} |
| CD-0341 | UI-01 | 1858 | {{isDash}} |
| CD-0342 | UI-01 | 1863 | {{k.hasBar}} |
| CD-0343 | UI-01 | 1865 | {{db.hasAlerts}} |
| CD-0344 | UI-01 | 1875 | {{pn.empty}} |
| CD-0345 | UI-01 | 1889 | {{db.noGrades}} |
| CD-0346 | UI-01 | 1896 | {{db.noRecent}} |
| CD-0347 | UI-07 | 1902 | {{isVerify}} |
| CD-0348 | UI-07-01 | 1907 | {{vf.isResults}} |
| CD-0349 | UI-07-01 | 1908 | {{vf.listMode}} |
| CD-0350 | UI-07-01 | 1915 | {{vf.noResAny}} |
| CD-0351 | UI-07-01 | 1915 | {{vf.noResFilter}} |
| CD-0352 | UI-07-01A | 1918 | {{vf.det.has}} |
| CD-0353 | UI-07-01A | 1932 | {{vf.det.hasDefects}} |
| CD-0354 | UI-07-01A | 1935 | {{vf.det.noEv}} |
| CD-0355 | UI-07-01A | 1939 | {{vf.det.noCl}} |
| CD-0356 | UI-07-02 | 1947 | {{vf.isEvidence}} |
| CD-0357 | UI-07-02 | 1954 | {{vf.noEvidence}} |
| CD-0358 | UI-07-02 | 1956 | {{vf.hasOrphan}} |
| CD-0359 | UI-07-03 | 1959 | {{vf.isGate}} |
| CD-0360 | UI-07-03 | 1966 | {{vf.noGates}} |
| CD-0361 | UI-10 | 1972 | {{isHist}} |
| CD-0362 | UI-10 | 1988 | {{hv.noneAll}} |
| CD-0363 | UI-10 | 1988 | {{hv.noneFilter}} |
| CD-0364 | UI-02 | 1993 | {{isProject}} |
| CD-0365 | UI-02E | 1997 | {{inp.bFetch.busy}} |
| CD-0366 | UI-02E | 1998 | {{inp.ghBad}} |
| CD-0367 | UI-02E | 2006 | {{inp.hasPend}} |
| CD-0368 | UI-02E | 2013 | {{inp.bAnalyze.busy}} |
| CD-0369 | UI-02E | 2016 | {{inp.noPend}} |
| CD-0370 | UI-02E | 2016 | {{inp.hasSkipped}} |
| CD-0371 | UI-02E | 2021 | {{inp.job.has}} |
| CD-0372 | UI-02E | 2023 | {{x.hasNote}} |
| CD-0373 | UI-02E | 2024 | {{inp.job.hasCp}} |
| CD-0374 | UI-02E | 2025 | {{inp.job.fail}} |
| CD-0375 | UI-02 | 2032 | {{pj.reading}} |
| CD-0376 | UI-02 | 2033 | {{pj.reading}} |
| CD-0377 | UI-02 | 2050 | {{pj.editing}} |
| CD-0378 | UI-02 | 2056 | {{pj.dateErr}} |
| CD-0379 | UI-11 | 2089 | {{isReport}} |
| CD-0380 | UI-11A | 2098 | {{rp.form.bCreate.busy}} |
| CD-0381 | UI-11A | 2101 | {{rp.form.hasErr}} |
| CD-0382 | UI-11 | 2109 | {{rp.noRows}} |
| CD-0383 | UI-11 | 2113 | {{r.late}} |
| CD-0384 | UI-11 | 2121 | {{rp.docBusy}} |
| CD-0385 | UI-11 | 2122 | {{rp.noDoc}} |
| CD-0386 | UI-11D | 2123 | {{rp.doc.has}} |
| CD-0387 | UI-11D | 2125 | {{rp.doc.canToggle}} |
| CD-0388 | UI-11D | 2131 | {{rp.doc.hasSent}} |
| CD-0389 | UI-11D | 2132 | {{rp.doc.changed}} |
| CD-0390 | UI-11 | 2138 | {{rp.doc.isLate}} |
| CD-0391 | UI-11B | 2141 | {{rp.doc.isInt}} |
| CD-0392 | UI-11B | 2144 | {{rp.doc.noIssues}} |
| CD-0393 | UI-11B | 2147 | {{rp.doc.isWeekly}} |
| CD-0394 | UI-11B | 2157 | {{rp.doc.det.noDone}} |
| CD-0395 | UI-11B | 2166 | {{rp.doc.det.noAct}} |
| CD-0396 | UI-11B | 2174 | {{rp.doc.det.hasFail}} |
| CD-0397 | UI-11B | 2186 | {{rp.doc.det.noAtt}} |
| CD-0398 | UI-11B | 2187 | {{rp.doc.det.hasAtt}} |
| CD-0399 | UI-11B | 2190 | {{a.hasEsc}} |
| CD-0400 | UI-11B | 2195 | {{rp.doc.det.noRp}} |
| CD-0401 | UI-11B | 2199 | {{x.hasMoved}} |
| CD-0402 | UI-11B | 2199 | {{x.hasMore}} |
| CD-0403 | UI-11B | 2204 | {{rp.doc.noGaps}} |
| CD-0404 | UI-11B | 2208 | {{rp.doc.det.noMsg}} |
| CD-0405 | UI-11B | 2212 | {{rp.doc.det.noNext}} |
| CD-0406 | UI-11B | 2213 | {{rp.doc.det.hasNext}} |
| CD-0407 | UI-11B | 2223 | {{t.hasBl}} |
| CD-0408 | UI-11C | 2228 | {{rp.doc.isExt}} |
| CD-0409 | UI-11C | 2231 | {{rp.doc.isWeekly}} |
| CD-0410 | UI-11C | 2239 | {{rp.doc.noHigh}} |
| CD-0411 | UI-11C | 2241 | {{rp.doc.noPlan}} |
| CD-0412 | UI-12 | 2251 | {{isSettings}} |
| CD-0413 | UI-12 | 2254 | {{cfg.preReg}} |
| CD-0414 | UI-12 | 2255 | {{t.hasBadge}} |
| CD-0415 | UI-12-01 | 2257 | {{cfg.tab.runner}} |
| CD-0416 | UI-12-01A | 2269 | {{cfg.gh.hasErr}} |
| CD-0417 | UI-12-01A | 2270 | {{cfg.gh.isToken}} |
| CD-0418 | UI-12-01A | 2270 | {{cfg.gh.bSave.busy}} |
| CD-0419 | UI-12-01A | 2270 | {{cfg.gh.hasTokErr}} |
| CD-0420 | UI-12-01A | 2271 | {{cfg.gh.bCheck.busy}} |
| CD-0421 | UI-12-01B | 2286 | {{x.canFix}} |
| CD-0422 | UI-12-01C | 2301 | {{cfg.cap.noGaps}} |
| CD-0423 | UI-12-01C | 2319 | {{cfg.isOn}} |
| CD-0424 | UI-12-01C | 2319 | {{cfg.isOff}} |
| CD-0425 | UI-12-01D | 2332 | {{cfg.cc.hasWarn}} |
| CD-0426 | UI-12-01D | 2333 | {{cfg.cc.isAuto}} |
| CD-0427 | UI-12-01D | 2349 | {{cfg.cc.noCgWait}} |
| CD-0428 | UI-12-01D | 2349 | {{cfg.cc.hasCgWait}} |
| CD-0429 | UI-12-01E | 2352 | {{cfg.cc.ob.hasUnconf}} |
| CD-0430 | UI-12-01E | 2355 | {{cfg.cc.ob.noSess}} |
| CD-0431 | UI-12-01E | 2362 | {{o.ok}} |
| CD-0432 | UI-12-01E | 2362 | {{o.un}} |
| CD-0433 | UI-12-01E | 2370 | {{c.mismatch}} |
| CD-0434 | UI-12-01D | 2389 | {{cfg.cc.noLog}} |
| CD-0435 | UI-12-02 | 2396 | {{cfg.tab.agent}} |
| CD-0436 | UI-12-02 | 2401 | {{cfg.sameWarn}} |
| CD-0437 | UI-12-02A | 2425 | {{cfg.ex.isDown}} |
| CD-0438 | UI-12-02A | 2427 | {{cfg.ex.isSame}} |
| CD-0439 | UI-12-02A | 2430 | {{cfg.ex.noLocked}} |
| CD-0440 | UI-12-02A | 2430 | {{cfg.ex.hasLocked}} |
| CD-0441 | UI-12-02A | 2431 | {{cfg.ex.hasAlerts}} |
| CD-0442 | UI-12-02B | 2444 | {{x.open}} |
| CD-0443 | UI-12-02B | 2444 | {{x.hasRef}} |
| CD-0444 | UI-12-03 | 2451 | {{cfg.tab.plan}} |
| CD-0445 | UI-12-03A | 2471 | {{cfg.spl.noFlag}} |
| CD-0446 | UI-12-03A | 2472 | {{cfg.spl.hasFlag}} |
| CD-0447 | UI-12-03B | 2487 | {{cfg.noBlackout}} |
| CD-0448 | UI-12-03B | 2490 | {{cfg.hasBoErr}} |
| CD-0449 | UI-12-04 | 2511 | {{cfg.tab.report}} |
| CD-0450 | UI-12-04A | 2515 | {{cfg.mail.smtpBad}} |
| CD-0451 | UI-12-04A | 2516 | {{cfg.mail.noSmtpWarn}} |
| CD-0452 | UI-12-04A | 2519 | {{cfg.mail.noRecips}} |
| CD-0453 | UI-12-04A | 2526 | {{rc.hasSub}} |
| CD-0454 | UI-12-04A | 2528 | {{rc.bTest.busy}} |
| CD-0455 | UI-12-04A | 2538 | {{cfg.mail.fm.hasErr}} |
| CD-0456 | UI-12-04B | 2543 | {{cfg.mail.cfgd}} |
| CD-0457 | UI-12-04B | 2544 | {{cfg.mail.view}} |
| CD-0458 | UI-12-04B | 2551 | {{cfg.mail.smtp.hasErr}} |
| CD-0459 | UI-12-04B | 2552 | {{cfg.mail.smtp.bCheck.busy}} |
| CD-0460 | UI-12-04B | 2554 | {{cfg.mail.noCfg}} |
| CD-0461 | UI-12-04B | 2555 | {{cfg.mail.edit}} |
| CD-0462 | UI-12-04B | 2562 | {{cfg.mail.f.hasErr}} |
| CD-0463 | UI-12-04C | 2569 | {{cfg.mail.hasPend}} |
| CD-0464 | UI-12-04C | 2569 | {{cfg.mail.bAll.busy}} |
| CD-0465 | UI-12-04C | 2572 | {{cfg.mail.noLogs}} |
| CD-0466 | UI-12-04C | 2575 | {{lg.hasErr}} |
| CD-0467 | UI-12-04C | 2576 | {{lg.canPv}} |
| CD-0468 | UI-12-04C | 2576 | {{lg.canRetry}} |
| CD-0469 | UI-12-04C | 2576 | {{lg.bRetry.busy}} |
| CD-0470 | UI-12-05 | 2582 | {{cfg.tab.notify}} |
| CD-0471 | UI-12-05A | 2588 | {{cfg.tg.hasBad}} |
| CD-0472 | UI-12-05A | 2591 | {{cfg.tg.tokKeep}} |
| CD-0473 | UI-12-05A | 2592 | {{cfg.tg.tokRep}} |
| CD-0474 | UI-12-05A | 2592 | {{cfg.tg.canCancelRep}} |
| CD-0475 | UI-12-05A | 2594 | {{cfg.tg.bBot.busy}} |
| CD-0476 | UI-12-05A | 2597 | {{cfg.tg.chatBad}} |
| CD-0477 | UI-12-05A | 2600 | {{cfg.tg.bTest.busy}} |
| CD-0478 | UI-12-05A | 2601 | {{cfg.tg.testOk}} |
| CD-0479 | UI-12-05A | 2601 | {{cfg.tg.testFail}} |
| CD-0480 | UI-12-05A | 2604 | {{cfg.tg.hasErr}} |
| CD-0481 | UI-12-05B | 2617 | {{cfg.tg.pvOff}} |
| CD-0482 | UI-12-05C | 2624 | {{cfg.tg.urlLocal}} |
| CD-0483 | UI-12-05C | 2625 | {{cfg.tg.urlNone}} |
| CD-0484 | UI-12-05D | 2631 | {{cfg.tg.noLogs}} |
| CD-0485 | UI-12-05D | 2634 | {{lg.hasDup}} |
| CD-0486 | UI-12-05D | 2637 | {{cfg.tg.sel.has}} |
| CD-0487 | UI-12-05D | 2639 | {{cfg.tg.sel.canGo}} |
| CD-0488 | UI-12-06 | 2646 | {{cfg.tab.system}} |
| CD-0489 | UI-12-06 | 2648 | {{cfg.hasCheck}} |
| CD-0490 | UI-12-06 | 2650 | {{cfg.hasCheck}} |
| CD-0491 | UI-12-06 | 2653 | {{cfg.noChecks}} |
| CD-0492 | UI-13 | 2678 | {{isOther}} |
| CD-0493 | MOD-01 | 2692 | {{err.conflict}} |
| CD-0494 | MOD-02 | 2705 | {{tgf.open}} |
| CD-0495 | MOD-02 | 2716 | {{tgf.loading}} |
| CD-0496 | MOD-02 | 2717 | {{tgf.list}} |
| CD-0497 | MOD-02 | 2718 | {{tgf.empty}} |
| CD-0498 | MOD-02 | 2719 | {{tgf.webhook}} |
| CD-0499 | MOD-02 | 2721 | {{tgf.bQuery.busy}} |
| CD-0500 | MOD-03 | 2725 | {{mp.open}} |
| CD-0501 | MOD-03 | 2736 | {{mp.canToggle}} |
| CD-0502 | MOD-04 | 2744 | {{ms.open}} |
| CD-0503 | MOD-04 | 2750 | {{ms.smtpWarn}} |
| CD-0504 | MOD-04 | 2752 | {{ms.noRecips}} |
| CD-0505 | MOD-04 | 2754 | {{ms.notDaily}} |
| CD-0506 | MOD-04 | 2755 | {{ms.isDaily}} |
| CD-0507 | MOD-04 | 2756 | {{ms.hasErr}} |
| CD-0508 | MOD-04 | 2758 | {{ms.bSend.busy}} |
| CD-0509 | MOD-05 | 2762 | {{su.rs.open}} |
| CD-0510 | MOD-05 | 2773 | {{su.rs.offline}} |
| CD-0511 | MOD-05 | 2778 | {{su.rs.hasErr}} |
| CD-0512 | MOD-05 | 2781 | {{su.rs.bRun.busy}} |
| CD-0513 | MOD-06 | 2785 | {{wizOpen}} |
| CD-0514 | MOD-06A | 2791 | {{wz.s1}} |
| CD-0515 | MOD-06A | 2793 | {{wz.err.title}} |
| CD-0516 | MOD-06A | 2795 | {{wz.err.type}} |
| CD-0517 | MOD-06A | 2796 | {{wz.err.domain}} |
| CD-0518 | MOD-06A | 2798 | {{wz.err.est}} |
| CD-0519 | MOD-06A | 2799 | {{wz.err.fixStart}} |
| CD-0520 | MOD-06 | 2804 | {{wz.s2}} |
| CD-0521 | MOD-06B | 2806 | {{wz.err.purpose}} |
| CD-0522 | MOD-06B | 2810 | {{wz.err.doneCond}} |
| CD-0523 | MOD-06C | 2813 | {{wz.s3}} |
| CD-0524 | MOD-06C | 2818 | {{wz.willBlock}} |
| CD-0525 | MOD-07 | 2849 | {{cpmOpen}} |
| CD-0526 | MOD-07 | 2873 | {{cpm.hasErr}} |
| CD-0527 | MOD-07 | 2874 | {{cpm.hasPreview}} |
| CD-0528 | MOD-08 | 2887 | {{confirmOpen}} |
| CD-0529 | SYS-03 | 2897 | {{hasNotice}} |

## 모든 반복 바인딩 대조

| 반복 ID | 화면 ID | 줄 | 목록 → 별칭 |
|---|---|---:|---|
| LP-0001 | UI-00 | 665 | {{navItems}} → n |
| LP-0002 | SYS-01 | 688 | {{sys.sk}} → r |
| LP-0003 | SYS-01 | 688 | {{r.cells}} → c |
| LP-0004 | SYS-01 | 688 | {{c.blocks}} → b |
| LP-0005 | UI-02A | 716 | {{su.reg.st}} → x |
| LP-0006 | UI-02A | 717 | {{su.reg.md}} → m |
| LP-0007 | UI-02A | 719 | {{su.reg.layout}} → l |
| LP-0008 | UI-02A | 722 | {{su.reg.tech}} → tc |
| LP-0009 | UI-02A | 722 | {{tc.lvs}} → o |
| LP-0010 | UI-02A | 743 | {{su.resets}} → r |
| LP-0011 | UI-02B | 756 | {{su.boot.steps}} → x |
| LP-0012 | UI-02B | 758 | {{su.boot.logs}} → l |
| LP-0013 | UI-02C | 764 | {{su.boot.tech}} → x |
| LP-0014 | UI-02D | 779 | {{su.boot.tree}} → t |
| LP-0015 | UI-03D | 808 | {{wr.items}} → w |
| LP-0016 | UI-03 | 825 | {{viewOpts}} → o |
| LP-0017 | UI-03A | 833 | {{colOpts}} → co |
| LP-0018 | UI-03B | 857 | {{rows}} → r |
| LP-0019 | UI-03C | 903 | {{gDays}} → gd |
| LP-0020 | UI-03C | 905 | {{rows}} → r |
| LP-0021 | UI-03E | 958 | {{dt.gate}} → g |
| LP-0022 | UI-03E | 966 | {{dt.blockers}} → b |
| LP-0023 | UI-03E | 970 | {{dt.tabs}} → tb |
| LP-0024 | UI-03F | 984 | {{ed.errs}} → er |
| LP-0025 | UI-03F | 987 | {{ed.fields}} → fd |
| LP-0026 | UI-03F | 990 | {{fd.opts}} → o |
| LP-0027 | UI-03F | 995 | {{ed.blocks}} → bk |
| LP-0028 | UI-03F | 1000 | {{bk.head}} → h |
| LP-0029 | UI-03F | 1001 | {{bk.rows}} → rw |
| LP-0030 | UI-03F | 1003 | {{rw.cells}} → cl |
| LP-0031 | UI-03-01A | 1066 | {{dt.run.rows}} → rr |
| LP-0032 | UI-03-01A | 1072 | {{rr.mOpts}} → o |
| LP-0033 | UI-03-01A | 1073 | {{rr.eOpts}} → o |
| LP-0034 | UI-03-01A | 1082 | {{dt.run.subs}} → g |
| LP-0035 | UI-03-01A | 1082 | {{g.list}} → x |
| LP-0036 | UI-03-01A | 1084 | {{dt.run.used}} → u |
| LP-0037 | UI-03-01B | 1090 | {{dt.run.split.items}} → x |
| LP-0038 | UI-03-01 | 1098 | {{dt.scope}} → it |
| LP-0039 | UI-03-01 | 1098 | {{it.segs}} → sg |
| LP-0040 | UI-03-01 | 1099 | {{dt.out}} → it |
| LP-0041 | UI-03-01 | 1099 | {{it.segs}} → sg |
| LP-0042 | UI-03-01 | 1102 | {{dt.preds}} → p |
| LP-0043 | UI-03-01 | 1107 | {{dt.outputs}} → o |
| LP-0044 | UI-03-02 | 1135 | {{dt.specGroups}} → g |
| LP-0045 | UI-03-02 | 1138 | {{g.sections}} → sec |
| LP-0046 | UI-03-02 | 1143 | {{sec.items}} → it |
| LP-0047 | UI-03-02 | 1143 | {{it.segs}} → sg |
| LP-0048 | UI-03-02 | 1144 | {{sec.tbl.head}} → h |
| LP-0049 | UI-03-02 | 1144 | {{sec.tbl.cells}} → cc |
| LP-0050 | UI-03-02 | 1145 | {{sec.items}} → it |
| LP-0051 | UI-03-02 | 1145 | {{it.segs}} → sg |
| LP-0052 | UI-03-03 | 1168 | {{depTypes}} → o |
| LP-0053 | UI-03-03 | 1173 | {{dt.cands}} → cd |
| LP-0054 | UI-03-03 | 1183 | {{dt.preds}} → p |
| LP-0055 | UI-03-03 | 1199 | {{dt.succs}} → p |
| LP-0056 | UI-03-04 | 1217 | {{dt.dsLinks}} → k |
| LP-0057 | UI-03-04 | 1218 | {{dt.secAdd}} → sa |
| LP-0058 | UI-03-04 | 1220 | {{dt.design}} → sec |
| LP-0059 | UI-03-04 | 1228 | {{sec.ents}} → en |
| LP-0060 | UI-03-04 | 1240 | {{en.blocks}} → bk |
| LP-0061 | UI-03-04 | 1244 | {{bk.head}} → h |
| LP-0062 | UI-03-04 | 1244 | {{bk.cells}} → cc |
| LP-0063 | UI-03-04 | 1245 | {{bk.items}} → it |
| LP-0064 | UI-03-04 | 1245 | {{it.segs}} → sg |
| LP-0065 | UI-03-04 | 1252 | {{sec.rel.head}} → h |
| LP-0066 | UI-03-04 | 1252 | {{sec.rel.cells}} → cc |
| LP-0067 | UI-03-04 | 1254 | {{sec.blocks}} → bk |
| LP-0068 | UI-03-04 | 1258 | {{bk.head}} → h |
| LP-0069 | UI-03-04 | 1258 | {{bk.cells}} → cc |
| LP-0070 | UI-03-04 | 1259 | {{bk.items}} → it |
| LP-0071 | UI-03-04 | 1259 | {{it.segs}} → sg |
| LP-0072 | UI-03-05 | 1276 | {{dt.cl}} → ci |
| LP-0073 | UI-03-05 | 1296 | {{clReqOpts}} → o |
| LP-0074 | UI-03-06 | 1306 | {{dt.flowSteps}} → st |
| LP-0075 | UI-03-06 | 1308 | {{dt.atts}} → a |
| LP-0076 | UI-03-06 | 1313 | {{a.files}} → fl |
| LP-0077 | UI-03-07 | 1323 | {{dt.vers}} → v |
| LP-0078 | UI-03-07 | 1330 | {{v.evidence}} → e |
| LP-0079 | UI-03-07 | 1331 | {{v.defects}} → e |
| LP-0080 | UI-03-08 | 1344 | {{dt.hist}} → h |
| LP-0081 | UI-03-09 | 1356 | {{dt.msgs}} → m |
| LP-0082 | UI-03-09 | 1368 | {{m.lines}} → ln |
| LP-0083 | UI-03-09 | 1370 | {{ln.segs}} → sg |
| LP-0084 | UI-03-09 | 1385 | {{md.types}} → o |
| LP-0085 | UI-03-09 | 1386 | {{md.agents}} → o |
| LP-0086 | UI-03-09 | 1387 | {{md.atts}} → o |
| LP-0087 | UI-08 | 1411 | {{ciV.tabs}} → t |
| LP-0088 | UI-08-01 | 1415 | {{ciV.stages}} → o |
| LP-0089 | UI-08-01 | 1419 | {{ciV.rows}} → r |
| LP-0090 | UI-08-01A | 1426 | {{ciV.rows}} → r |
| LP-0091 | UI-08-01A | 1442 | {{ciV.det.steps}} → x |
| LP-0092 | UI-08-01A | 1444 | {{ciV.det.shots}} → z |
| LP-0093 | UI-08-02 | 1455 | {{ciV.queue}} → q |
| LP-0094 | UI-08-04 | 1467 | {{ciV.pipe.rules}} → x |
| LP-0095 | UI-08-04 | 1468 | {{ciV.pipe.stages}} → g |
| LP-0096 | UI-08-04 | 1468 | {{g.steps}} → x |
| LP-0097 | UI-08-05 | 1479 | {{ciV.flaky}} → f |
| LP-0098 | UI-04 | 1490 | {{ds.tabs}} → t |
| LP-0099 | UI-04-01 | 1496 | {{ds.layers}} → ly |
| LP-0100 | UI-04-01 | 1496 | {{ly.comps}} → c |
| LP-0101 | UI-04-01 | 1499 | {{ds.links}} → k |
| LP-0102 | UI-04-01 | 1506 | {{ds.files}} → f |
| LP-0103 | UI-04-02 | 1512 | {{ds.decGroups}} → g |
| LP-0104 | UI-04-02 | 1513 | {{g.rows}} → x |
| LP-0105 | UI-04-03, UI-04-04 | 1526 | {{ds.kinds}} → o |
| LP-0106 | UI-04-03, UI-04-04 | 1526 | {{ds.stores}} → o |
| LP-0107 | UI-04-03, UI-04-04 | 1531 | {{ds.rows}} → r |
| LP-0108 | UI-04-03, UI-04-04 | 1539 | {{ds.rows}} → r |
| LP-0109 | UI-04-03A | 1550 | {{ds.det.drifts}} → z |
| LP-0110 | UI-04-03A | 1555 | {{ds.det.valid}} → v |
| LP-0111 | UI-04-03A | 1556 | {{ds.det.errors}} → e |
| LP-0112 | UI-04-03A | 1557 | {{ds.det.tables}} → tb |
| LP-0113 | UI-04-03A | 1562 | {{ds.det.msgs}} → m |
| LP-0114 | UI-04-03A | 1566 | {{ds.det.rules}} → v |
| LP-0115 | UI-04-04A | 1570 | {{ds.det.cols}} → c |
| LP-0116 | UI-04-04A | 1571 | {{ds.det.idx}} → v |
| LP-0117 | UI-04-04A | 1572 | {{ds.det.usedBy}} → u |
| LP-0118 | UI-04-04A | 1574 | {{ds.det.cons}} → v |
| LP-0119 | UI-04-05 | 1590 | {{ds.own}} → o |
| LP-0120 | UI-04-06 | 1599 | {{ds.drifts}} → r |
| LP-0121 | UI-04-06 | 1608 | {{ds.versions}} → v |
| LP-0122 | UI-05 | 1617 | {{pl.plTabs}} → tb |
| LP-0123 | UI-05-02 | 1623 | {{pl.rps}} → rp |
| LP-0124 | UI-05-02 | 1632 | {{rp.moved}} → m |
| LP-0125 | UI-05-01 | 1642 | {{pl.list}} → p |
| LP-0126 | UI-05-01 | 1647 | {{pl.s.steps}} → st |
| LP-0127 | UI-05-01 | 1651 | {{pl.s.analyses}} → a |
| LP-0128 | UI-05-01 | 1655 | {{a.items}} → it |
| LP-0129 | UI-05-01 | 1660 | {{pl.s.review}} → rv |
| LP-0130 | UI-05-01 | 1664 | {{rv.choices}} → o |
| LP-0131 | UI-05-01 | 1666 | {{rv.ops}} → o |
| LP-0132 | UI-05-01 | 1674 | {{pl.s.diff}} → r |
| LP-0133 | UI-05-01 | 1678 | {{pl.s.issues}} → i2 |
| LP-0134 | UI-09 | 1693 | {{cpv.list}} → p |
| LP-0135 | UI-09A | 1706 | {{cpv.p.diff}} → r |
| LP-0136 | UI-09A | 1711 | {{cpv.p.issues}} → i2 |
| LP-0137 | UI-09A | 1716 | {{cpv.p.impact}} → im |
| LP-0138 | UI-09A | 1738 | {{cpv.p.approvals}} → ap |
| LP-0139 | UI-06 | 1752 | {{ex.list}} → it |
| LP-0140 | UI-06 | 1755 | {{it.atts}} → a |
| LP-0141 | UI-06 | 1762 | {{ex.t.steps}} → st |
| LP-0142 | UI-06 | 1763 | {{ex.t.actions}} → ac |
| LP-0143 | UI-06A | 1771 | {{ex.f.okOpts}} → o |
| LP-0144 | UI-06B | 1785 | {{ex.f.resOpts}} → o |
| LP-0145 | UI-06B | 1794 | {{ex.f.cl}} → c |
| LP-0146 | UI-06D | 1814 | {{ex.gate}} → g |
| LP-0147 | UI-06D | 1825 | {{ex.a.files}} → fl |
| LP-0148 | UI-06D | 1833 | {{ex.v.evidence}} → e |
| LP-0149 | UI-06D | 1834 | {{ex.v.defects}} → e |
| LP-0150 | UI-06E | 1846 | {{ex.msgs}} → m |
| LP-0151 | UI-01 | 1863 | {{db.sched}} → k |
| LP-0152 | UI-01 | 1865 | {{db.alerts}} → al |
| LP-0153 | UI-01 | 1868 | {{db.kpi}} → k |
| LP-0154 | UI-01 | 1871 | {{db.panels}} → pn |
| LP-0155 | UI-01 | 1876 | {{pn.items}} → it |
| LP-0156 | UI-01 | 1882 | {{db.types}} → b |
| LP-0157 | UI-01 | 1885 | {{db.domains}} → b |
| LP-0158 | UI-01 | 1892 | {{db.grades}} → g |
| LP-0159 | UI-01 | 1897 | {{db.recent}} → r |
| LP-0160 | UI-07 | 1905 | {{vf.tabs}} → tb |
| LP-0161 | UI-07-01 | 1909 | {{vf.resOpts}} → o |
| LP-0162 | UI-07-01 | 1909 | {{vf.agOpts}} → o |
| LP-0163 | UI-07-01 | 1912 | {{vf.results}} → v |
| LP-0164 | UI-07-01A | 1922 | {{vf.results}} → v |
| LP-0165 | UI-07-01A | 1932 | {{vf.det.defects}} → e |
| LP-0166 | UI-07-01A | 1936 | {{vf.det.ev}} → e |
| LP-0167 | UI-07-01A | 1937 | {{e.links}} → lk |
| LP-0168 | UI-07-02 | 1951 | {{vf.evidence}} → e |
| LP-0169 | UI-07-03 | 1960 | {{vf.gateOnlyOpts}} → o |
| LP-0170 | UI-07-03 | 1963 | {{vf.gates}} → g |
| LP-0171 | UI-07-03 | 1964 | {{g.cells}} → x |
| LP-0172 | UI-10 | 1979 | {{hv.kinds}} → o |
| LP-0173 | UI-10 | 1980 | {{hv.actors}} → o |
| LP-0174 | UI-10 | 1985 | {{hv.rows}} → h |
| LP-0175 | UI-02E | 2010 | {{inp.commits}} → c |
| LP-0176 | UI-02E | 2011 | {{inp.files}} → f |
| LP-0177 | UI-02E | 2019 | {{inp.vers}} → x |
| LP-0178 | UI-02E | 2023 | {{inp.job.steps}} → x |
| LP-0179 | UI-02E | 2028 | {{inp.layout}} → l |
| LP-0180 | UI-02 | 2053 | {{pj.stOpts}} → o |
| LP-0181 | UI-02 | 2066 | {{pj.agents}} → a |
| LP-0182 | UI-02 | 2077 | {{pj.rows}} → r |
| LP-0183 | UI-11A | 2096 | {{rp.form.quick}} → q |
| LP-0184 | UI-11A | 2097 | {{rp.form.aud}} → o |
| LP-0185 | UI-11 | 2108 | {{rp.filters}} → f |
| LP-0186 | UI-11 | 2111 | {{rp.rows}} → r |
| LP-0187 | UI-11D | 2125 | {{rp.doc.views}} → o |
| LP-0188 | UI-11D | 2131 | {{rp.doc.sent}} → sn |
| LP-0189 | UI-11B | 2142 | {{rp.doc.kpis}} → k |
| LP-0190 | UI-11B | 2145 | {{rp.doc.issues}} → i |
| LP-0191 | UI-11B | 2151 | {{rp.doc.series}} → x |
| LP-0192 | UI-11B | 2158 | {{rp.doc.det.done}} → t |
| LP-0193 | UI-11B | 2167 | {{rp.doc.det.act}} → t |
| LP-0194 | UI-11B | 2176 | {{rp.doc.det.fail}} → f |
| LP-0195 | UI-11B | 2190 | {{rp.doc.det.att}} → a |
| LP-0196 | UI-11B | 2196 | {{rp.doc.det.rp}} → x |
| LP-0197 | UI-11B | 2199 | {{x.moved}} → m |
| LP-0198 | UI-11B | 2205 | {{rp.doc.gaps}} → g |
| LP-0199 | UI-11B | 2209 | {{rp.doc.det.msg}} → m |
| LP-0200 | UI-11B | 2216 | {{rp.doc.det.next}} → t |
| LP-0201 | UI-11B | 2223 | {{rp.doc.det.all}} → t |
| LP-0202 | UI-11C | 2229 | {{rp.doc.kpisExt}} → k |
| LP-0203 | UI-11C | 2230 | {{rp.doc.summ}} → x |
| LP-0204 | UI-11C | 2235 | {{rp.doc.series}} → x |
| LP-0205 | UI-11C | 2239 | {{rp.doc.highlights}} → x |
| LP-0206 | UI-11C | 2240 | {{rp.doc.risksExt}} → x |
| LP-0207 | UI-11C | 2241 | {{rp.doc.plan}} → x |
| LP-0208 | UI-12 | 2255 | {{cfg.tabs}} → t |
| LP-0209 | UI-12-01A | 2261 | {{cfg.gh.modes}} → o |
| LP-0210 | UI-12-01A | 2268 | {{cfg.gh.scopes}} → x |
| LP-0211 | UI-12-01B | 2276 | {{cfg.online}} → o |
| LP-0212 | UI-12-01B | 2277 | {{cfg.live}} → o |
| LP-0213 | UI-12-01B | 2286 | {{cfg.rd.items}} → x |
| LP-0214 | UI-12-01C | 2297 | {{cfg.cap.days}} → cd |
| LP-0215 | UI-12-01C | 2302 | {{cfg.cap.gaps}} → g |
| LP-0216 | UI-12-01C | 2307 | {{cfg.cap.agents}} → ag |
| LP-0217 | UI-12-01C | 2313 | {{ag.slotOpts}} → o |
| LP-0218 | UI-12-01D | 2331 | {{cfg.cc.modes}} → o |
| LP-0219 | UI-12-01D | 2332 | {{cfg.cc.warns}} → w |
| LP-0220 | UI-12-01D | 2333 | {{cfg.cc.total}} → o |
| LP-0221 | UI-12-01D | 2334 | {{cfg.cc.claude}} → o |
| LP-0222 | UI-12-01D | 2335 | {{cfg.cc.codex}} → o |
| LP-0223 | UI-12-01D | 2336 | {{cfg.cc.heavy}} → o |
| LP-0224 | UI-12-01D | 2337 | {{cfg.cc.mem}} → o |
| LP-0225 | UI-12-01D | 2349 | {{cfg.cc.cgWait}} → w |
| LP-0226 | UI-12-01E | 2356 | {{cfg.cc.ob.sess}} → o |
| LP-0227 | UI-12-01E | 2365 | {{cfg.cc.ob.budgets}} → b |
| LP-0228 | UI-12-01E | 2365 | {{b.opts}} → o |
| LP-0229 | UI-12-01E | 2368 | {{cfg.cc.ob.clis}} → c |
| LP-0230 | UI-12-01D | 2384 | {{cfg.cc.hostHist}} → hh |
| LP-0231 | UI-12-01D | 2390 | {{cfg.cc.log}} → lg |
| LP-0232 | UI-12-02 | 2400 | {{cfg.dev}} → o |
| LP-0233 | UI-12-02 | 2401 | {{cfg.qa}} → o |
| LP-0234 | UI-12-02 | 2404 | {{cfg.flow}} → fs |
| LP-0235 | UI-12-02A | 2412 | {{cfg.ex.agents}} → ag |
| LP-0236 | UI-12-02A | 2417 | {{ag.models}} → m |
| LP-0237 | UI-12-02A | 2424 | {{cfg.ex.usage}} → o |
| LP-0238 | UI-12-02A | 2425 | {{cfg.ex.lowPct}} → o |
| LP-0239 | UI-12-02A | 2426 | {{cfg.ex.rework}} → o |
| LP-0240 | UI-12-02A | 2428 | {{cfg.ex.esc}} → o |
| LP-0241 | UI-12-02A | 2429 | {{cfg.ex.floors}} → f |
| LP-0242 | UI-12-02A | 2429 | {{f.opts}} → o |
| LP-0243 | UI-12-02A | 2430 | {{cfg.ex.locked}} → lk |
| LP-0244 | UI-12-02A | 2431 | {{cfg.ex.alerts}} → al |
| LP-0245 | UI-12-02B | 2438 | {{cfg.sa.en}} → o |
| LP-0246 | UI-12-02B | 2442 | {{cfg.sa.rows}} → x |
| LP-0247 | UI-12-02B | 2448 | {{cfg.sa.refs}} → r |
| LP-0248 | UI-12-03A | 2457 | {{cfg.spl.max}} → o |
| LP-0249 | UI-12-03A | 2458 | {{cfg.spl.min}} → o |
| LP-0250 | UI-12-03A | 2459 | {{cfg.spl.files}} → o |
| LP-0251 | UI-12-03A | 2466 | {{cfg.spl.rules}} → r |
| LP-0252 | UI-12-03A | 2472 | {{cfg.spl.flagged}} → f |
| LP-0253 | UI-12-03B | 2478 | {{cfg.pol.auto}} → o |
| LP-0254 | UI-12-03B | 2479 | {{cfg.pol.cp}} → o |
| LP-0255 | UI-12-03B | 2480 | {{cfg.pol.th}} → o |
| LP-0256 | UI-12-03B | 2481 | {{cfg.pol.assume}} → o |
| LP-0257 | UI-12-03B | 2486 | {{cfg.blackouts}} → b |
| LP-0258 | UI-12-03C | 2506 | {{cfg.stages}} → sg |
| LP-0259 | UI-12-04A | 2520 | {{cfg.mail.recips}} → rc |
| LP-0260 | UI-12-04A | 2524 | {{rc.views}} → o |
| LP-0261 | UI-12-04A | 2536 | {{cfg.mail.fm.views}} → o |
| LP-0262 | UI-12-04B | 2558 | {{cfg.mail.f.secs}} → o |
| LP-0263 | UI-12-04C | 2568 | {{cfg.mail.logF}} → o |
| LP-0264 | UI-12-04C | 2573 | {{cfg.mail.logs}} → lg |
| LP-0265 | UI-12-05A | 2587 | {{cfg.tg.sims}} → o |
| LP-0266 | UI-12-05B | 2611 | {{cfg.tg.rules}} → r |
| LP-0267 | UI-12-05B | 2616 | {{cfg.tg.pvs}} → o |
| LP-0268 | UI-12-05D | 2628 | {{cfg.tg.logF}} → o |
| LP-0269 | UI-12-05D | 2632 | {{cfg.tg.logs}} → lg |
| LP-0270 | UI-12-06 | 2654 | {{cfg.checks}} → ck |
| LP-0271 | UI-12-06 | 2662 | {{cfg.impl}} → im |
| LP-0272 | UI-12-06A | 2667 | {{cfg.pv}} → x |
| LP-0273 | UI-12-06A | 2668 | {{cfg.skOpts}} → o |
| LP-0274 | UI-12-06A | 2670 | {{cfg.pvE}} → x |
| LP-0275 | UI-13 | 2684 | {{pg.items}} → it |
| LP-0276 | MOD-02 | 2715 | {{tgf.res}} → o |
| LP-0277 | MOD-02 | 2717 | {{tgf.cands}} → c |
| LP-0278 | MOD-03 | 2736 | {{mp.views}} → o |
| LP-0279 | MOD-04 | 2753 | {{ms.recips}} → x |
| LP-0280 | MOD-04 | 2754 | {{ms.views}} → o |
| LP-0281 | MOD-05 | 2769 | {{su.rs.wbs}} → x |
| LP-0282 | MOD-05 | 2770 | {{su.rs.runner}} → x |
| LP-0283 | MOD-05 | 2775 | {{su.rs.keep}} → o |
| LP-0284 | MOD-06 | 2789 | {{wz.steps}} → st |
| LP-0285 | MOD-06A | 2795 | {{wz.types}} → o |
| LP-0286 | MOD-06A | 2796 | {{wz.domains}} → o |
| LP-0287 | MOD-06A | 2797 | {{wz.rels}} → o |
| LP-0288 | MOD-06A | 2801 | {{wz.asg}} → o |
| LP-0289 | MOD-06A | 2801 | {{wz.vfy}} → o |
| LP-0290 | MOD-06C | 2817 | {{wz.predList}} → p |
| LP-0291 | MOD-07 | 2863 | {{cpm.rows}} → r |
| LP-0292 | MOD-07 | 2873 | {{cpm.errs}} → e |
| LP-0293 | MOD-07 | 2878 | {{cpm.preview}} → r |

## 로직 전체 읽기 색인

각 행의 줄 범위는 선언 시작~다음 선언 직전 구간이다. 중첩 함수는 소유 메서드 안에 포함된다. 로직 구간 전체를 읽고 UI 변경 흐름과 데이터 출처를 정리했다. 이 색인은 다시 검토할 위치를 알려 준다.

| 선언/메서드 | 줄 범위 |
|---|---|
| LBL | 2909–2933 |
| SPEC_GROUPS | 2934–2942 |
| COLS | 2943–2948 |
| COMPACT | 2949–2951 |
| COLSETS | 2952–2965 |
| DESIGN | 2966–2979 |
| SPEC_TBL | 2980–2983 |
| DOMAIN_TO_DESIGN | 2984–2984 |
| C | 2985–2985 |
| E | 2986–2986 |
| TS | 2987–2987 |
| DESIGNS | 2988–3062 |
| NAV | 3063–3076 |
| PAGES | 3077–3090 |
| MOCK | 3091–3307 |
| Api | 3308–3308 |
| loadProject | 3309–3389 |
| nowStr | 3390–3394 |
| pad2 | 3395–3395 |
| WD_H | 3396–3396 |
| STAGE_PCT | 3397–3397 |
| Cal | 3398–3398 |
| parse | 3399–3399 |
| dayNum | 3400–3400 |
| ymd | 3401–3401 |
| md | 3402–3402 |
| isWork | 3403–3403 |
| toH | 3404–3404 |
| wdToDay | 3405–3405 |
| hToDay | 3406–3407 |
| mins | 3408–3408 |
| attHours | 3409–3414 |
| fmtH | 3415–3416 |
| PA | 3417–3417 |
| SCHED_MOCK | 3418–3431 |
| ATT_TOK | 3432–3433 |
| RUNNER_MOCK | 3434–3441 |
| EXEC_MOCK | 3442–3449 |
| EFF | 3450–3451 |
| SKB | 3452–3452 |
| SKC | 3453–3453 |
| SKR | 3454–3454 |
| SK_HEAD | 3455–3455 |
| SK_LIST | 3456–3456 |
| SK_DOC | 3457–3457 |
| SKELETON | 3458–3471 |
| SUB_MOCK | 3472–3496 |
| OBS_MOCK | 3497–3499 |
| OBS_GRADE | 3500–3500 |
| READY_MOCK | 3501–3508 |
| SPLIT_RULES | 3509–3519 |
| SPLIT_MOCK | 3520–3522 |
| CI_STAGE | 3523–3523 |
| CI_ST | 3524–3524 |
| CI_PIPE | 3525–3530 |
| CI_MOCK | 3531–3549 |
| REPO_LAYOUT | 3550–3551 |
| GH_SCOPES | 3552–3552 |
| GH_MOCK | 3553–3555 |
| TECH_AUTH | 3556–3556 |
| TECH_LV | 3557–3557 |
| TECH_ST | 3558–3558 |
| DS_MOCK | 3559–3637 |
| MAIL_MOCK | 3638–3642 |
| RUN_ROLE | 3643–3643 |
| lines | 3644–3644 |
| emptySpec | 3645–3645 |
| agCls | 3646–3646 |
| agInit | 3647–3651 |
| TG_EV | 3652–3657 |
| TG_RULES0 | 3658–3658 |
| TG_BLANK | 3659–3659 |
| TG_ERR | 3660–3662 |
| Sel | 3663–3663 |
| numbers | 3664–3674 |
| preds | 3675–3675 |
| succs | 3676–3676 |
| depMet | 3677–3681 |
| blockers | 3682–3682 |
| isBlocked | 3683–3683 |
| cl | 3684–3688 |
| gate | 3689–3700 |
| cyclePath | 3701–3712 |
| recKinds | 3713–3713 |
| newTask | 3714–3721 |
| wslPath | 3722–3730 |
| hashOf | 3731–3731 |
| checkPath | 3732–3743 |
| checkGh | 3744–3764 |
| emptyData | 3765–3773 |
| draftWbs | 3774–3784 |
| dayAdd | 3785–3785 |
| uptime | 3786–3795 |
| report | 3796–3870 |
| dueReports | 3871–3878 |
| mkReport | 3879–3883 |
| dsStat | 3884–3890 |
| dsRest | 3891–3896 |
| dsPg | 3897–3903 |
| techProposal | 3904–3914 |
| esc | 3915–3915 |
| mailSubject | 3916–3921 |
| tgMsg | 3922–3929 |
| notify | 3930–3938 |
| tgSamples | 3939–3949 |
| tgResolve | 3950–3950 |
| tgStep | 3951–3952 |
| tgDiff | 3953–3992 |
| tgMock | 3993–4002 |
| mailHtml | 4003–4035 |
| mailReport | 4036–4048 |
| mailPending | 4049–4053 |
| mailOk | 4054–4055 |
| splitBasis | 4056–4056 |
| splitCheck | 4057–4076 |
| wpOf | 4077–4078 |
| subDef | 4079–4079 |
| pickSubs | 4080–4096 |
| recCap | 4097–4105 |
| applyAutoCap | 4106–4107 |
| taskSlots | 4108–4109 |
| subHold | 4110–4114 |
| mockUsed | 4115–4120 |
| conc | 4121–4132 |
| models | 4133–4133 |
| allowed | 4134–4134 |
| modelL | 4135–4135 |
| runAgent | 4136–4136 |
| gradeL | 4137–4137 |
| effKey | 4138–4139 |
| floorN | 4140–4146 |
| pickRun | 4147–4165 |
| runValid | 4166–4167 |
| setRun | 4168–4180 |
| normRuns | 4181–4193 |
| lower | 4194–4199 |
| escalate | 4200–4207 |
| capacity | 4208–4218 |
| schedule | 4219–4284 |
| replan | 4285–4297 |
| driftCheck | 4298–4303 |
| simulate | 4304–4347 |
| flow | 4348–4364 |
| parseAc | 4365–4369 |
| VC | 4370–4370 |
| evKind | 4371–4372 |
| integrity | 4373–4440 |
| IMPL | 4441–4453 |
| FIELD_L | 4454–4454 |
| CPST | 4455–4455 |
| CP_OPS | 4456–4457 |
| Component | 4458–4458 |
| constructor | 4459–4484 |
| busyRun | 4485–4485 |
| bz | 4486–4487 |
| BOOT_STEPS | 4488–4489 |
| IN_STEPS | 4490–4490 |
| setReg | 4491–4491 |
| checkReg | 4492–4497 |
| submitReg | 4498–4504 |
| regApply | 4505–4511 |
| bootStep | 4512–4523 |
| bootTick | 4524–4530 |
| retryBoot | 4531–4531 |
| retryIn | 4532–4532 |
| toggleBootPause | 4533–4533 |
| approveBoot | 4534–4547 |
| reBoot | 4548–4553 |
| setSplit | 4554–4554 |
| toggleRule | 4555–4556 |
| proposeSplit | 4557–4581 |
| addSplitExc | 4582–4583 |
| setSubEnabled | 4584–4584 |
| toggleSub | 4585–4589 |
| recheckReady | 4590–4590 |
| breakReady | 4591–4591 |
| obsCut | 4592–4592 |
| obsFix | 4593–4593 |
| setBudget | 4594–4594 |
| cliUpgrade | 4595–4596 |
| fixReady | 4597–4599 |
| preview | 4600–4643 |
| setIn | 4644–4644 |
| inFetch | 4645–4652 |
| inSkip | 4653–4653 |
| inAnalyze | 4654–4667 |
| inTick | 4668–4693 |
| openReset | 4694–4694 |
| setRs | 4695–4695 |
| resetImpact | 4696–4701 |
| exportBeforeReset | 4702–4707 |
| runReset | 4708–4719 |
| runCleanup | 4720–4725 |
| ciSet | 4726–4726 |
| ciOpen | 4727–4727 |
| ciNext | 4728–4728 |
| ciRetry | 4729–4735 |
| ciIntFail | 4736–4745 |
| ciGuard | 4746–4754 |
| ciDeploy | 4755–4763 |
| ciFlaky | 4764–4764 |
| ciVM | 4765–4801 |
| ghSet | 4802–4802 |
| ghMode | 4803–4803 |
| ghSaveToken | 4804–4808 |
| ghCheck | 4809–4809 |
| ghBreak | 4810–4812 |
| dsSet | 4813–4813 |
| dsOpen | 4814–4814 |
| dsDecide | 4815–4824 |
| dsChangeReq | 4825–4830 |
| dsDrift | 4831–4835 |
| dsParseFail | 4836–4843 |
| setRegTech | 4844–4844 |
| addRegTech | 4845–4845 |
| delRegTech | 4846–4847 |
| techPick | 4848–4848 |
| approveTech | 4849–4856 |
| dsVM | 4857–4932 |
| setMailForm | 4933–4933 |
| addRecip | 4934–4941 |
| setRecip | 4942–4942 |
| delRecip | 4943–4943 |
| testRecip | 4944–4948 |
| smtpEdit | 4949–4949 |
| setSmtp | 4950–4950 |
| saveSmtp | 4951–4957 |
| checkSmtp | 4958–4961 |
| mailBreak | 4962–4966 |
| resend | 4967–4973 |
| resendAll | 4974–4976 |
| openSend | 4977–4979 |
| doSend | 4980–4982 |
| genDue | 4983–4987 |
| runDue | 4988–4988 |
| openReport | 4989–4989 |
| setRpForm | 4990–4990 |
| createReport | 4991–4999 |
| printReport | 5000–5012 |
| componentWillUnmount | 5013–5013 |
| later | 5014–5016 |
| mutate | 5017–5036 |
| consumeFault | 5037–5043 |
| pickUi | 5044–5044 |
| retryErr | 5045–5050 |
| discardErr | 5051–5051 |
| ask | 5052–5052 |
| dirty | 5053–5053 |
| guard | 5054–5055 |
| openTask | 5056–5062 |
| goBack | 5063–5063 |
| pickTab | 5064–5074 |
| wrailIds | 5075–5093 |
| wrailVM | 5094–5103 |
| buildRows | 5104–5158 |
| taskRow | 5159–5174 |
| schedFields | 5175–5187 |
| segs | 5188–5190 |
| mlines | 5191–5203 |
| detail | 5204–5327 |
| addDep | 5328–5341 |
| toggleCl | 5342–5346 |
| addCl | 5347–5353 |
| saveSpec | 5354–5361 |
| startOv | 5362–5365 |
| ovDiff | 5366–5371 |
| saveOv | 5372–5388 |
| completeTask | 5389–5398 |
| draftOf | 5399–5402 |
| setDraft | 5403–5403 |
| sendMsg | 5404–5412 |
| deliver | 5413–5431 |
| readTable | 5432–5443 |
| editTable | 5444–5452 |
| recKinds | 5453–5453 |
| knownTables | 5454–5461 |
| designView | 5462–5500 |
| toDraftBlocks | 5501–5505 |
| fromDraftBlocks | 5506–5513 |
| edBlocks | 5514–5518 |
| blankEnt | 5519–5522 |
| openEnt | 5523–5530 |
| openBlk | 5531–5536 |
| openSpecTbl | 5537–5542 |
| edPatch | 5543–5543 |
| edField | 5544–5544 |
| edBlock | 5545–5545 |
| edCell | 5546–5546 |
| edAddRow | 5547–5547 |
| edDelRow | 5548–5548 |
| validateEd | 5549–5591 |
| saveEd | 5592–5615 |
| askDelEnt | 5616–5624 |
| addSec | 5625–5627 |
| askRemSec | 5628–5636 |
| goTask | 5637–5637 |
| goExec | 5638–5638 |
| goCp | 5639–5639 |
| goPlan | 5640–5641 |
| opText | 5642–5650 |
| diffRows | 5651–5668 |
| impactRows | 5669–5690 |
| cpTargets | 5691–5691 |
| planOps | 5692–5696 |
| withBefore | 5697–5703 |
| plSet | 5704–5704 |
| plStep | 5705–5711 |
| makeCpFromPlan | 5712–5724 |
| cpAct | 5725–5734 |
| cpRemoveOp | 5735–5738 |
| applyCp | 5739–5763 |
| openCpm | 5764–5768 |
| cpmSet | 5769–5769 |
| cpmRow | 5770–5770 |
| cpmBuild | 5771–5791 |
| submitCpm | 5792–5805 |
| startAttempt | 5806–5856 |
| openExForm | 5857–5863 |
| openRework | 5864–5868 |
| exSet | 5869–5869 |
| exErrs | 5870–5876 |
| submitEx | 5877–5882 |
| registerDev | 5883–5901 |
| registerQa | 5902–5920 |
| sendRework | 5921–5928 |
| respond | 5929–5941 |
| flowSteps | 5942–5948 |
| plVM | 5949–5987 |
| cpVM | 5988–6009 |
| cpmVM | 6010–6018 |
| exVM | 6019–6079 |
| capReason | 6080–6092 |
| useTokens | 6093–6097 |
| interruptAll | 6098–6104 |
| stopRunner | 6105–6113 |
| startRunner | 6114–6118 |
| tokenLimit | 6119–6127 |
| resetUsage | 6128–6128 |
| runPlanner | 6129–6133 |
| setPolicy | 6134–6134 |
| setCapMode | 6135–6140 |
| switchHost | 6141–6162 |
| setCap | 6163–6169 |
| runnerAdjust | 6170–6184 |
| afterRun | 6185–6185 |
| repickIdle | 6186–6194 |
| openRunEdit | 6195–6195 |
| setRunEdit | 6196–6196 |
| saveRunEdit | 6197–6205 |
| unlockRun | 6206–6209 |
| toggleModel | 6210–6216 |
| setRunPolicy | 6217–6217 |
| setEscNotify | 6218–6218 |
| toggleFloor | 6219–6223 |
| dismissAlert | 6224–6224 |
| addBlackout | 6225–6231 |
| delBlackout | 6232–6234 |
| goWbsFilter | 6235–6237 |
| goVerif | 6238–6238 |
| vfSet | 6239–6239 |
| hfSet | 6240–6240 |
| toggleEvLink | 6241–6245 |
| addEvidence | 6246–6252 |
| runVM | 6253–6273 |
| dashVM | 6274–6333 |
| vfVM | 6334–6369 |
| rpVM | 6370–6447 |
| hVM | 6448–6460 |
| pjVM | 6461–6494 |
| mailVM | 6495–6532 |
| mailPvVM | 6533–6541 |
| mailSendVM | 6542–6552 |
| tgDraft | 6553–6553 |
| tgHasTok | 6554–6554 |
| tgEdit | 6555–6563 |
| tgBot | 6564–6569 |
| tgChatOk | 6570–6570 |
| tgTest | 6571–6580 |
| tgSave | 6581–6589 |
| tgDrain | 6590–6590 |
| tgCancel | 6591–6591 |
| tgFresh | 6592–6592 |
| tgFindOpen | 6593–6593 |
| tgFindQuery | 6594–6596 |
| tgFindPick | 6597–6597 |
| tgRule | 6598–6598 |
| tgRuleSave | 6599–6599 |
| tgRuleCancel | 6600–6600 |
| tgGo | 6601–6601 |
| appUrlSave | 6602–6604 |
| tgVM | 6605–6646 |
| setVM | 6647–6781 |
| wizDefault | 6782–6785 |
| wset | 6786–6786 |
| wizErrs | 6787–6787 |
| wizNext | 6788–6794 |
| createTask | 6795–6813 |
| renderVals | 6814–6840 |
| loadFlags | 6841–6843 |
| errFlags | 6844–6865 |
| renderVals0 | 6866–6881 |
| emptyFlags | 6882–6893 |
| setupVM | 6894–6938 |
| inputVM | 6939–6955 |
| rsVM | 6956–6967 |
| renderMain | 6968–7118 |
