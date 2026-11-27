# 화면 데이터와 변경 동작

> 처음 읽는다면 [README.md](README.md)의 ID 읽는 법과 용어집을 먼저 본다.

## 이 문서의 역할

이 문서는 각 화면이 **어떤 데이터를 읽고, 무엇을 바꾸는지** 정리한다.

- 현재 제품 판정/계약 기준은 `keeproll/plan-baseline` **a60216d**다.
- 아래 생성 영역은 원본 메모리 모델(프로토타입이 브라우저 메모리에만 들고 있는 데이터)의 관측이다.
- 원본에 없는 owner 동작도 계약 데이터가 필요하다. 그 목록이 바로 아래에 있다.

## 원본에 없지만 제품에 필요한 데이터

owner 결정으로 생긴 동작은 원본에 없으므로 생성 영역에 나오지 않는다. 그래서 여기에 따로 적는다.

### UI-03E/명세·이력 / UAT-APPROVE-01

- 조회·변경 데이터: 명세 완료 여부·approval 상태·승인/반려 요청 결과·주체/시각/사유 이력.
- 승인=ready, 반려=planning.
- 로그인/권한 실패는 상태 미변경.
- 근거: open-questions §0 Q-02/Q-05 #2·#3; contracts §2.1 approve/reject.

### UI-06·Runner / UAT-EXEC-09

- 조회·변경 데이터: 중단 시도 interrupted·Task paused·보유/잠금 해제 증거·재개 거부 reasons[]·동일 단계/등급의 새 attempt.
- 같은 host의 그룹 해제와 PC 변경의 별도 격리 규칙은 구분한다.
- 용어: "보유"는 Runner가 실행 자리(슬롯)를 아직 쓰는 중으로 잡아 두는 것이다. "보유/잠금 해제 증거"는 이전 프로세스가 더는 남아 있지 않다는 Runner 보고다.
  - **같은 PC**에서 다시 실행하려면 유효한 해제 증거가 필요하다. 증거는 세 가지뿐이다: 프로세스를 만든 적 없음(`no_process`), 그룹과 자손이 모두 종료됨(`group_empty`), 같은 PC의 부팅 번호가 바뀜(`boot_changed`). 출력 단절·lease 만료·시간 경과는 증거가 아니다(계획 contracts §3.4-2).
    - 왜: 끝나지 않은 프로세스가 남은 채로 같은 PC에서 새 시도를 시작하면 같은 작업이 두 번 돌 수 있기 때문이다.
  - **PC가 바뀐 경우**는 예외다. 옛 PC의 보유는 미확인으로 남기되 새 PC의 슬롯 계산과 재개 차단에서는 제외한다. 그래서 새 PC는 옛 PC의 종료 보고 없이도 로컬에서 dev·①·QA까지 재개할 수 있다. 대신 push·PR·병합 같은 GitHub 쓰기는 별도로 409 `EXTERNAL_WRITE_BLOCKED`로 막고, 정해진 해제 조건을 거친 뒤 허용한다(계획 contracts §3.4-5).
- 근거: contracts §3.4/§4.3; Q-05 #10.

### UI-03-03·UI-09A / UAT-TASK-06

- 조회·변경 데이터: 실제 actStart·미충족 선행 목록·원자적으로 제거된 SS 관계.
- impact.removedDependencies[{pred,succ,type,reason}], unblockedSuccessors[{taskKey,remainingBlockers[]}].
- 실제 해소와 남은 차단을 구분한다.
- 근거: D-27; contracts §2.1 proposals.

### UI-05-02 / UAT-PLAN-02

- 조회·변경 데이터: 자동 정책·202 pending 기록·기준선 버전·수동 재조정 실행 결과·RP 전후/주체/계기.
- 자동 꺼짐 상태의 pending만으로는 기준이 변경되지 않는다. 실행 확정은 POST /api/replans/run이다.
- 근거: D-10; contracts §2.1 replans.

### UI-06 / UAT-EXEC-06

- 조회·변경 데이터: 종류별 연속 프로세스 실패 횟수·성공 초기화·QA+통합 합산 재작업 횟수·1회 수동 실행 허용.
- 중단/BLOCKED와 시작 전 실패는 별도 조치다.
- 근거: contracts §3.5.

### SYS-02 저장 공통(useSave) / UAT-STATE-06·07

- 모든 화면의 저장 버튼은 공통 도우미 `useSave`(`apps/web/src/shared/state/useSave.tsx`)를 쓴다. 멱등 키, 결과 모름 재시도, 충돌 창을 한곳에서 처리한다.
- **응답이 온 뒤에 부르는 콜백은 응답 시점의 최신 값을 쓴다**(M6 통합, M6-07 fix2 보고 5).
  - 대상: `onSuccess`·`onFieldErrors`·`onRejected`·`successNotice`.
  - 요청 자체(보낼 내용과 멱등 키)는 저장 버튼을 누른 때의 값 그대로다. 「다시 시도」도 처음 요청과 같은 내용·같은 키로 보낸다.
  - 왜: 누른 때의 콜백은 그때의 초안을 본다. 응답을 기다리는 동안 사용자가 초안을 더 고치면, 「저장한 내용과 지금 초안이 같으면 닫기」가 늘 참이 되어 고친 내용이 사라진다.
  - 예: 개요 탭은 성공했을 때 「성공한 요청 내용 = 지금 초안」일 때만 편집을 닫는다. 다르면 서버 값만 새로 받고 초안은 둔다.
- 근거: contracts §1(멱등), G§0.3 오류 처리 규칙.

### SYS-02 세션 만료 초안 보관 / UAT-STATE-06

- 편집 중 로그인이 끊기면(401) 화면별 초안을 그 탭의 `sessionStorage`에 남긴다. 다시 로그인한 뒤 같은 화면을 열면 복원을 제안한다(`apps/web/src/shared/state/sessionDrafts.ts`, 조정자 결정 2026-11-27).
  - 초안은 남긴 탭에서만 읽는다. 다른 탭으로 복사돼 온 초안은 복원하지 않고 지운다.
  - 비밀값(비밀번호·토큰·키)은 저장하지 않는다(G L554, UAT-GITHUB-02).
  - 사용자가 직접 로그아웃하면 보관 초안을 바로 모두 지운다. 다른 탭에도 알리고(BroadcastChannel), 알림을 못 받은 탭도 「로그아웃 이전에 보관된 초안」은 복원 전에 버린다.
- **순서 비교는 모든 탭이 공유하는 단조 세션 번호로 한다**(M5·M7 통합).
  - 로그인·로그아웃·초안 보관·페이지 열기마다 번호를 붙인다. 번호는 「지금 벽시계 값」과 「모든 탭에서 마지막으로 쓴 번호 + 1」 중 큰 값이고, `localStorage`(`awbs.sessionStamp`)에 둔다.
  - 왜: 벽시계가 뒤로 가면(이 PC는 약 32초마다 약 2.3초) 나중의 로그아웃이 앞선 로그인보다 작은 시각으로 찍힌다. 그러면 로그아웃 뒤에도 초안 보관을 허용하는 쪽으로 틀린다.
  - 예: 로그인 번호 1000 → 시계가 2초 뒤로 감 → 로그아웃 때 벽시계는 998이지만 번호는 1001이다. 그래서 「로그아웃이 로그인 뒤」라는 순서가 지켜진다.
  - 저장소가 막혀 있으면 벽시계 값을 그대로 쓴다.
- 규칙 하나: 로그아웃 알림을 받았거나 로그아웃 번호가 이 탭의 마지막 로그인 번호 이상이면, 새 로그인이 성공하기 전까지 어떤 401에서도 초안을 보관하지 않는다.
- 근거: architecture §6.4 「벽시계는 뒤로 갈 수 있다고 본다」.

## 빈 목록과 Mock 교체

빈 목록은 데이터 존재 여부와 필터 결과 개수를 구분할 수 있어야 한다.

- 왜: "데이터가 없음"과 "검색 조건에 맞는 것이 없음"을 사용자에게 다르게 안내해야 하기 때문이다.
- 구체 화면·문구·발생 조건·판정 ID는 [acceptance-coverage.md](acceptance-coverage.md)에 있다.
- 원본 타이머·하드코딩을 실제 보고로 바꾸는 요구는 기존 Mock 교체 표와 각 UAT를 따른다.

## 원본 데이터가 어디에 있나

- 조회는 원본 `Api.loadProject()`(3308–3387)다.
- 전시 데이터는 `MOCK`(3091–3306)다.
- 설계 샘플은 `DESIGNS`(2988–3062)다.
- 추가 모델은 3395–3662줄이다.

원본은 클라이언트 메모리뿐이며 reload(새로고침)하면 초기화된다.

원본 코드의 역할 이름:

- `Sel`: 판정/계산.
- `*VM`: 화면에 보여 주기 위한 전시 변환.
- `mutate`(5017–5035): 복제→변경→상태전이 알림→실행등급 정규화→추가 이력 저장을 수행한다.

실제 결정은 가이드 157–169,1004–1012에 따라 서버에서 수행해야 한다. 브라우저에서 판정하면 조작될 수 있고 여러 사용자의 결과가 어긋날 수 있기 때문이다.

## 데이터 객체와 키

표 읽는 법: 한 행이 원본의 데이터 객체 하나다. 가운데 열은 원본 필드 이름이고, 오른쪽 열은 원본 줄 번호다. 필드 이름은 코드 그대로이므로 번역하지 않았다.

| 객체 | 필수로 보여주거나 사용하는 필드 | 원본 |
|---|---|---|
| Project | id/name/desc/status/start/target/lead/registered/phase/epoch/regAt/regBy/instr/repo/inputs/boot/inJob/inPending/inSkipped/techReq | 3092,3359–3374,3765–3782,4482–4491 |
| Phase / Work Package | id/title/wps; WP id/title/tasks[] | 3093–3101,3664–3674 |
| Task | id/title/type/domain/rel/status/priority/assignee/verifier/verif/approved/defects/updated; purpose/background/scope/out/precond/doneCond/outputs/spec/checklist/design; est/lo/hi/tok/conf/basis/estBy/fixStart/actStart/actEnd/cg/srcV; run/vrun/subs/split | 3102–3236,3317–3359,3713–3721 |
| Task Specification | req/work/steps/inputs/outputs/files/constraints/errors/docs/ac/verify; 제외범위는 Task.out; 공식 산출물은 Task.outputs | 2934–2941,3645,5219–5235 |
| AC | given/when/then/method | 2963,3312–3316,4366–4370 |
| Output | name/kind/required/verify/delivered | 2964,3324,5886–5898 |
| Dependency | id/pred/succ/type; 충족/차단/순환 path는 계산 | 3238–3246,3675–3711 |
| Checklist | id/text/required/done/method/evidence/note | 3102–3236,5342–5353 |
| Technical Specification | kind DB/API/FE/DevOps; ents[{f,b}]; b 영역별 블록 | 2952–2983,2988–3062 |
| Attempt | id/task/kind/agent/status/start/end/summary/files/fail/tok/model/effort/esc/escKind; subs/subInst/sub/obsSt/obsAt/used | 3252–3262,3330–3358,5806–5856 |
| Verification | id/task/attempt/agent/result/at/cmd/expected/actual/evidence[]/defects[] | 3263–3267,5902–5920 |
| Evidence | 원본은 경로 문자열; kind는 확장자 계산; 검증에 소속; checklist.evidence 연결 | 4373,6241–6252,6334–6369 |
| Message | id/task/dir/from/to/type/at/attempt/body/delivery/work/failReason/pendingNext/unread | 3268–3275,5399–5431,5921–5941 |
| Planning | id/title/scope/at/analyses/review/cp; 분석 agent/summary/items/at; review id/kind/topic/codex/claude/choice/resolved/memo/ops | 3276–3293,5692–5724 |
| Change Proposal | id/title/reason/source/status/author/at/idMap/ops/approvals/appliedAt; approval at/actor/action/comment | 3294–3306,4454–4456,5712–5805 |
| History | id/at/actor/task/kind/text/before/after | 3300–3306,5017–5035 |
| Run grade | model/effort/locked/basis/by/at; 개발 run과 검증 vrun 분리 | 4140–4220,6195–6209 |
| Subagent definition / assignment / usage | defs id/agent/role/tools/sandbox/v/hash/text/ref/allowed/updated; 지정 dev/qa id/why/by; 시도 subs id/v; used list id/v/n/conf/at | 3472–3499,4100–4138,4581–4599 |
| Runner readiness | at/items[{k,l,v,st,fix}] | 3501–3508,4589–4599 |
| Runner session / usage | sessions from/to/end; usage Agent별 remain/reset/at; heartbeat 설정 | 3434–3441,3330–3333,6080–6128 |
| Host / concurrency / observation | host id/cpu/cores/memGB/swapGB/diskGB/os/perSessGB/perSessN/at/hist; conc mode/cap/cur/step/subRatio/res/log; obs budget/enforce/cli | 3346–3358,3497–3500,4095–4134,6135–6184 |
| Schedule / baseline / replan | sched policy/blackouts/baselines/replans; baseline v/at/reason/rp/ends/projEnd/lo/hi; RP id/at/trigger/by/auto/v/before/after/lo/hi/rate/moved | 3360–3364,4221–4305 |
| Report snapshot | id/kind/from/to/at/by/data/view/late/lateL; data KPI/상세Task/추세/실행/재조정/메시지/중단/예정 등 | 3797–3882,6370–6447 |
| Mail | smtp host/port/sec/from/user/pwSet/ok/checkedAt/err; recips id/email/name/daily/weekly/view/pdf/active/at; log id/at/rep/to/rid/view/pdf/subject/st/err/why; seq | 3638–3642,4003–4054,4933–4987 |
| Telegram | conf on/tokenSet/tokenLast4/bot/botSt/botKind/botErr/target/chatId/chat/test/testKind/testErr; rules6종; log id/at/kind/ev/proj/target/nav/to/key/st/tries/err/msg/dup/resolved; seq | 3652–3662,3922–4002,6553–6646 |
| GitHub | mode/ok/account/checkedAt/err/tokenSet/expires/scopes | 3550–3553,4802–4812 |
| Input version / job | v/at/commit/msg/proto/md/changes/commits/note/instr/result; pending sha/at/author/msg/files; job v/st/at/steps/cp/fail | 3359–3374,4644–4693 |
| Design ledger | decisions/comps/links/files/ifaces/stores/own/versions/drifts/parseErr | 3556–3636,3884–3924,4813–4932 |
| CI | main/runs/queue/flaky/settings/deploy; run id/stage/task/att/ref/pr/at/dur/st/trig/failStep/log/note/url/merged; pipe stages/steps/gate/rules | 3523–3549,4726–4801 |
| System reset / cleanup | sys.resets at/by/from/to/name/kept/runner/n; cleanup at/epoch/jobs | 4694–4725,6956–6967 |

표에 관한 주의:

- WBS 번호는 Phase/WP 내 위치로 계산하는 표시값이다. 참조 키는 Task ID다.
  - 왜: Task 순서가 바뀌면 WBS 번호도 바뀌므로, 다른 데이터가 가리킬 때는 바뀌지 않는 Task ID를 써야 한다.
- UUID 기반 DB 테이블 예시는 만들어지는 샘플 제품의 설계다. 이 조사에서 Agent WBS DB schema를 확정한 것이 아니다.
- 화면에서 사용하는 문자열 날짜는 원본 표현이다. 실제 저장 시간대는 가이드 1014–1020에 따라 UTC 저장/Asia·Seoul 표시가 필요하다.

## 열거값과 기본값

열거값(enum)은 한 필드가 가질 수 있는 값의 전체 목록이다.

| 항목 | 원본 값 |
|---|---|
| 프로젝트 상태 | 준비, 진행 중, 보류, 종료 (P6490) |
| 병합 대기열 상태 | 검증 대기, 통합 확인 중, 통합 실패 — 재작업 요청, 병합됨 (원본 CI_MOCK·CI VM) |
| 불안정 테스트 상태 | 격리, 정상, 정상 (격리 해제); 원본은 토글시 정상 (격리 해제) 표시(P4764) |
| Task type | Analysis, Design, Implementation, Configuration, Test, Verification, Documentation, Integration |
| domain | FE, BE, DB, DevOps, API, QA, Architecture, Common |
| status 표시 순서 | planning, approval, ready, running, paused, qa, rework, verifying, gate, failed, done, cancelled |
| priority | 0 긴급, 1 높음, 2 보통, 3 낮음 |
| verif | none, running, pass, fail, blocked |
| Verification.result | PASS, FAIL, BLOCKED |
| Attempt.status / kind | 실행 중, 완료, 실패, 중단 / 개발, QA, 재작업, 재검증 및 샘플 분석·검토 |
| Agent / role | Claude, Codex / dev, qa |
| Message.dir / type | out,in / 추가 지시,수정 요청,질문,일반 의견,응답 |
| Message.delivery | Draft, Queued, Sent, Acknowledged, Failed, Cancelled |
| Dependency | FS, SS |
| Effort 공통 | low(1),medium(2),high(3),xhigh(4),max(5). 제품 CLI 매핑은 owner Q-06 승인표를 적용하고 ultra/미확인 값은 사용하지 않음 |
| CP.status | draft,review,changes,approved,rejected,applied |
| CP op | add,modify,remove,dep-add,dep-remove; 작성 모달은 scopeAdd,doneCond,priority,assignee,acAdd,depAdd,depRemove만 노출 |
| project.phase | none,boot,active |
| bootstrap / input step | wait,run,done,fail |
| technical authority / level / state | lead,agent,free / must,cond,ban / fixed,approved,pending,rejected,noted,chg |
| design interface / store | REST,WebSocket,SSE,Kafka / pg,neo4j,questdb,redis |
| CI stage / result | task,int,night,deploy / pass,fail,run,queued,skip |
| report.kind / view | daily,weekly,custom / int,ext |
| SMTP security / delivery | STARTTLS,SSL/TLS,없음 / 발송됨,실패 |
| Telegram event defaults | done:false,fail:true,admin:true,approve:true,buildOk:false,buildFail:true |
| Telegram transmission | 대기,전송 요청 수락,실패,재시도 대기. 읽음/도착/승인은 없음 |
| Telegram Mock response | ok,token,nochat,block,net,limit |
| observation grade / state | ok,partial,unver / ok,unconf |
| concurrency mode | auto,manual |
| split result | 통과,의심,위반,주의,판단,예외,꺼짐 |
| FE design state / index / output kind | Loading,Empty,Error,Success,Disabled / BTREE,UNIQUE,GIN,HASH / 코드,문서,Migration,테스트,설정 |

원본의 기본값과 정책값:

- 추정 신뢰도 상/중/하
- 재작업정책 same/up1/top
- 사용량정책 wait/down
- 기본 lowPct20/escNotify2
- 기본 분할 maxH4/minH0.5/maxFiles8
- 예산 dev2/qa3
- 기본 heartbeat60초
- 일정 threshold1일/assumeRate0.6

위 표는 **원본 열거값**이다. 제품은 아래 owner 결정을 우선한다.

- Q-02 착수승인·자동done
- Q-04 자동재시도2회/총3회·자동재작업3회
- Q-05 BLOCKED 대표상태유지
- Q-06 Effort표
- Q-12 최신CLI/미검증재검증
- 추가 owner 결정: 시작전취소 SS 관계를 제거하고 CP영향에 풀리는후속을 표시한다.

값은 [data-model.json](evidence/data-model.json)의 constants 및 schema와 함께 확인한다.
고정 수치는 제품 요구와 Mock 가정을 구분해야 한다. 가이드 1088–1125에 교체 목록이 있다.

## UI 상태와 영속 변경의 구분

UI state는 화면에서만 쓰고 서버에 저장하지 않는 상태다. 아래는 원본 UI state다.

- 검색·필터·정렬·접힘·선택 Task/탭·레일·상세 위치·읽기/편집 전환·모달·입력 초안.
- 메시지 초안은 Task별 drafts에만 보관되고 reload 보존은 없다.

owner Q-01의 UI-AUTH는 원본에 없으며 아래가 추가 데이터다.

- LAN password 입력/실패/429
- loopback link token 일회소비/URL제거/로그인후복귀
- 비밀번호·링크토큰을 샘플 엔티티나 내보내기에 넣지 않는다. 비밀값이 파일로 새어 나가면 안 되기 때문이다.

실제 제품 URL 요구(`/wbs/:id`, `/settings/:tab`)는 가이드283,348줄이며 원본에는 라우팅이 없다.

영속 변경은 서버에 저장되어 새로고침해도 남는 변경이다.

- 저장되는 업무 변경: Task/명세/설계/체크리스트/의존성/등급/정책/메시지/실행결과/검증/Evidence/CP/승인/일정기준/보고서/수신·연결설정/알림규칙/초기화.
- 메시지 본문이 Task 명세를 직접 바꾸지 않는다. CP 승인/반영이 필요하다.
- 실제 서버에서는 트랜잭션·버전 충돌·멱등성(같은 요청을 여러 번 보내도 결과가 한 번과 같은 성질)을 함께 구현해야 한다.
- 원본의 낙관적 잠금 오류는 주입 UI일 뿐, 실제 동시 저장을 재현하지 않는다.

## 실제 백엔드·Runner가 필요한 모사 동작

모사 동작은 원본이 타이머나 고정값으로 "흉내만" 내는 동작이다. 제품에서는 오른쪽 열의 실제 공급자가 해야 한다.

| 기능 | 원본 모사 | 실제 공급자 / 참고 계약 |
|---|---|---|
| 최초 로드·저장 | 메모리 JSON deep copy; reload 초기화 | Agent WBS API+PostgreSQL; 가이드 875–889,1004–1012 |
| 저장·로딩·버튼 busy | setTimeout, busyRun, renderVals; 첫800ms/메뉴450ms/필터350ms/재계산500ms | API 실제 pending/응답, 약200ms이내 표시 생략; 실패 응답코드 |
| GitHub 접근·권한 | checkGh는 URL단어 missing/noproto/nodocs/new/empty로 결과 선택, 커밋은 hashOf | Runner git/gh; repo-checks, input-changes; 가이드 917–935 |
| 입력 변경·분석 | 하드코딩 커밋/파일; inTick 700/900ms; 분석항목·신규/수정 Task 고정 | main 경로 diff+Planning Agent; srcV 고정; 가이드 243–250 |
| 초기 분석·WBS 초안 | bootStep/bootTick 타이머; sample draft 11Task | Runner progress+Planning draft+팀장 기술결정/초안승인 |
| 모델·등급·분할 | 고정 모델목록, 규칙 기반 pickRun, ±15% 계수; 영역별 고정2분할 | Runner 모델보고, Planning 추정/합의/분할 제안 |
| Agent 실행·설치·결과 | startAttempt는 메모리 시도 생성; 설치 성공 가정, subFail 1회; 팀장 폼으로 결과 등록 | Runner worktree·CLI·실행트리·result/interrupt API |
| 메시지 | deliver 1000ms→Sent→1400ms→Acknowledged; respond 2200ms 고정문장 | Runner polling/ack/실제 Agent 응답, pendingNext 재실행 시 전달 |
| 가동률·자원·사용량 | 고정 세션/자원/사양/리셋; 안정/메모리/429/PC선택 버튼 | heartbeat/host/concurrency/usage/readiness 실제 보고 |
| 하위 Agent 관측 | sub 수 수동·mockUsed 고정, CLI 업그레이드/프로세스그룹확인 버튼 | stream 관측+프로세스그룹/cgroup 종료확정; transcript 사용확정 |
| 빌드·통합 | CI_MOCK; retry 항상 pass 복제; deploy 성공·실패 고정 | Runner가 main 파이프라인 실행 후 ci/runs 보고, GitHub status/병합 |
| 설계 | REST/PostgreSQL만 Task에서 집계, 나머지 DS_MOCK; 처리버튼은 상태문자 변경 | Runner가 contracts 해석/코드 대조하여 design/snapshot 보고 |
| 보고서 정기 생성 | constructor genDue, 수동 runDue; 날짜별 샘플 생성 | WBS 서버 스케줄러 Asia/Seoul 일간7시/월7시, 누락보충·중복방지 |
| PDF/내보내기 | iframe print; JSON Blob만 다운로드 | 서버 같은 HTML→PDF; 실제 파일·Evidence 포함 내보내기는 가이드/범위 결정 필요 |
| 메일 | smtp.ok에 따라 발송로그만 생성; seed에 15분후 재시도 기록 | WBS SMTP 발송큐·실제 연결·15분후1회 재시도; 가이드 937–956 |
| Telegram | API미호출; tgSim 결과; 429 실제2.5초 후 성공처리(표시는15초) | WBS outbox+Bot API, retry_after/백오프; 가이드 987–1000,1069–1076 |
| 초기화·cleanup | 메모리 즉시삭제·epoch증가, 온라인이면 정리완료로 표시 | WBS 삭제트랜잭션+Runner commands/cleanup결과; GitHub 되돌림커밋·PR닫기·브랜치정리 |

표에 관한 주의:

- 원본에 실제 API 호출이 없으므로 기능별 서버 엔드포인트는 가이드 §8에 명시된 것만 계약으로 사용한다. 여기서 새 경로를 설계하지 않았다.
- Runner 내부 UI·세션 실시간 관찰·별도 채팅 서버는 범위 밖이다.
- DS_MOCK의 Kafka/Redis/Neo4j/QuestDB는 화면 표현 예시다. Agent WBS 자체의 인프라 도입 요구가 아니다.

## 실제 API 구현에서 빠뜨리면 안 되는 연결

아래 항목이 모두 필요하다.

- Task ID 기반 참조
- 목록→선택→상세의 동일 버전 데이터
- 서버 판정 차단/Gate/CP/일정
- append-only(덧붙이기만 하고 고치지 않는) Attempt/Verification/History/기준 버전
- 입력커밋 고정
- `X-Project-Epoch` 불일치409
- 수정 updatedAt/version 충돌409
- Runner 재전송 멱등성
- 보고서 불변 snapshot
- 메일/Telegram 비밀 쓰기전용과 로그/응답/내보내기 마스킹

이들은 가이드 명시 요구이고, 원본만으로 구현 완료를 증명할 수 없다.

<!-- GENERATED: extract.py -->

## 화면 ID별 조회 데이터와 변경 결과

아래 변경은 **원본 메모리 동작**이다. API 명세가 주어진 경우는 본문 계약 표를 따른다. 명세가 없는 경우 경로/HTTP 메서드를 새로 지어내지 않았다. UI만 바꾸는 탭·필터·초안과 영속 데이터 변경은 본문에서 구분한다.

| 화면 ID | 필요한 데이터/입력 | 원본 변경·이동 결과 | 출처 로직 |
|---|---|---|---|
| UI-00 앱 셸·전역 메뉴 | 프로젝트명; Runner; 사용자 팀장; NAV 12개 | 햄버거로 메뉴 180px↔56px 전환 / 메뉴 선택 시 해당 화면과 선택 강조가 바뀜 / 등록/초기 승인 전에는 프로젝트와 설정만 접근됨 / Runner 버튼은 프로토타입 연결 상태를 전환함 | 7053-7088 |
| UI-01 대시보드 | 일정·진척 KPI; Task 지표; 행동 패널 6개; 유형/영역 분포; 실행 등급별 결과; 최근 8건 | KPI와 행동 패널에서 해당 WBS 필터 또는 관련 화면으로 이동 / 유형/영역 분포 선택이 WBS 필터를 적용 / 실행 등급별 시도/판정/FAIL/재작업률/상향/토큰 표시 / 최근 실행·검증이 관련 상세로 이동 | 6274-6333 |
| UI-02 프로젝트 | 프로젝트 ID/이름/상태/시작/목표/책임자/설명; 기간·규모·작업량; Agent 참여; WBS 구조 | 프로젝트 정보 편집 저장/취소 가능 / 이름/시작일/날짜 형식 검증 / 저장 후 정보 표시 갱신(명시적 이력·재조정 누락은 MM-10) / WBS 구조 행 선택이 Phase 필터로 이동 / Planning/CP 요약이 해당 메뉴로 이동 | 6461-6494 |
| UI-02A 프로젝트 등록 | 이름*; GitHub URL*; 목표일; 기술 제약 name/lv/cond; 팀장 지시; 구조 표; md 목록; 초기화 기록 | URL은 GitHub 저장소까지만 허용하고 tree/blob 주소 거부 / 이름과 성공한 저장소 확인 없이 등록 거부 / 기술 제약 추가/삭제와 필수·조건부 선호·금지 선택 가능 / 예시 값은 가상 등록 입력을 채움 / 접근 확인 결과에 main 커밋과 필수 경로 누락을 표시 / 등록하면 초기 분석으로 이동 | 6894-6905 |
| UI-02B 초기 분석 진행 | PL-000; 입력 버전/커밋; Runner 보고; 팀장 지시; 단계/오류/조치 | Mock 단계가 순서대로 진행하고 Runner 끊김·정리 대기에서 정지 / 단계 실패에 원인과 조치 및 재시도/등록 취소 제공 / 재시도는 실패 단계부터 진행 / 등록 취소가 초기화 확인으로 연결 | 4493-4535 |
| UI-02C 초기 기술 결정 확정 | 결정 ID/제목/선택/권한/상태/조건/근거/대안 | 각 Agent 제안을 승인 또는 반려 / 미결 제안이 있으면 기술 결정 확정 진행 거부 / 확정 후 WBS 초안 작성 진행 | 4844-4856 |
| UI-02D WBS 초안·최초 승인 | Phase/WP/Task 트리; 분류/작업량/선행; 분할 점검; 재분석 지시 | 재분석은 Codex 분석부터 다시 진행하고 확정 기술 결정을 유지 / 최초 승인 시 Task 11건과 생성 이력 및 기준 일정 v1 생성 / 승인 후 WBS 첫 Task 개요로 이동 | 4536-4564 |
| UI-02E 입력 변경·버전·차이 분석 | repo URL/branch/base; 입력 v/commit/md/changes/srcV; 감지 커밋·파일; 지시; 분석 단계/CP | 확인으로 감지 시각 갱신 / 분석 안 함은 skipped 기록을 남김 / 이 버전으로 분석은 커밋을 새 입력 버전으로 고정 / 차이 분석 완료 시 신규/수정 CP를 만들고 정책에 따라 반영 / 버전별 출처 Task 수 선택이 WBS로 이동 / 실패 단계 재시도와 CP 상세 이동 가능 | 4644-4693 |
| UI-03 WBS 목록 | 검색; 8개 select 필터; sort; Phase/WP/Task; 컬럼; 일정 | 검색과 유형/영역/상태/Agent/우선순위/Phase/차단/검증 필터가 함께 적용 / 필터 결과에 상위 Phase/WP 유지 / 초기화가 검색과 필터 제거 / 정렬은 WP 내부에 적용 / Task 선택으로 레일+상세 전환 | 6968-7088 |
| UI-03A WBS 컬럼 설정 | kind/agent/status/priority/preds/pct/plan/est/updated | WBS 번호와 제목은 항상 표시 / 선택한 컬럼만 표에 표시 / 기본 8개와 선택 최근 변경 컬럼을 원본 순서로 표시 | 7078-7085 |
| UI-03B Tree Table | WBS/제목; 분류/담당/상태·검증/우선순위/선행/진척/날짜범위/공수/수정시각 | 그룹 캐럿은 선택과 분리해 펼침/접힘 / 모두 펼치기/접기 적용 / Task 행 클릭과 제목 버튼 선택이 상세를 열음 / 상태 텍스트와 색상을 함께 표시 | 5104-5174 |
| UI-03C Gantt | 전체 기간; 기준 막대; 예측 막대; 범위선; 현재선; 목표선 | 전체 기간을 폭에 맞춤 / 기준 일정과 실제/예측 막대 구분 / 작업 불가일 빗금과 현재·목표선 표시 / Task 막대 선택이 해당 상세로 이동 | 6969-6980 |
| UI-03D Task 레일·상세 헤더 | WP 구분; Task ID/상태/제목; 현재 위치 | 상세 열면 260px 레일 표시 / 원래 목록 펼치기로 상세 닫힘 / 이전/다음이 필터·정렬된 레일 순서를 따름 / 링크로 연 Task가 필터 밖이면 목록 밖 표시 / Task 참조 이동 뒤 복귀 스택 동작 | 5075-5103 |
| UI-03E Task 요약·Gate 펼침 | Task/WBS/상위; 분류/Agent/검증/우선순위; 선행; 체크리스트; Gate; 일정/진척 | 9개 탭과 각 건수 표시 / Gate 펼치면 5개 조건별 판정·사유 표시 / 하나라도 조건 미충족 시 완료 버튼 비활성 / 선행 차단 Task 참조 링크 제공 | 5204-5327 |
| UI-03F 구조화 명세·기술 설계 공용 편집기 | DESIGN/COLSETS 스키마 필드; 텍스트/seg/check/select/code/table | 필수값·중복명·컬럼/인덱스/FK·API 오류·환경변수 규칙을 저장 전 검사 / 행 추가/삭제 가능 / 취소 시 원본 보존 / 저장 시 이력 전후 기록 / 편집 중 이동 시 버리기 확인 | 5432-5636 |
| UI-03-01 Task 개요 | 목적/배경/범위/제외/선행조건/완료조건; 낙관·예상·비관/토큰/고정시작일 | 개요 편집은 해당 영역만 전환 / 제목·목적·완료조건 필수 / 0<시간≤400 및 낙관≤예상≤비관, 토큰 정수 검증 / 담당=검증 경고 / 저장/취소 후 읽기 복귀 / 범위와 제외 범위는 명세와 같은 데이터 | 5362-5388 |
| UI-03-01A Task 실행 등급·하위 Agent | 개발·검증 model/effort/locked/basis/by; 지정 subagent와 실제 시도 | 개발/검증 등급을 따로 고정 가능 / 최저선 미달은 경고와 함께 표시 / 등급 저장 시 작업량 재추정·일정 재조정·이력 기록 / 고정 해제로 Planning 재판단 / 지정과 실제 사용·미사용을 구분 | 6195-6223 |
| UI-03-01B 분할 근거·자동 점검 | 근거/by; 규칙별 결과/detail/how; 예외 | 미착수 위반 Task는 Planning 분할 CP 생성 가능 / 진행 Task는 분할 대신 예외 사유 기록 / 분할은 후속 선행 관계 재연결 후 원래 Task 취소 | 4565-4588 |
| UI-03-02 Task 작업 명세 | 6그룹 13섹션; req/work/steps/inputs/outputs/files/constraints/errors/out/ac/verify/docs | 섹션별 읽기·편집·저장·취소 제공 / AC는 Given/When/Then/검증방법 표 / 산출물은 경로/유형/필수/검증조건/제출 표 / 메시지는 공식 명세를 자동 변경하지 않음 | 5204-5235 |
| UI-03-03 Task 의존성 | pred/succ/type FS·SS; 현재 상태/충족; 검색어/후보 | FS는 선행 완료, SS는 선행 시작 기준으로 차단 계산 / 후보 선택 즉시 추가 검증 / 자기참조/중복/순환은 저장 거부하고 순환 경로 표시 / 삭제 확인 후 관계와 이력 갱신 / 참조 클릭·복귀 동작 | 5328-5341 |
| UI-03-04 Task 기술 설계 | DB/API/FE/DevOps 섹션; ents/b; DB 관계 테이블 | 주·관련 영역에 맞는 섹션만 기본 제공 / 섹션 추가와 제거 확인 / DB 테이블/API Endpoint 추가·편집·삭제 / FK로 관계 테이블 계산 / 비밀 환경변수는 읽기에서 가림 / 전체 설계 링크가 해당 항목으로 이동 | 5453-5500 |
| UI-03-05 Task 체크리스트 | id/text/required/done/method/evidence/note | 체크 토글이 완료 수·진척과 Gate를 갱신하고 이력 기록 / 필수/선택을 골라 항목 추가 / 빈 내용 추가 비활성 / Evidence와 검증 방법 표시 | 5342-5353 |
| UI-03-06 Task 실행 이력 | Attempt; Agent/등급/상향/하위 Agent/CI/기간/요약/파일/실패 | 새 시도는 이전 결과를 덮어쓰지 않음 / 지정·실제·미사용 구분 / Task 검사 링크는 해당 CI 상세로 이동 / 작업 실행 화면에서 진행 버튼은 해당 Task로 이동 | 5204-5327 |
| UI-03-07 Task 검증·Evidence | 검증 ID/시도/Agent/시각/명령/예상/실제/Evidence/결함 | 검증 결과별 원래 실행 시도 연결 표시 / 명령·예상·실제·증거·결함 표시 / QA 결과 등록은 작업 실행에서 수행 | 5204-5327 |
| UI-03-08 Task 이력 | 시각/주체/유형/내용/전후 | Task별 변경이 최신순으로 표시 / 전후 값과 주체를 함께 표시 | 5204-5327 |
| UI-03-09 Task 메시지 | 유형/대상Agent/시도/본문; 방향/시각/전달/작업상태 | Task별 작성 초안 유지 / 빈 본문 전송 비활성 / 긴 메시지 펼치기/접기 / Runner 끊김은 실패와 재전송 표시 / 실행중 주입 미지원이면 다음 실행 대기 / Queued 전송 취소 / ack와 작업 완료를 구분 / 메시지에서 CP 작성 및 실행/검증 이동 | 5399-5431 |
| UI-04 설계 | 전체 버전/결정/대기/불일치 요약; 6탭 | 승인대기·읽기실패 배너와 탭 배지 표시 / 각 탭 상태 전환 / 읽기 실패는 마지막 성공 버전 유지 안내와 다시 읽기 제공 | 4857-4932 |
| UI-04-01 구성도·계약 파일 | 계층별 구성요소/tech/note/decision; 연결; 계약 path/kind/fmt/commit/st | 구성요소의 권한·결정 상태 표현 / 계약 파일별 형식·기준 커밋·상태 표시 / Mock 읽기 실패가 배너·알림·파일 상태를 변경 | 4857-4932 |
| UI-04-02 기술 결정 | id/area/title/choice/auth/lv/cond/reason/alts/by/at/chgTo | 권한 3단계별 묶음 / pending 승인/반려 시 버전 증가 / 변경 제안 전에는 기존 결정 유지 / 변경 반려 시 기존 결정 복구 / 팀장 지정 제약은 임의 변경 불가 | 4815-4830 |
| UI-04-03 인터페이스 목록·레일 | REST/WebSocket/SSE/Kafka; key/name/description/status/task | 방식과 검색이 목록에 적용 / 행 클릭은 레일+상세 / 펼치기가 목록으로 복귀 / Task 링크는 WBS 상세 | 4857-4932 |
| UI-04-03A 인터페이스 상세 | auth/request/response/validation/errors/tables; 메시지 schema/dir; topic key/parts/retention/delivery/dlq/compat/consumers | REST 요청·응답·검증·오류·테이블 표시 / 테이블 클릭이 데이터 상세로 이동 / WebSocket/SSE 메시지 방향·스키마와 Kafka 전달 규칙 표시 / 이전/다음·목록 밖 표시 | 4857-4932 |
| UI-04-04 데이터 목록·레일 | 저장소 선택; 종류/이름/설명/상태/Task | 저장소 선택과 검색이 해당 항목만 표시 / 행 선택이 레일+상세 / 펼치기로 목록 복귀 | 4857-4932 |
| UI-04-04A 데이터 상세 | 컬럼·제약·인덱스·API; 라벨/관계/props; ts/partition/retention/dedup/symbol/ingest; key/use/value/ttl/invalidation/persist | PostgreSQL 컬럼과 사용하는 API 표시 및 역이동 / Neo4j 라벨·관계·제약 표시 / QuestDB 시간축·파티션·보관·중복제거 표시 / Redis 키·만료·무효화·영속성 표시 | 4857-4932 |
| UI-04-05 소유권·흐름 | data/src/copy/sync/lag | 데이터별 원본·복제·동기화·지연 허용 표시 | 4857-4932 |
| UI-04-06 변경·불일치 | drift id/kind/item/task/where/t/st/res; versions | 불일치 원인·브랜치·대상 Task와 처리 결과 표시 / 계약에 반영/코드 수정 요청이 Mock 처리 상태를 변경 / 설계 버전별 주체·시각·호환 깨짐 표시 | 4831-4843 |
| UI-05 Planning | 세션 선택; 단계; 2개 탭 | 세션별 분석·검토·최종 Diff와 연결 CP 표시 / 세션 없음 안내 | 5949-5987 |
| UI-05-01 분석 비교·이견 조정 | 독립분석 agent/at/summary/items; review kind/topic/codex/claude/res/memo/ops | 독립 분석 2개를 나란히 비교 / 이견 조정 선택이 최종 Diff에 반영 / 미조정·순환·완료 Task 수정 문제 시 CP 생성 차단 / CP 생성 후 정책에 따라 자동 반영 또는 승인 대기 | 5704-5724 |
| UI-05-02 일정 재조정 이력 | RP/v/at/by/trigger/end/range/rate/moved before/after/delta | RP마다 계기·주체·새 기준·범위·가동률 표시 / 변경 Task 펼치면 전후·차이와 Task 이동 / Mock Planning 실행은 재조정 기록 추가 | 4284-4305 |
| UI-06 작업 실행 | 왼쪽 Task·시도; 중앙 다음 작업·기록; 오른쪽 메시지 | 3영역을 구분 / 현재 단계별 다음 액션 제공 / Runner 끊김·차단·사용량0·용량·관측미확인·준비실패·충돌묶음 사유 표시 / 새 시도에 실제 등급과 하위 Agent 설치 기록 | 6019-6092 |
| UI-06A 개발 결과 등록 | result/summary/files/fail/tok | 성공 시 요약 필수, 실패 시 사유 필수 / 토큰 숫자 입력(원본 검증 누락은 MM-11) / 파일 경로 일치 산출물 제출 처리 / 성공하면 QA 새 시도 자동 요청 / 실패는 이전 결과를 보존 | 5857-5901 |
| UI-06B QA·재검증 결과 등록 | result/cmd/expected/actual/evidence/defects/checks/tok | 명령·실제결과 필수, FAIL은 결함 필수 / Evidence를 검증과 선택 체크리스트에 연결 / PASS는 Gate, FAIL은 재작업, BLOCKED는 대표 상태를 유지하고 verif=blocked로 기록 / 이전 Verification 보존 | 5870-5920 |
| UI-06C 재작업 지시 | 지시 body; 대상 Task/Agent | 빈 지시는 제출 거부 / 수정 요청 메시지 기록 후 새 재작업 시도 생성 / 정책에 따라 등급 상향, 중단 후 재개는 동일 등급 | 5864-5928 |
| UI-06D 실행 Gate·선택 시도 | 5개 Gate 조건; Attempt 결과; Verification; CI 링크 | Gate 판정 사유와 완료 불가 사유 표시 / 완료 처리 시 확인 창 제공 / 시도별 요약·실패·파일·검증·CI 표시 / 실제 완료 판정은 불일치 MM-01 참조 | 5806-5856 |
| UI-06E 실행 연결 메시지 | 방향/유형/전달/본문/시각/시도 | 실행 기록과 메시지는 분리 / 메시지 작성은 Task 메시지 탭으로 이동 / Task 메시지에서 보기로 관련 상세 이동 | 6019-6079 |
| UI-07 검증 | 검증·증거·Task별 Gate | 결과 등록은 작업 실행에서만 수행 / 3탭별 건수와 데이터 표시 | 6334-6369 |
| UI-07-01 검증 결과 목록 | result/agent 필터; id/task/title/attempt/result/agent/at/defN/evN | 판정·Agent 필터 적용 / 기록 없음과 검색 결과 없음 구분 / 행 선택 시 레일+상세 | 6334-6369 |
| UI-07-01A 검증 결과 상세·Evidence 연결 | 명령/예상/실제/결함; evidence path/kind; checklist link | 검증 상세에 Task와 실행 링크 / Evidence 추가는 빈 경로 거부·중복 처리 / 항목 선택으로 Evidence 연결/해제 / 이전·다음과 펼치기 동작 | 6238-6252 |
| UI-07-02 Evidence 통합 목록 | path/kind/verification/task/checklist/result | Evidence 행은 소속 Verification으로 이동 / 검증에 없는 체크리스트 Evidence를 별도 경고 | 6334-6369 |
| UI-07-03 Completion Gate 현황 | Task/status; Checklist/outputs/Verification/defects/approval 판정 | 각 Task의 5조건과 합계 표시 / 필터로 미통과만 조회 / Task 선택은 상세 Gate로 연결 | 6334-6369 |
| UI-08 빌드·통합 | main commit/E2E; 실행/실패/대기/배포 요약; 5탭 | main 상태와 미해결 실패 수 표시 / 탭 배지와 전환 / Mock 실패가 관련 실행 상세와 알림을 만듦 | 4765-4801 |
| UI-08-01 CI 실행 기록 | CI id/stage/st/task/ref/pr/at/dur/trig | 단계 필터 적용 / 기록 선택 시 레일+상세 / Task 링크는 WBS | 4765-4801 |
| UI-08-01A CI 실행 상세 | 대상/Task/Attempt/계기/시간/GitHub/병합/URL; 단계 결과/소요; 실패 로그/파일명 | 실패 단계 뒤는 건너뜀 표시 / 실패만 다시 실행 가능 / 재실행은 새 CI 기록 생성 / 통합 성공이면 병합/메인 상태 갱신 / 이전·다음·목록 밖과 펼치기 동작 | 4726-4754 |
| UI-08-02 병합 대기열 | PR/task/title/st/at | 검증 PASS 후 통합 확인 직렬 대기 안내 / 실패 PR은 병합 보류로 표시 / Task 링크 이동 | 4736-4745 |
| UI-08-03 배포 확인 | URL/최근 CI/결과/시각 | 배포 확인 실행이 새 deploy 기록을 생성 / 최근 기록으로 이동 / Mock 포트 충돌 실패는 로그·알림·실패 상태 생성 | 4755-4763 |
| UI-08-04 파이프라인 정의 | file/ref; stage/when/steps/gate; 보호 규칙; night/retry/svc/deployUrl | 4단계와 실행 조건·통과 기준 표시 / 정의 파일·기준 커밋 표시 / 야간 시각·재시도·서비스·URL 설정 표시 | 3523-3530 |
| UI-08-05 불안정 테스트 | test/rate/last/st/task | 격리 해제와 다시 격리가 실제 Mock 상태를 변경 / 담당 Task로 이동 | 4764-4801 |
| UI-09 변경 제안 | CP 목록 id/status/title/source/ops수 | CP 목록 선택으로 사유·Diff·영향·승인 이력 표시 / 새 변경 제안으로 공용 모달 진입 / 비어 있을 때 유입 경로 안내 | 5988-6018 |
| UI-09A CP 상세·승인·반영 | reason/source/ops/diff/impact/comment/approvals/idMap | 승인 전에 WBS가 변경되지 않음 / 문제 있는 변경은 승인·반영 차단 / 수정 요청/반려 시 의견 필수 / 수정 요청 중 항목 제외와 재제출 / 승인 후 WBS 반영 시 동일 시뮬레이션 결과와 Task·의존성·이력·일정 갱신 / 완료 Task와 기존 검증 결과 보존 | 5725-5763 |
| UI-10 전체 이력 | 내용 검색; Task ID; 유형; 주체; at/actor/kind/task/text/before/after | 검색·Task·유형·주체 필터와 초기화 / 최신순·전후 표시 / Task 링크 이동 / 기간 필터는 원본 미구현 불일치 참조 | 6448-6460 |
| UI-11 보고서 | daily/weekly/custom; 기간/보기; 보고서 목록·스냅샷 | 종류 필터와 보고서 선택 / 정기 생성 Mock 점검은 누락분만 생성 / 생성 시점 스냅샷을 열 때 재계산하지 않음 / 생성 후 일정변경은 별도 안내 / 문서 부분 로딩만 표시 | 6370-6447 |
| UI-11A 기간 지정 보고서 | from/to/aud; 날짜 단축 선택 | 날짜 둘 다 필수, from≤to≤오늘, 포함 93일까지 허용 / 이번 주/지난 주/최근 30일 단축 기간 적용 / 선택한 보기로 custom 보고서 생성 후 선택 | 4989-4999 |
| UI-11B 팀장용 보고서 | 4 KPI; 확인필요; 완료/진행/QA실패 상세; 실행/재조정/중단/메시지/예정; 전체Task 부록 | 세부 Task 판단 정보와 증거를 문서에 포함 / 주간·기간 일별 추세 표시 / 보고서 Task 링크는 현재 WBS 상세 이동 / 전체 Task 부록은 인쇄 새 페이지 | 3797-3869 |
| UI-11C 보고용 보고서 | 4 KPI; 요약; 추세; 주요완료; 위험; 다음계획 | 팀장용과 동일 스냅샷 숫자 사용 / 내부 Task ID·모델·토큰 대신 요약 문장 표시 / 기간/생성시각·스냅샷 기준 표시 | 6370-6447 |
| UI-11D 보고서 출력·발송 | aud; 발송 at/to/st/why; 파일명 | 메일 미리보기와 수신자 선택 모달 열림 / 발송기록 펼침 / PDF 다운로드는 프로토타입에서 iframe 인쇄이며 실제 제품은 서버 PDF 필요 / PDF 실패 후 재시도 가능 | 4997-5012 |
| UI-12 설정 | runner/agent/plan/report/notify/system | 탭 하나만 표시 / 알림 링크는 해당 탭으로 이동 / 배지는 실제 이상·위반·미해결 발송 수와 일치 | 6647-6781 |
| UI-12-01 Runner·실행 환경 | GitHub/연결/준비/가동률/사용량/동시실행 | 각 세부 패널 진입과 상태 요약 표시 / 등록 전에도 설정 가능 | 6667-6679 |
| UI-12-01A GitHub 연결 | mode/account/repo/tokenSet/expires/scopes contents,pulls,statuses,metadata | gh/토큰 방식 전환 / 잘못된 토큰 거부 / 저장 후 토큰 입력 비움·등록여부만 표시 / 연결 확인 중 버튼 비활성 / 만료 Mock은 실패·배지·알림을 생성 | 4802-4812 |
| UI-12-01B Runner 연결·준비 상태 | heartbeat 60; readiness items k/l/v/st/fix/at | 연결 전환은 헤더와 동기화 / liveInject 설정이 다음실행 대기 동작에 반영 / 준비 이상에 조치 방법 표시 / Codex 실패 시 해당 Agent 새 실행 차단 / 재점검/조치완료 Mock 결과 갱신 | 4589-4599 |
| UI-12-01C 관측 가동률·사용량·중단 | rate/range/basis/days/gaps; usage remain/reset/at; sessions | 최근7일 가동률과 근거 표시 / Agent 한도 도달 시 해당 시도 중단·리셋 전 보류 / 리셋 후 실행 가능 / 재부팅/전원/오류 중단 기록과 재연결 / 중단 전 시도 보존 | 6080-6134 |
| UI-12-01D 동시 실행 상한·PC·Runner 조절 | host CPU/cores/mem/swap/disk/os/perSess; cap total/Claude/Codex/heavy/memGB; cur/res/log | 자동은 PC 권장 상한 적용 / 직접지정은 값 유지 및 권장 초과 경고 / 메모리압박·429로 한도 감소와 기록 / 안정 유지로 한도 증가 / PC 변경은 이전 시도 중단·상한/일정/PC이력 갱신 / 동일 충돌묶음 직렬화 | 6135-6184 |
| UI-12-01E 하위 Agent 관측·예산 | 세션/agent/seen/hold; budget dev/qa; CLI inst/ver/model/grade/options/at | 미검증은 max(예산,관측) 보유 계산 / 출력 단절은 수를 줄이지 않고 보유·새 실행 보류 / 스트림/프로세스그룹 확인으로 해제 / CLI 업데이트는 미검증 경고와 보수 계산 / 슬롯 반환은 실제 제품에서 프로세스 그룹 종료 근거 필요 | 4110-4135 |
| UI-12-02 Agent | 기본역할; Workflow; 실행정책; 정의 | 새 Task 기본 Agent만 변경 / 기존 Task 개요 유지 / Workflow 단계 안내 / 하위 Agent 관리 패널 표시 | 6710-6722 |
| UI-12-02A 실행 정책·모델 | models id/label/rank/allowed/fresh; efforts; onUsage/lowPct/onRework/escNotify/floors | 마지막 허용 모델 해제 거부 / 허용 변경은 미착수 Task 등급 재판단 / 사용량 대기/하향·기준10/20/30 선택 / 재작업 same/up1/top 선택 / 최저선·알림횟수 반영 / 고정 Task 링크 이동 | 6760-6781 |
| UI-12-02B 하위 Agent 정의 | 10정의 id/agent/role/tools/sandbox/v/hash/text/ref/allowed; 지정수/마지막사용/재작업률 | 지시문 펼침 / 정의 허용 해제 시 Task 지정 재판단 / 전체 끄기는 지정 기록 유지하고 기본 Agent 실행 / 외부 참고 링크 제공 / 실제 설치는 worktree 한정 Runner 작업 | 3472-3496 |
| UI-12-03 일정·Task | 분할/일정 정책/작업불가일/진행가중치 | 3개 영역과 분할 배지 표시 | 6701-6709 |
| UI-12-03A Task 분할 기준 | maxH/minH/maxFiles/testIn/dir/on 10규칙 | 상한·하한·파일 상한 변경 후 점검 갱신 / 10규칙별 사용 토글 / 테스트 포함·계층별 계약먼저 고정 표시 / 위반 Task 링크는 개요 분할 점검으로 이동 | 3509-3520 |
| UI-12-03B 일정 정책·작업 불가일 | autoReplan/cpAuto/threshold/assumeRate; blackout date/note | 정책 선택 저장 / 불가일 추가는 날짜 필수·형식·중복 검증 / 해제 후 목록/일정 재계산 / 초기가동률은 기록72시간 미만에 적용 | 6225-6234 |
| UI-12-03C 일정·진행률 기준 | 상태별 STAGE_PCT; 일정 기준 문구 | 상태별 0/20/35/40/50/65/80/90/100 가중치 표시 / 진행률과 완료율 차이 설명 / 고정 최대5개 문구는 폐기된 불일치 | 3395-3398 |
| UI-12-04 보고서·메일 | recips/smtp/log; 실패배지 | 수신자·SMTP·발송 기록 3영역 표시 / 실패/미설정 배너 | 6495-6532 |
| UI-12-04A 메일 수신자 | email/name/daily/weekly/view/pdf/active/at/last | 이메일 형식·대소문자무시 중복·구독1개이상 검증 / 일간/주간 모두 해제하면 중지 / 보기/PDF/받는중 변경 / 테스트·미리보기 / 삭제해도 발송 이력 유지 | 4933-4948 |
| UI-12-04B SMTP 보기·편집 | host/port/sec/from/user/pwSet; pw 쓰기전용 | 서버·포트1~65535·보내는주소 검사 / 비밀번호 입력은 저장 후 재노출 안 함 / 저장 후 연결상태 미확인 / 연결 확인/수정/취소 / Mock 인증실패·복구 | 4949-4966 |
| UI-12-04C 메일 발송 기록 | id/at/rep/rid/to/view/pdf/subject/st/err/why | 보고서/메일 미리보기 링크 / 행별·실패전체 다시 보내기는 새 발송 기록 / 수신자/보고서 삭제 시 재발송 거부 / 성공 이후 배지·알림 해제 / 자동15분 재시도는 실제 서버 필요 | 4967-4987 |
| UI-12-05 알림 | Telegram conf/rules/log; 접속URL | 연결·규칙·미리보기·접속주소·이력 구분 / 전송 실패가 Task 실행에 영향 없음 / 실제 API 미호출 Mock 배너 | 6605-6646 |
| UI-12-05A Telegram 연결 설정 | tokenSet/last4; token 쓰기전용; bot/target/chatId/chat/test | 가상 토큰→봇확인→수신대상→테스트→켜기→저장 흐름 / 전화번호/@사용자명 거부·음수 Chat ID 허용 / 토큰/Chat ID 변경 시 테스트 초기화, 이름만 변경 시 유지 / 테스트 성공 전 켜기 거부 / 마스킹값/빈 교체토큰 저장 거부 / 변경/교체 취소 | 6553-6592 |
| UI-12-05B Telegram 규칙·미리보기 | done/fail/admin/approve/buildOk/buildFail; pvMsg | 규칙6종 토글 후 저장/취소 / 꺼진 이벤트 미리보기에 경고 / 고정 일반텍스트·확정상태·미확정원인 표시 / 업무알림은 상태전이에서 발생하고 같은원인은 해소 전 중복생략 | 6598-6601 |
| UI-12-05C 공용 접속 주소 | appUrl | 잘못된 URL 저장 거부 / localhost/127.0.0.1 경고 / 빈 값은 메일·Telegram 링크 생략 / 저장 주소가 두 채널에 공통 적용 | 6602-6604 |
| UI-12-05D Telegram 전송 이력·상세 | at/proj/target/ev/to/st/tries/err/kind/dup/msg/nav | 행 선택 시 실제 보낼 메시지 표시 / WBS에서 확인은 Task/CP/CI/설정/프로젝트/설계로 이동 / 수락은 읽음·도착으로 표시하지 않음 / 전송 이력에 토큰 미노출 | 6605-6646 |
| UI-12-06 점검·Prototype | integrity 결과; IMPL; 미리보기/로딩토글 | 정합성 점검 결과 항목·상세 표시 / 구현/Mock/제한을 구분 / 미리보기는 제품 인수 대상 업무기능이 아닌 재현 도구 | 6647-6666 |
| UI-12-06A 화면·오류 상태 미리보기 | _pv/_pvE; fault/load/pdfFail/subFail | 9개 일반 상태와 21개 오류 진입을 모두 식별 / 저장오류4종은 다음1회 저장에 적용 / 불러오기 오류는 현재 메뉴 적용 / 미리보기 후 각 화면 빈/잠금/오류 상태 재현 | 4600-4643 |
| UI-13 미구현 메뉴 대체 화면 | pg.title/desc/phase/items | 제작 예정과 설명 및 WBS 이동 표시 / 현재 메뉴12개는 별도 구현되어 도달 불가 대체분기임을 구분 | 7053-7068 |
| SYS-01 페이지 로딩·전역 갱신 | SKELETON 메뉴별 배열; lastL; busy | 첫 메뉴는 배치별 skeleton / 재방문·필터는 이전화면과 상단바 / 재계산은 흐림·클릭차단 / 503은 마지막 성공시각·원인·재시도 / 응답시간은 Mock이고 제품은 실제 응답 기준 | 6814-6881 |
| SYS-02 저장 오류 막대 | title/code/msg/label/at; fault | 실패 시 데이터 미반영·입력유지 / 500/네트워크 재시도 / 400은 입력수정 안내와 재시도없음 / 닫기·주입해제 제공 | 5017-5051 |
| SYS-03 Toast 알림 | noticeText | role=status로 안내 표시 / 데이터 변경 결과를 Toast만으로 대체하지 않음 | 5017-5036 |
| MOD-01 동시 수정 충돌 | 먼저 저장된 변경/내변경/시각 | 내 변경 버리고 최신 불러오기 또는 내 변경 다시 적용 선택 / 프로토타입의 실제 버전비교 미구현은 MM 참조 | 6844-6865 |
| MOD-02 Telegram 수신 대상 찾기 | res/cands/pick; 후보 name/type/id/at | 후보 자동선택 안 함 / 선택 후 연결 입력만 채우고 저장하지 않음 / 빈결과 재시도 안내 / Webhook은 자동해제 안 하고 직접입력 경로 / 취소/닫기 | 6593-6597 |
| MOD-03 메일 미리보기 | from/to/subject/attachment/view; iframe srcDoc | 실제 보낼 요약 HTML과 제목·수신·첨부 표시 / 보기 전환 / 스크립트없는 iframe sandbox 표시 / 닫기 | 6533-6541 |
| MOD-04 메일로 보내기 | report/recipientIds/view | 해당 종류 활성 구독자 기본 선택 / 0명 제출 거부 / 일간은 팀장용 고정 / 주간/기간은 수신자기본/모두팀장/모두보고 / 추가 설정 링크와 발송후 기록 | 6542-6552 |
| MOD-05 프로젝트 초기화 | 삭제건수; Runner정리항목; keep; confirmName; export | 삭제영향과 제외항목 표시 / 정확한 프로젝트명 입력 전 초기화 거부 / 선택 JSON 내보내기 / 초기화 시 epoch+1·등록전 복귀 / 오프라인은 정리대기·재연결시 먼저정리 / 실제 저장소되돌림은 Runner 필요 | 4694-4725 |
| MOD-06 Task 생성 Wizard | Task 기본/목적/선행 선택 | 이전/다음과 단계별 필수 검증 / 제목·목적 입력 뒤 닫기는 취소확인 / 생성은 고유 Task ID·WBS 배치·초기 planning·이력·일정 생성 / 생성 후 작업명세 탭 열림 | 6782-6813 |
| MOD-06A Task 생성 1 기본정보 | title/wp/type/domain/rel/est/fixStart/priority/assignee/verifier | 제목·유형·주영역·시간 필수 / 시간0초과400이하 / 고정시작 YYYY-MM-DD / 관련영역 선택과 담당·검증 기본값 | 7013-7037 |
| MOD-06B Task 생성 2 목적·범위 | purpose/background/scope/out/doneCond | 목적·완료조건 없으면 다음 차단 / 범위·제외는 줄단위 배열로 등록 | 6787-6794 |
| MOD-06C Task 생성 3 선행·확인 | 선행Task; 생성예정ID/분류/Agent/설계섹션/일정 | 선행 다중선택은 FS / 미완료 선행 선택 시 생성후 차단 안내 / 자동 ID와 상위WP·설계영역·초기상태 확인 후 생성 | 6795-6813 |
| MOD-07 Change Proposal 작성 | title/reason/source; rows op/task/value; preview | 범위추가/완료조건/AC/우선순위/담당/선행추가·삭제 7유형 / 행추가·삭제 / 제목·사유·유효항목 필수 / 오류 있으면 제출차단 / 제출은 review이며 자동 WBS변경 아님 | 5764-5805 |
| MOD-08 공용 확인창 | cf.title/body/ok/okCls | 취소는 원동작 미실행 / 확인은 등록된 동작1회 수행 / 삭제·완료·편집버리기의 각 제목·영향설명 표시 | 5052-5054 |

## 원본 샘플 모델의 전체 필드 경로

추출 방법과 읽는 법:

- `Api.loadProject()` 및 Component 생성자 결과의 모든 중첩 객체·배열을 순회했다.
- 배열은 `[]`, Task 사전의 키는 `TASK-*`로 정규화했다.
- null/빈 배열에만 있는 미래 필드는 추론하지 않는다.
- 예시는 읽기 편의를 위해 각 필드 최대 3개다. 열거값 전체는 본문과 JSON `constants`가 기준이다.
- 런타임 날짜·예측값은 실행 시점에 따라 달라진다.

| 필드 경로 | 원본 JS 자료형 | 샘플 값(최대 3) |
|---|---|---|
|  | object | [] |
| project | object | [] |
| project.id | string | ["PRJ-001"] |
| project.name | string | ["Verum-SDN Agent WBS — Self Development"] |
| project.desc | string | ["Agent WBS 자체를 Agent WBS로 관리하는 Self Development 프로젝트. Codex · Claude 협업 Workflow와 Runner 연동을 단계적으로 구현한다."] |
| project.status | string | ["진행 중"] |
| project.start | string | ["2026-10-27"] |
| project.target | string | ["2026-12-18"] |
| project.lead | string | ["팀장"] |
| project.registered | boolean | [true] |
| project.phase | string | ["active"] |
| project.epoch | number | [1] |
| project.regAt | string | ["2026-10-27 09:40"] |
| project.regBy | string | ["팀장"] |
| project.instr | string | ["GitHub 저장소의 prototype/uiux/ 와 prototype/docs/ 설계 문서를 분석하고 Task 식별을 시작하자."] |
| project.repo | object | [] |
| project.repo.url | string | ["https://github.com/verum-sdn/agent-wbs"] |
| project.repo.owner | string | ["verum-sdn"] |
| project.repo.name | string | ["agent-wbs"] |
| project.repo.branch | string | ["main"] |
| project.repo.base | string | ["a1b2c3d"] |
| project.repo.clone | string | ["~/agentwbs/repos/agent-wbs"] |
| project.inputs | array | [] |
| project.inputs[] | object | [] |
| project.inputs[].v | number | [1] |
| project.inputs[].at | string | ["2026-10-27 09:40"] |
| project.inputs[].commit | string | ["a1b2c3d"] |
| project.inputs[].msg | string | ["prototype v1 · 설계 의도 문서 초안"] |
| project.inputs[].proto | string | ["HTML 3 · JS 4 · CSS 2 · 이미지 6"] |
| project.inputs[].md | array | [] |
| project.inputs[].md[] | string | ["prototype/docs/Agent-WBS-설계의도-및-구현가이드.md", "prototype/docs/화면-정의서.md", "prototype/docs/용어-정의.md"] |
| project.inputs[].changes | array | [] |
| project.inputs[].note | string | ["최초 등록"] |
| project.inputs[].result | string | ["초기 분석 PL-000 → 초기 WBS 11건 팀장 승인 (2026-10-27 10:20)"] |
| project.inPending | array | [] |
| project.inPending[] | object | [] |
| project.inPending[].sha | string | ["e7d41b0", "9c03f2e"] |
| project.inPending[].at | string | ["2026-11-05 21:12", "2026-11-05 21:40"] |
| project.inPending[].author | string | ["team-lead"] |
| project.inPending[].msg | string | ["설계 문서: 보고서 메일 발송 요구사항 추가", "prototype: 설정 화면 탭 구성 · 보고서 메일 탭"] |
| project.inPending[].files | array | [] |
| project.inPending[].files[] | object | [] |
| project.inPending[].files[].p | string | ["prototype/docs/Agent-WBS-설계의도-및-구현가이드.md", "prototype/uiux/settings.html", "prototype/uiux/js/settings.js"] |
| project.inPending[].files[].ch | string | ["수정", "추가"] |
| project.inPending[].files[].d | string | ["+42 −3", "+118 −64", "+86 −12"] |
| project.inSkipped | array | [] |
| project.boot | object | [] |
| project.boot.id | string | ["PL-000"] |
| project.boot.approvedAt | string | ["2026-10-27 10:20"] |
| project.boot.n | number | [11] |
| phases | array | [] |
| phases[] | object | [] |
| phases[].id | string | ["PH-1", "PH-2", "PH-3"] |
| phases[].title | string | ["기반 구성", "Core WBS", "Workflow"] |
| phases[].wps | array | [] |
| phases[].wps[] | object | [] |
| phases[].wps[].id | string | ["WP-01", "WP-02", "WP-03"] |
| phases[].wps[].title | string | ["개발 환경", "데이터 모델", "Task API"] |
| phases[].wps[].tasks | array | [] |
| phases[].wps[].tasks[] | string | ["TASK-0001", "TASK-0002", "TASK-0003"] |
| tasks | object | [] |
| tasks.TASK-* | object | [] |
| tasks.TASK-*.id | string | ["TASK-0001", "TASK-0002", "TASK-0003"] |
| tasks.TASK-*.title | string | ["Monorepo 구성", "PostgreSQL 연결", "Task 데이터 모델 설계"] |
| tasks.TASK-*.type | string | ["Configuration", "Analysis", "Design"] |
| tasks.TASK-*.domain | string | ["DevOps", "Architecture", "DB"] |
| tasks.TASK-*.rel | array | [] |
| tasks.TASK-*.rel[] | string | ["Common", "DB", "BE"] |
| tasks.TASK-*.status | string | ["done", "qa", "running"] |
| tasks.TASK-*.priority | number | [1, 0, 2] |
| tasks.TASK-*.assignee | string | ["Claude", "Codex"] |
| tasks.TASK-*.verifier | string | ["Codex", "Claude"] |
| tasks.TASK-*.verif | string | ["pass", "running", "none"] |
| tasks.TASK-*.approved | boolean | [true, false] |
| tasks.TASK-*.defects | number | [0, 2] |
| tasks.TASK-*.updated | string | ["2026-10-28 16:40", "2026-10-29 11:05", "2026-10-30 18:10"] |
| tasks.TASK-*.purpose | string | ["FE·BE·공통 패키지를 하나의 pnpm Workspace에서 빌드·실행할 수 있도록 저장소 구조를 확정한다.", "로컬 개발용 PostgreSQL 16을 Docker Compose로 구성하고 API 서버에서 연결 풀을 사용한다.", "Agent WBS의 논리 객체(Project, WBS Node, Task, Dependency, Checklist, Execution Attempt, Verification, Evidence, Change Proposal, Approval, History 등)와 관계를 정의한다."] |
| tasks.TASK-*.background | string | ["이후 모든 Task가 동일한 패키지 경계와 스크립트를 전제로 작성되므로 가장 먼저 고정해야 한다.", "Schema 설계(TASK-0004)와 CRUD API(TASK-0005)가 실제 DB에 대해 검증되어야 한다.", "Lifecycle · Approval · Execution · Verification · Completion Gate 상태를 하나의 Enum에 섞지 않기 위해 객체 경계를 먼저 정해야 한다."] |
| tasks.TASK-*.scope | array | [] |
| tasks.TASK-*.scope[] | string | ["&#96;apps/web&#96;(Vite + React), &#96;apps/api&#96;(Fastify), &#96;packages/shared&#96;, &#96;packages/db&#96; 구성", "루트 &#96;pnpm-workspace.yaml&#96;, 공통 &#96;tsconfig.base.json&#96;", "lint · format · typecheck 루트 스크립트"] |
| tasks.TASK-*.out | array | [] |
| tasks.TASK-*.out[] | string | ["CI 파이프라인 구성 (별도 Task)", "배포용 Docker 이미지", "운영 DB 구성"] |
| tasks.TASK-*.precond | string | ["없음 — 최초 Task", "Docker Desktop 설치", ""] |
| tasks.TASK-*.doneCond | string | ["루트에서 &#96;pnpm install && pnpm -r build&#96;가 오류 없이 완료된다.", "&#96;docker compose up -d&#96; 후 API의 &#96;/health/db&#96;가 200을 반환한다.", "&#96;docs/data-model.md&#96; v1.2가 교차 검토 후 승인된다."] |
| tasks.TASK-*.outputs | array | [] |
| tasks.TASK-*.outputs[] | object | [] |
| tasks.TASK-*.outputs[].kind | string | ["설정", "코드", "문서"] |
| tasks.TASK-*.outputs[].required | boolean | [true, false] |
| tasks.TASK-*.outputs[].verify | string | ["", "tsc 통과, 테이블 4종 export", "빈 DB에서 migrate 성공"] |
| tasks.TASK-*.outputs[].delivered | boolean | [true, false] |
| tasks.TASK-*.outputs[].name | string | ["pnpm-workspace.yaml", "tsconfig.base.json", "루트 package.json 스크립트"] |
| tasks.TASK-*.spec | object | [] |
| tasks.TASK-*.spec.req | array | [] |
| tasks.TASK-*.spec.req[] | string | ["pnpm 9.x로 고정하고 루트 &#96;package.json&#96;에 &#96;packageManager&#96; 필드를 명시한다.", "공통 타입은 &#96;packages/shared&#96;에서만 export하고 앱 간 직접 import를 금지한다.", "연결 풀 최대 10, idle 30초"] |
| tasks.TASK-*.spec.work | array | [] |
| tasks.TASK-*.spec.work[] | string | ["저장소 디렉터리 구조 생성", "공통 tsconfig · path alias 설정", "루트 스크립트 정의"] |
| tasks.TASK-*.spec.steps | array | [] |
| tasks.TASK-*.spec.steps[] | string | ["&#96;pnpm init&#96; 후 &#96;pnpm-workspace.yaml&#96; 작성", "&#96;apps/*&#96;, &#96;packages/*&#96; 스캐폴딩", "&#96;tsconfig.base.json&#96; 작성 후 각 패키지에서 extends"] |
| tasks.TASK-*.spec.inputs | array | [] |
| tasks.TASK-*.spec.inputs[] | string | ["기술 전제: React + TS + Vite + Mantine / Fastify + TS / PostgreSQL + Drizzle", "요구사항 문서 §16", "TASK-0003 산출물 &#96;docs/data-model.md&#96; (논리 모델 v1.2)"] |
| tasks.TASK-*.spec.outputs | array | [] |
| tasks.TASK-*.spec.outputs[] | string | ["빌드 가능한 빈 Monorepo", "로컬 DB 컨테이너", "DB Health Check"] |
| tasks.TASK-*.spec.files | array | [] |
| tasks.TASK-*.spec.files[] | string | ["pnpm-workspace.yaml", "tsconfig.base.json", "apps/web/package.json"] |
| tasks.TASK-*.spec.constraints | array | [] |
| tasks.TASK-*.spec.constraints[] | string | ["Node.js 20 LTS", "ESM only — &#96;\"type\": \"module\"&#96;", "PostgreSQL 16"] |
| tasks.TASK-*.spec.errors | array | [] |
| tasks.TASK-*.spec.errors[] | string | ["패키지 간 순환 import는 typecheck 단계에서 실패해야 한다", "&#96;ECONNREFUSED&#96; 시 3회 재시도 후 종료", "자기 참조 의존성은 CHECK 제약(&#96;pred_task_id <> succ_task_id&#96;)으로 DB에서 차단"] |
| tasks.TASK-*.spec.docs | array | [] |
| tasks.TASK-*.spec.docs[] | string | ["docs/architecture.md", "docs/data-model.md", "Drizzle ORM — PostgreSQL column types"] |
| tasks.TASK-*.spec.ac | array | [] |
| tasks.TASK-*.spec.ac[] | object | [] |
| tasks.TASK-*.spec.ac[].given | string | ["클린 체크아웃", "&#96;apps/web&#96;에서 &#96;apps/api&#96; 직접 import", "DB 컨테이너 실행"] |
| tasks.TASK-*.spec.ac[].when | string | ["&#96;pnpm install && pnpm -r build&#96;", "typecheck", "&#96;GET /health/db&#96;"] |
| tasks.TASK-*.spec.ac[].then | string | ["종료 코드 0", "오류로 차단된다", "200과 응답 시간(ms)을 반환한다"] |
| tasks.TASK-*.spec.ac[].method | string | ["", "SQL 실행 로그", "통합 테스트"] |
| tasks.TASK-*.spec.verify | array | [] |
| tasks.TASK-*.spec.verify[] | string | ["Codex가 클린 컨테이너에서 설치·빌드 로그를 Evidence로 첨부", "Codex가 컨테이너 중지 상태에서 기동 실패 로그를 함께 확인", "Claude 교차 검토 결과 첨부"] |
| tasks.TASK-*.checklist | array | [] |
| tasks.TASK-*.checklist[] | object | [] |
| tasks.TASK-*.checklist[].id | string | ["CL-0001-1", "CL-0001-2", "CL-0001-3"] |
| tasks.TASK-*.checklist[].text | string | ["pnpm install 성공", "전체 빌드 성공", "README에 개발 명령 정리"] |
| tasks.TASK-*.checklist[].required | boolean | [true, false] |
| tasks.TASK-*.checklist[].done | boolean | [true, false] |
| tasks.TASK-*.checklist[].method | string | ["명령 실행", "pnpm -r build", "문서 검토"] |
| tasks.TASK-*.checklist[].evidence | string | ["logs/install.txt", "logs/build.txt", ""] |
| tasks.TASK-*.checklist[].note | string | ["52.4s", "", "12ms"] |
| tasks.TASK-*.est | number | [1.5, 1, 3] |
| tasks.TASK-*.lo | number | [1, 0.5, 2] |
| tasks.TASK-*.hi | number | [2.5, 2, 5] |
| tasks.TASK-*.tok | number | [180, 120, 420] |
| tasks.TASK-*.conf | string | ["상", "중", "하"] |
| tasks.TASK-*.basis | string | ["Monorepo 템플릿 구성 — 유사 작업 이력 기준", "Compose + 연결 풀 — 표준 구성", "논리 객체 13종 정의 + 교차 검토 1회"] |
| tasks.TASK-*.estBy | string | ["Planning Agent (Codex · Claude 합의)"] |
| tasks.TASK-*.fixStart | string | ["", "2026-11-05"] |
| tasks.TASK-*.actStart | string | ["2026-10-28 14:02", "2026-10-29 09:10", "2026-10-29 13:00"] |
| tasks.TASK-*.actEnd | string | ["2026-10-28 16:40", "2026-10-29 11:05", "2026-10-30 18:10"] |
| tasks.TASK-*.design | array | [] |
| tasks.TASK-*.design[] | object | [] |
| tasks.TASK-*.design[].kind | string | ["DevOps", "DB", "API"] |
| tasks.TASK-*.design[].ents | array | [] |
| tasks.TASK-*.design[].b | object | [] |
| tasks.TASK-*.design[].b.targets | array | [] |
| tasks.TASK-*.design[].b.targets[] | string | ["로컬 개발 환경 — macOS / Windows(WSL2), Node.js 20 LTS", "로컬 개발 — Docker Compose"] |
| tasks.TASK-*.design[].b.files | array | [] |
| tasks.TASK-*.design[].b.files[] | object | [] |
| tasks.TASK-*.design[].b.files[].path | string | ["pnpm-workspace.yaml", "tsconfig.base.json", ".nvmrc"] |
| tasks.TASK-*.design[].b.files[].role | string | ["Workspace 패키지 범위 (apps/*, packages/*)", "공통 컴파일 옵션 · path alias", "Node.js 20 고정"] |
| tasks.TASK-*.design[].b.env | array | [] |
| tasks.TASK-*.design[].b.env[] | object | [] |
| tasks.TASK-*.design[].b.env[].name | string | ["NODE_ENV", "API_PORT", "WEB_PORT"] |
| tasks.TASK-*.design[].b.env[].example | string | ["development", "3000", "5173"] |
| tasks.TASK-*.design[].b.env[].secret | boolean | [false, true] |
| tasks.TASK-*.design[].b.env[].desc | string | ["실행 모드", "Fastify 포트", "Vite dev 포트"] |
| tasks.TASK-*.design[].b.commands | string | ["pnpm install\npnpm -r build\npnpm --filter web dev    # http://localhost:5173\npnpm --filter api dev    # http://localhost:3000", "docker compose up -d postgres\ncurl -s localhost:3000/health/db"] |
| tasks.TASK-*.design[].b.services | array | [] |
| tasks.TASK-*.design[].b.health | array | [] |
| tasks.TASK-*.design[].b.health[] | string | ["&#96;GET /health&#96; → 200 &#96;{ \"status\": \"ok\" }&#96;", "&#96;pnpm -r typecheck&#96; 통과", "&#96;GET /health/db&#96; → 200 &#96;{ \"db\": \"ok\", \"latencyMs\": 12 }&#96;"] |
| tasks.TASK-*.design[].b.deploy | array | [] |
| tasks.TASK-*.design[].b.deploy[] | string | ["배포 없음 — 로컬 개발 전용", "컨테이너 재시작 시 &#96;pgdata&#96; 볼륨 유지", "연결 실패 시 3회 재시도 후 API 기동 중단"] |
| tasks.TASK-*.run | object | [] |
| tasks.TASK-*.run.model | string | ["claude-sonnet-5-5", "claude-opus-5-5", "codex-large"] |
| tasks.TASK-*.run.effort | string | ["low", "high", "xhigh"] |
| tasks.TASK-*.run.basis | string | ["구성 작업 기본 낮음 · 정형 작업 → 허용 모델 중 차상위 Sonnet 5.5", "구성 작업 기본 낮음 · 최저선: DB · Migration 작업은 높음 이상 · 추론 깊이 필요 → 허용 모델 중 상위 Opus 5.5", "분석 작업 기본 높음 · 구조 · 계약 결정 — 후속 Task 영향 큼 (+1) · 추론 깊이 필요 → 허용 모델 중 상위 Codex Large"] |
| tasks.TASK-*.run.by | string | ["Planning Agent (Codex · Claude 합의)"] |
| tasks.TASK-*.run.at | string | ["2026-10-27 10:20"] |
| tasks.TASK-*.run.locked | boolean | [false] |
| tasks.TASK-*.vrun | object | [] |
| tasks.TASK-*.vrun.model | string | ["codex-mini", "codex-large", "claude-opus-5-5"] |
| tasks.TASK-*.vrun.effort | string | ["medium", "high", "xhigh"] |
| tasks.TASK-*.vrun.basis | string | ["검증 기본 보통 — 명령 실행 · 기대 결과 비교 · 정형 작업 → 허용 모델 중 차상위 Codex Mini", "검증 기본 보통 — 명령 실행 · 기대 결과 비교 · 최저선: DB · Migration 작업은 높음 이상 · 추론 깊이 필요 → 허용 모델 중 상위 Codex Large", "검증 기본 보통 — 명령 실행 · 기대 결과 비교 · 판정 기준 해석 필요 (+1) · 최저선: DB · Migration 작업은 높음 이상 · 최저선: 검증 Effort ≥ 개발 Effort (매우 높음) · 추론 깊이 필요 → 허용 모델 중 상위 Opus 5.5"] |
| tasks.TASK-*.vrun.by | string | ["Planning Agent (Codex · Claude 합의)"] |
| tasks.TASK-*.vrun.at | string | ["2026-10-27 10:20"] |
| tasks.TASK-*.vrun.locked | boolean | [false] |
| tasks.TASK-*.split | object | [] |
| tasks.TASK-*.split.basis | string | ["주 영역 DevOps · 구성 하나 · 예상 1.5h · AC 2개 · 테스트 포함", "주 영역 DevOps · 구성 하나 · 예상 1h · AC 1개 · 테스트 포함", "주 영역 Architecture · 분석 하나 · 예상 3h · AC 1개 · 테스트 포함"] |
| tasks.TASK-*.split.by | string | ["Planning Agent (Codex · Claude 합의)"] |
| tasks.TASK-*.split.exc | array | [] |
| tasks.TASK-*.subs | object | [] |
| tasks.TASK-*.subs.dev | array | [] |
| tasks.TASK-*.subs.qa | array | [] |
| tasks.TASK-*.subs.qa[] | object | [] |
| tasks.TASK-*.subs.qa[].id | string | ["qa-verifier", "security-reviewer", "code-reviewer"] |
| tasks.TASK-*.subs.qa[].why | string | ["검증 방법 · Evidence 형식", "입력 검증 · 인증 · 경로 점검 (우선순위 높음)", "명세 · 제외 범위 대조 검토"] |
| tasks.TASK-*.subs.by | string | ["Planning Agent (Codex · Claude 합의)"] |
| tasks.TASK-*.cg | string | ["Repo 설정 (package.json · pnpm)", "DB 연결 · 환경 변수", ""] |
| tasks.TASK-*.srcV | number | [1, 0] |
| tasks.TASK-*.design[].b.services[] | object | [] |
| tasks.TASK-*.design[].b.services[].name | string | ["postgres"] |
| tasks.TASK-*.design[].b.services[].image | string | ["postgres:16-alpine"] |
| tasks.TASK-*.design[].b.services[].port | string | ["5432"] |
| tasks.TASK-*.design[].b.services[].note | string | ["볼륨 pgdata"] |
| tasks.TASK-*.subs.dev[] | object | [] |
| tasks.TASK-*.subs.dev[].id | string | ["db-migrator", "be-implementer", "fe-implementer"] |
| tasks.TASK-*.subs.dev[].why | string | ["Schema · Migration 변경", "API · 서비스 구현", "FE 화면 구현"] |
| tasks.TASK-*.design[].ents[] | object | [] |
| tasks.TASK-*.design[].ents[].f | object | [] |
| tasks.TASK-*.design[].ents[].f.name | string | ["wbs_nodes", "tasks", "task_dependencies"] |
| tasks.TASK-*.design[].ents[].f.change | string | ["신규"] |
| tasks.TASK-*.design[].ents[].f.desc | string | ["계층 노드 — Phase · Work Package", "Task 본문 — Lifecycle 상태만 보관", "선행 관계 — 자기 참조는 CHECK, 순환은 Service에서 차단"] |
| tasks.TASK-*.design[].ents[].b | object | [] |
| tasks.TASK-*.design[].ents[].b.columns | array | [] |
| tasks.TASK-*.design[].ents[].b.columns[] | object | [] |
| tasks.TASK-*.design[].ents[].b.columns[].name | string | ["id", "project_id", "parent_id"] |
| tasks.TASK-*.design[].ents[].b.columns[].type | string | ["uuid", "wbs_node_kind_enum", "varchar(200)"] |
| tasks.TASK-*.design[].ents[].b.columns[].nullable | boolean | [false, true] |
| tasks.TASK-*.design[].ents[].b.columns[].pk | boolean | [true, false] |
| tasks.TASK-*.design[].ents[].b.columns[].fk | string | ["", "wbs_nodes.id", "tasks.id"] |
| tasks.TASK-*.design[].ents[].b.columns[].unique | boolean | [false, true] |
| tasks.TASK-*.design[].ents[].b.columns[].def | string | ["gen_random_uuid()", "", "0"] |
| tasks.TASK-*.design[].ents[].b.columns[].desc | string | ["내부 식별자", "프로젝트 (projects 테이블은 Phase D)", "상위 노드 — Phase는 null"] |
| tasks.TASK-*.design[].ents[].b.indexes | array | [] |
| tasks.TASK-*.design[].ents[].b.indexes[] | object | [] |
| tasks.TASK-*.design[].ents[].b.indexes[].name | string | ["wbs_nodes_parent_idx", "tasks_task_key_uq", "tasks_wbs_node_idx"] |
| tasks.TASK-*.design[].ents[].b.indexes[].cols | string | ["parent_id, sort_order", "task_key", "wbs_node_id"] |
| tasks.TASK-*.design[].ents[].b.indexes[].kind | string | ["BTREE", "UNIQUE"] |
| tasks.TASK-*.design[].b.migration | array | [] |
| tasks.TASK-*.design[].b.migration[] | string | ["&#96;drizzle-kit generate&#96;로 &#96;0001_core_wbs.sql&#96; 생성 — 생성된 SQL 수동 수정 금지", "Enum 6종(work_type, domain, task_lifecycle, dep_type, agent, wbs_node_kind)을 테이블보다 먼저 생성", "롤백: &#96;0001_core_wbs.down.sql&#96;로 역순 DROP"] |
| tasks.TASK-*.design[].b.seed | array | [] |
| tasks.TASK-*.design[].b.seed[] | string | ["본 프로젝트 Phase 3 · Work Package 6 · Task 12 · 의존성 15건", "&#96;task_key&#96; 기준 upsert — 재실행해도 중복 없음"] |
| tasks.TASK-*.design[].b.integrity | array | [] |
| tasks.TASK-*.design[].b.integrity[] | string | ["&#96;CHECK (pred_task_id <> succ_task_id)&#96; — 자기 참조 차단", "FK는 &#96;ON DELETE RESTRICT&#96; — 참조 중인 Task 물리 삭제 불가", "순환 의존성은 Service 계층 검증 (TASK-0006)"] |
| tasks.TASK-*.design[].ents[].f.method | string | ["GET", "POST", "PATCH"] |
| tasks.TASK-*.design[].ents[].f.path | string | ["/api/projects/:projectId/tasks", "/api/tasks/:taskKey", "/api/tasks/:taskKey/dependencies"] |
| tasks.TASK-*.design[].ents[].f.auth | string | ["팀장 세션", "Runner 토큰"] |
| tasks.TASK-*.design[].ents[].b.request | string | ["Query\n  status?: TaskLifecycle\n  q?: string                 // taskKey 또는 제목\n  includeDeleted?: boolean   // 기본 false", "", "{\n  \"title\": string,            // 1..200\n  \"wbsNodeId\": uuid,          // 상위 Work Package\n  \"workType\": WorkType,\n  \"primaryDomain\": Domain,\n  \"relatedDomains\"?: Domain[],\n  \"priority\"?: 0 &#124; 1 &#124; 2 &#124; 3,\n  \"assigneeAgent\"?: \"Claude\" &#124; \"Codex\",\n  \"verifierAgent\"?: \"Claude\" &#124; \"Codex\"\n}"] |
| tasks.TASK-*.design[].ents[].b.response | string | ["200 {\n  \"nodes\": WbsNode[],\n  \"tasks\": TaskSummary[]     // wbsPath는 서버 계산\n}", "200 TaskDetail", "201 {\n  \"id\": \"6f1c…\",\n  \"taskKey\": \"TASK-0013\",\n  \"wbsPath\": \"2.1.3\",\n  \"lifecycleStatus\": \"planning\"\n}"] |
| tasks.TASK-*.design[].ents[].b.validation | array | [] |
| tasks.TASK-*.design[].ents[].b.validation[] | string | ["&#96;includeDeleted&#96;는 true &#124; false 문자열만 허용", "&#96;title&#96; 1~200자", "&#96;workType&#96; · &#96;primaryDomain&#96;은 Enum 값만"] |
| tasks.TASK-*.design[].ents[].b.errors | array | [] |
| tasks.TASK-*.design[].ents[].b.errors[] | object | [] |
| tasks.TASK-*.design[].ents[].b.errors[].code | string | ["PROJECT_NOT_FOUND", "TASK_NOT_FOUND", "VALIDATION_FAILED"] |
| tasks.TASK-*.design[].ents[].b.errors[].http | string | ["404", "400", "409"] |
| tasks.TASK-*.design[].ents[].b.errors[].cond | string | ["projectId 없음", "taskKey 없음 또는 삭제됨", "필드 검증 실패 — errors[] 포함"] |
| tasks.TASK-*.design[].ents[].b.tables | array | [] |
| tasks.TASK-*.design[].ents[].b.tables[] | string | ["wbs_nodes", "tasks", "checklist_items"] |
| tasks.TASK-*.design[].b.resp | array | [] |
| tasks.TASK-*.design[].b.resp[] | string | ["Route: 입력 검증, DTO 변환, 상태 코드 결정", "Service: 업무 규칙 (삭제 가능 여부, 이력 생성)", "Repository: Drizzle 쿼리만 — 업무 규칙 금지"] |
| tasks.TASK-*.split.exc[] | object | [] |
| tasks.TASK-*.split.exc[].rule | string | ["size"] |
| tasks.TASK-*.split.exc[].why | string | ["이미 실행 중 — 남은 범위(오류 응답 정리)가 작아 분할하지 않음"] |
| tasks.TASK-*.split.exc[].by | string | ["Codex · Claude 합의"] |
| tasks.TASK-*.split.exc[].at | string | ["2026-11-03 20:10"] |
| tasks.TASK-*.design[].b.screens | array | [] |
| tasks.TASK-*.design[].b.screens[] | object | [] |
| tasks.TASK-*.design[].b.screens[].name | string | ["WBS"] |
| tasks.TASK-*.design[].b.screens[].route | string | ["/projects/:projectId/wbs"] |
| tasks.TASK-*.design[].b.screens[].purpose | string | ["계층형 Task 목록 · 검색 · 필터 · 상세 패널"] |
| tasks.TASK-*.design[].b.components | array | [] |
| tasks.TASK-*.design[].b.components[] | object | [] |
| tasks.TASK-*.design[].b.components[].name | string | ["WbsTreeTable", "WbsFilterBar", "StatusBadge"] |
| tasks.TASK-*.design[].b.components[].path | string | ["features/wbs/WbsTreeTable.tsx", "features/wbs/WbsFilterBar.tsx", "shared/ui/StatusBadge.tsx"] |
| tasks.TASK-*.design[].b.components[].role | string | ["행 렌더 · 가상 스크롤", "검색 · 필터 9종 · 초기화", "상태 색상 + 텍스트"] |
| tasks.TASK-*.design[].b.interactions | array | [] |
| tasks.TASK-*.design[].b.interactions[] | string | ["행 클릭 → Task 상세 패널", "캐럿 클릭 → 하위 펼치기/접기 (행 선택과 분리)", "필터 변경 → URL query에 반영"] |
| tasks.TASK-*.design[].b.inputs | array | [] |
| tasks.TASK-*.design[].b.inputs[] | object | [] |
| tasks.TASK-*.design[].b.inputs[].field | string | ["검색어", "필터 9종"] |
| tasks.TASK-*.design[].b.inputs[].rule | string | ["Task ID 또는 제목 부분 일치, 대소문자 무시", "URL query와 동기화, 초기화 시 모두 제거"] |
| tasks.TASK-*.design[].b.inputs[].req | boolean | [false] |
| tasks.TASK-*.design[].b.apis | array | [] |
| tasks.TASK-*.design[].b.apis[] | string | ["&#96;GET /api/projects/:projectId/tasks&#96; (TASK-0005)", "필터는 클라이언트에서 처리 — 1,000행 기준"] |
| tasks.TASK-*.design[].b.states | array | [] |
| tasks.TASK-*.design[].b.states[] | object | [] |
| tasks.TASK-*.design[].b.states[].state | string | ["Loading", "Empty", "Error"] |
| tasks.TASK-*.design[].b.states[].display | string | ["Skeleton 10행", "「조건에 맞는 Task가 없습니다」 + 필터 초기화", "오류 메시지 + 재시도 버튼"] |
| tasks.TASK-*.design[].b.navigation | array | [] |
| tasks.TASK-*.design[].b.navigation[] | string | ["행 클릭 → 우측 상세 패널, 전체 보기 시 &#96;/tasks/:taskKey&#96;", "선행/후속 Task로 이동 후 「돌아가기」로 복귀"] |
| deps | array | [] |
| deps[] | object | [] |
| deps[].id | string | ["DEP-001", "DEP-002", "DEP-003"] |
| deps[].pred | string | ["TASK-0001", "TASK-0002", "TASK-0003"] |
| deps[].succ | string | ["TASK-0002", "TASK-0003", "TASK-0004"] |
| deps[].type | string | ["FS", "SS"] |
| attempts | array | [] |
| attempts[] | object | [] |
| attempts[].id | string | ["ATT-0001-1", "ATT-0001-2", "ATT-0004-1"] |
| attempts[].task | string | ["TASK-0001", "TASK-0004", "TASK-0005"] |
| attempts[].kind | string | ["개발", "QA"] |
| attempts[].agent | string | ["Claude", "Codex"] |
| attempts[].status | string | ["완료", "실행 중"] |
| attempts[].start | string | ["2026-10-28 14:02", "2026-10-28 15:30", "2026-11-03 15:10"] |
| attempts[].end | string | ["15:10", "16:20", "17:48"] |
| attempts[].summary | string | ["Workspace 구조와 공통 tsconfig 구성, 루트 스크립트 추가.", "클린 컨테이너 설치·빌드 검증 — PASS (V-0001-1).", "Schema 4종과 Migration 생성. Seed 스크립트는 미작성."] |
| attempts[].files | array | [] |
| attempts[].files[] | string | ["pnpm-workspace.yaml", "tsconfig.base.json", "package.json"] |
| attempts[].fail | string | [""] |
| attempts[].tok | number | [210, 60, 380] |
| attempts[].model | string | ["claude-sonnet-5-5", "codex-mini", "claude-opus-5-5"] |
| attempts[].effort | string | ["low", "medium", "high"] |
| attempts[].esc | string | [""] |
| attempts[].subs | array | [] |
| attempts[].subInst | string | ["ok"] |
| attempts[].sub | number | [0, 1, 2] |
| attempts[].obsSt | string | ["ok"] |
| attempts[].subs[] | object | [] |
| attempts[].subs[].id | string | ["qa-verifier", "security-reviewer", "db-migrator"] |
| attempts[].subs[].v | number | [4, 1, 2] |
| attempts[].used | object | [] |
| attempts[].used.list | array | [] |
| attempts[].used.list[] | object | [] |
| attempts[].used.list[].id | string | ["qa-verifier", "security-reviewer", "db-migrator"] |
| attempts[].used.list[].v | number | [4, 1, 2] |
| attempts[].used.list[].n | number | [1, 2] |
| attempts[].used.conf | string | ["일부 관측", "세션 기록 확인"] |
| attempts[].used.at | string | ["16:20", "17:48", "11:40"] |
| verifs | array | [] |
| verifs[] | object | [] |
| verifs[].id | string | ["V-0001-1", "V-0007-1"] |
| verifs[].task | string | ["TASK-0001", "TASK-0007"] |
| verifs[].attempt | string | ["ATT-0001-2", "ATT-0007-2"] |
| verifs[].agent | string | ["Codex"] |
| verifs[].result | string | ["PASS", "FAIL"] |
| verifs[].at | string | ["2026-10-28 16:20", "2026-11-01 13:35"] |
| verifs[].cmd | string | ["pnpm install && pnpm -r build", "pnpm --filter web test -- wbs-tree"] |
| verifs[].expected | string | ["종료 코드 0", "14/14 통과, 1,000행 펼치기 100ms 이내"] |
| verifs[].actual | string | ["종료 코드 0 (52.4s)", "12/14 통과 — 필터 시 상위 Phase 행 누락, 1,000행 펼치기 412ms"] |
| verifs[].evidence | array | [] |
| verifs[].evidence[] | string | ["evidence/TASK-0001/install.log", "evidence/TASK-0001/build.log", "evidence/TASK-0007/qa-1/vitest.txt"] |
| verifs[].defects | array | [] |
| verifs[].defects[] | string | ["DEF-0007-1 필터 결과에서 상위 노드 누락 (차단 결함)", "DEF-0007-2 대량 펼치기 성능 기준 미달 (차단 결함)"] |
| msgs | array | [] |
| msgs[] | object | [] |
| msgs[].id | string | ["MSG-001", "MSG-002", "MSG-003"] |
| msgs[].task | string | ["TASK-0007", "TASK-0005"] |
| msgs[].dir | string | ["out", "in"] |
| msgs[].from | string | ["팀장", "Claude"] |
| msgs[].to | string | ["Claude", "팀장", "Codex"] |
| msgs[].type | string | ["수정 요청", "응답", "질문"] |
| msgs[].at | string | ["2026-11-01 14:02", "2026-11-01 14:09", "2026-11-03 19:42"] |
| msgs[].attempt | string | ["ATT-0007-2", ""] |
| msgs[].delivery | string | ["Acknowledged", "", "Failed"] |
| msgs[].work | string | ["", "재작업 대기 — 다음 실행(ATT-0007-3)"] |
| msgs[].failReason | string | ["", "Runner 연결 불가 — 19:40 이후 heartbeat 없음 (Mock)"] |
| msgs[].pendingNext | boolean | [false] |
| msgs[].unread | boolean | [false, true] |
| msgs[].body | string | ["QA-1 실패 2건을 재작업해 주세요.\n1. 필터 적용 시 매칭 Task의 상위 Phase / Work Package가 항상 표시되어야 합니다.\n2. 1,000행 펼치기 100ms 기준 — 가상 스크롤 적용을 검토해 주세요.\n&#96;&#96;&#96;ts\n// 기대 동작\nconst visibleRows = withAncestors(applyFilters(tasks, filters));\n&#96;&#96;&#96;\n관련 파일: &#96;apps/web/src/features/wbs/useWbsTree.ts&#96;", "수정 요청을 수신했습니다. 재작업 계획입니다.\n- &#96;withAncestors()&#96; 유틸을 추가하고 필터 파이프라인 마지막 단계에 적용\n- &#96;@tanstack/react-virtual&#96;로 행을 가상화하고 펼치기 시 재계산 범위를 축소\n다음 실행에서 반영하고 Codex 재검증을 요청하겠습니다.", "Task CRUD API QA 시 soft delete된 Task가 목록 조회에서 제외되는지도 확인 항목에 넣을 수 있을까요?"] |
| plannings | array | [] |
| plannings[] | object | [] |
| plannings[].id | string | ["PLN-001", "PLN-000"] |
| plannings[].title | string | ["Workflow Phase 상세화 — Runner 메시지 · 응답 연동", "초기 WBS 수립 — Runner API 계약 분리"] |
| plannings[].scope | string | ["WP-05 Planning · Gate, WP-06 Runner 연동", "전체"] |
| plannings[].at | string | ["2026-11-03 10:20", "2026-11-02 09:00"] |
| plannings[].cp | string | ["", "CP-001"] |
| plannings[].analyses | array | [] |
| plannings[].analyses[] | object | [] |
| plannings[].analyses[].agent | string | ["Codex", "Claude"] |
| plannings[].analyses[].at | string | ["2026-11-03 11:05", "2026-11-03 11:40", "2026-11-02 10:10"] |
| plannings[].analyses[].summary | string | ["Runner 메시지 응답 처리가 WBS에 빠져 있습니다. Message 상태 머신은 별도 설계 Task로 분리하는 것이 검증에 유리합니다.", "응답 수신 Task 추가에 동의합니다. Gate는 Checklist 데이터 모델(TASK-0004)만 있으면 BE 구현이 가능하므로 선행을 조정하는 편이 일정에 유리합니다.", "Runner는 별도 개발이므로 WBS ↔ Runner 계약을 독립 Task로 먼저 고정해야 합니다."] |
| plannings[].analyses[].items | array | [] |
| plannings[].analyses[].items[] | string | ["WP-06에 「Runner 응답 수신 처리」 BE Task 추가 필요", "Message 상태 머신(Draft~Cancelled)을 별도 설계 Task로 분리", "TASK-0011 Completion Gate의 선행 TASK-0009 유지 — Checklist 데이터 확정 후 구현"] |
| plannings[].review | array | [] |
| plannings[].review[] | object | [] |
| plannings[].review[].id | string | ["R1", "R2", "R3"] |
| plannings[].review[].topic | string | ["Runner 응답 수신 처리 Task 추가", "TASK-0012 완료 조건 보강", "Message 상태 머신 설계 위치"] |
| plannings[].review[].kind | string | ["agree", "diff"] |
| plannings[].review[].codex | string | ["WP-06에 BE Task 추가, 선행 TASK-0012", "ack와 작업 완료 보고를 분리해 명시", "별도 설계 Task 「Message 상태 머신 설계」(설계 / Architecture)를 WP-06에 추가"] |
| plannings[].review[].claude | string | ["동일 의견", "TASK-0012 작업 범위에 포함 — 별도 Task 불필요", "선행 TASK-0009 제거, TASK-0005 추가 — BE Gate는 Checklist UI 없이 구현 가능"] |
| plannings[].review[].choice | string | ["agree", ""] |
| plannings[].review[].memo | string | [""] |
| plannings[].review[].ops | array | [] |
| plannings[].review[].ops[] | object | [] |
| plannings[].review[].ops[].op | string | ["add", "modify"] |
| plannings[].review[].ops[].ref | string | ["NEW-1"] |
| plannings[].review[].ops[].t | object | [] |
| plannings[].review[].ops[].t.title | string | ["Runner 응답 수신 처리"] |
| plannings[].review[].ops[].t.type | string | ["Implementation"] |
| plannings[].review[].ops[].t.domain | string | ["BE"] |
| plannings[].review[].ops[].t.rel | array | [] |
| plannings[].review[].ops[].t.rel[] | string | ["API"] |
| plannings[].review[].ops[].t.wp | string | ["WP-06"] |
| plannings[].review[].ops[].t.priority | number | [1] |
| plannings[].review[].ops[].t.assignee | string | ["Claude"] |
| plannings[].review[].ops[].t.verifier | string | ["Codex"] |
| plannings[].review[].ops[].t.purpose | string | ["Runner가 반환한 Agent 응답을 Task · Execution Attempt에 연결해 저장하고 미확인 응답을 표시한다."] |
| plannings[].review[].ops[].t.doneCond | string | ["응답이 Task 메시지 탭과 작업 실행 화면에 표시된다."] |
| plannings[].review[].ops[].preds | array | [] |
| plannings[].review[].ops[].preds[] | object | [] |
| plannings[].review[].ops[].preds[].pred | string | ["TASK-0012"] |
| plannings[].review[].ops[].preds[].type | string | ["FS"] |
| plannings[].review[].ops[].task | string | ["TASK-0012"] |
| plannings[].review[].ops[].field | string | ["doneCond"] |
| plannings[].review[].ops[].after | string | ["ack(수신 확인)와 작업 완료 보고가 별도 이벤트로 정의되고, Codex · Claude 교차 검토 후 팀장 승인"] |
| plannings[].review[].codexOps | array | [] |
| plannings[].review[].codexOps[] | object | [] |
| plannings[].review[].codexOps[].op | string | ["add"] |
| plannings[].review[].codexOps[].ref | string | ["NEW-2"] |
| plannings[].review[].codexOps[].t | object | [] |
| plannings[].review[].codexOps[].t.title | string | ["Message 상태 머신 설계"] |
| plannings[].review[].codexOps[].t.type | string | ["Design"] |
| plannings[].review[].codexOps[].t.domain | string | ["Architecture"] |
| plannings[].review[].codexOps[].t.rel | array | [] |
| plannings[].review[].codexOps[].t.rel[] | string | ["API"] |
| plannings[].review[].codexOps[].t.wp | string | ["WP-06"] |
| plannings[].review[].codexOps[].t.priority | number | [1] |
| plannings[].review[].codexOps[].t.assignee | string | ["Codex"] |
| plannings[].review[].codexOps[].t.verifier | string | ["Claude"] |
| plannings[].review[].codexOps[].t.purpose | string | ["Draft · Queued · Sent · Acknowledged · Failed · Cancelled 전이와 재전송 규칙을 정의한다."] |
| plannings[].review[].codexOps[].t.doneCond | string | ["상태 전이표 교차 검토 후 승인"] |
| plannings[].review[].codexOps[].preds | array | [] |
| plannings[].review[].codexOps[].preds[] | object | [] |
| plannings[].review[].codexOps[].preds[].pred | string | ["TASK-0003"] |
| plannings[].review[].codexOps[].preds[].type | string | ["FS"] |
| plannings[].review[].claudeOps | array | [] |
| plannings[].review[].claudeOps[] | object | [] |
| plannings[].review[].claudeOps[].op | string | ["modify", "dep-remove", "dep-add"] |
| plannings[].review[].claudeOps[].task | string | ["TASK-0012", "TASK-0010"] |
| plannings[].review[].claudeOps[].field | string | ["scopeAdd", "priority"] |
| plannings[].review[].claudeOps[].after | string, number | ["Message 전달 상태 머신(Draft~Cancelled)과 재전송 규칙", 0] |
| plannings[].review[].claudeOps[].pred | string | ["TASK-0009", "TASK-0005"] |
| plannings[].review[].claudeOps[].succ | string | ["TASK-0011"] |
| plannings[].review[].claudeOps[].type | string | ["FS"] |
| proposals | array | [] |
| proposals[] | object | [] |
| proposals[].id | string | ["CP-001", "CP-002"] |
| proposals[].title | string | ["Runner API 계약 Task 추가", "Dependency 검증을 Task CRUD API와 병행 착수"] |
| proposals[].reason | string | ["Runner를 별도 개발하므로 WBS ↔ Runner 계약을 독립 Task로 먼저 고정한다.", "Service 계층의 순환 검사 로직은 CRUD Route와 독립적이므로 선행 관계를 시작→시작(SS)으로 바꿔 병행한다."] |
| proposals[].source | object | [] |
| proposals[].source.kind | string | ["planning", "manual"] |
| proposals[].source.id | string | ["PLN-000", ""] |
| proposals[].status | string | ["applied", "review"] |
| proposals[].author | string | ["Planning (Codex · Claude)", "팀장"] |
| proposals[].at | string | ["2026-11-02 15:00", "2026-11-03 19:30"] |
| proposals[].idMap | object | [] |
| proposals[].idMap.NEW-1 | string | ["TASK-0012"] |
| proposals[].ops | array | [] |
| proposals[].ops[] | object | [] |
| proposals[].ops[].op | string | ["add", "dep-remove", "dep-add"] |
| proposals[].ops[].ref | string | ["NEW-1"] |
| proposals[].ops[].t | object | [] |
| proposals[].ops[].t.title | string | ["Runner API 계약"] |
| proposals[].ops[].t.type | string | ["Design"] |
| proposals[].ops[].t.domain | string | ["API"] |
| proposals[].ops[].t.rel | array | [] |
| proposals[].ops[].t.rel[] | string | ["Architecture"] |
| proposals[].ops[].t.wp | string | ["WP-06"] |
| proposals[].ops[].t.priority | number | [0] |
| proposals[].ops[].t.assignee | string | ["Codex"] |
| proposals[].ops[].t.verifier | string | ["Claude"] |
| proposals[].ops[].t.purpose | string | [""] |
| proposals[].ops[].t.doneCond | string | [""] |
| proposals[].ops[].preds | array | [] |
| proposals[].ops[].preds[] | object | [] |
| proposals[].ops[].preds[].pred | string | ["TASK-0003"] |
| proposals[].ops[].preds[].type | string | ["FS"] |
| proposals[].approvals | array | [] |
| proposals[].approvals[] | object | [] |
| proposals[].approvals[].at | string | ["2026-11-02 15:00", "2026-11-02 17:10", "2026-11-02 17:12"] |
| proposals[].approvals[].actor | string | ["Planning (Codex · Claude)", "팀장"] |
| proposals[].approvals[].action | string | ["제출", "승인", "WBS 반영"] |
| proposals[].approvals[].comment | string | ["", "계약 우선 고정", "NEW-1 → TASK-0012"] |
| proposals[].ops[].pred | string | ["TASK-0005"] |
| proposals[].ops[].succ | string | ["TASK-0006"] |
| proposals[].ops[].type | string | ["SS"] |
| hist | array | [] |
| hist[] | object | [] |
| hist[].at | string | ["2026-10-27 10:00", "2026-10-28 16:40", "2026-10-30 09:12"] |
| hist[].actor | string | ["팀장", "Runner", "Codex"] |
| hist[].task | string | ["TASK-0012", "TASK-0011", "TASK-0010"] |
| hist[].kind | string | ["생성", "완료", "실행"] |
| hist[].text | string | ["Task 생성 (초기 WBS)", "Completion Gate 5/5 통과 — 완료 처리", "Task 생성"] |
| hist[].before | string | ["", "QA 진행", "실행 대기"] |
| hist[].after | string | ["", "완료", "실행 중"] |
| hist[].id | string | ["H-0001", "H-0002", "H-0003"] |
| seq | object | [] |
| seq.task | number | [12] |
| seq.dep | number | [15] |
| seq.h | number | [24] |
| seq.msg | number | [3] |
| seq.cp | number | [2] |
| settings | object | [] |
| settings.devAgent | string | ["Claude"] |
| settings.qaAgent | string | ["Codex"] |
| settings.liveInject | boolean | [false] |
| settings.heartbeat | number | [60] |
| runner | object | [] |
| runner.sessions | array | [] |
| runner.sessions[] | object | [] |
| runner.sessions[].from | string | ["2026-10-27 09:30", "2026-10-28 08:40", "2026-10-29 02:25"] |
| runner.sessions[].to | string | ["2026-10-27 23:50", "2026-10-29 02:10", "2026-10-30 21:05"] |
| runner.sessions[].end | string | ["PC 꺼짐", "재부팅", ""] |
| usage | object | [] |
| usage.Claude | object | [] |
| usage.Claude.remain | number | [64] |
| usage.Claude.reset | string | ["2026-11-04 04:00"] |
| usage.Claude.at | string | ["2026-11-03 22:10"] |
| usage.Codex | object | [] |
| usage.Codex.remain | number | [81] |
| usage.Codex.reset | string | ["2026-11-04 02:00"] |
| usage.Codex.at | string | ["2026-11-03 22:05"] |
| exec | object | [] |
| exec.reportedAt | string | ["2026-11-03 19:58"] |
| exec.models | object | [] |
| exec.models.Claude | array | [] |
| exec.models.Claude[] | object | [] |
| exec.models.Claude[].id | string | ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5-5"] |
| exec.models.Claude[].l | string | ["Fable 5.1", "Opus 5.5", "Sonnet 5.5"] |
| exec.models.Claude[].rank | number | [4, 3, 2] |
| exec.models.Claude[].allowed | boolean | [false, true] |
| exec.models.Claude[].isNew | boolean | [true] |
| exec.models.Codex | array | [] |
| exec.models.Codex[] | object | [] |
| exec.models.Codex[].id | string | ["codex-large", "codex-mini"] |
| exec.models.Codex[].l | string | ["Codex Large", "Codex Mini"] |
| exec.models.Codex[].rank | number | [2, 1] |
| exec.models.Codex[].allowed | boolean | [true] |
| exec.efforts | object | [] |
| exec.efforts.Claude | array | [] |
| exec.efforts.Claude[] | string | ["low", "medium", "high"] |
| exec.efforts.Codex | array | [] |
| exec.efforts.Codex[] | string | ["low", "medium", "high"] |
| exec.policy | object | [] |
| exec.policy.onUsage | string | ["wait"] |
| exec.policy.lowPct | number | [20] |
| exec.policy.onRework | string | ["up1"] |
| exec.policy.escNotify | number | [2] |
| exec.policy.floors | object | [] |
| exec.policy.floors.verifyGeDev | boolean | [true] |
| exec.policy.floors.dbHigh | boolean | [true] |
| exec.alerts | array | [] |
| exec.alerts[] | object | [] |
| exec.alerts[].at | string | ["2026-11-05 21:45", "2026-11-05 18:02"] |
| exec.alerts[].task | string | [""] |
| exec.alerts[].att | string | [""] |
| exec.alerts[].k | string | ["input", "drift"] |
| exec.alerts[].text | string | ["입력 자료 변경 커밋 2개 — 프로젝트 → 입력 자료에서 확인 후 분석", "설계 불일치 2건 — 계약 파일과 Task 브랜치 코드가 다름 · 설계 → 변경 · 불일치"] |
| subagents | object | [] |
| subagents.enabled | boolean | [true] |
| subagents.syncedAt | string | ["2026-11-03 19:58"] |
| subagents.defs | array | [] |
| subagents.defs[] | object | [] |
| subagents.defs[].id | string | ["fe-implementer", "be-implementer", "db-migrator"] |
| subagents.defs[].role | string | ["FE 구현", "BE 구현", "DB · Migration"] |
| subagents.defs[].agent | string | ["Claude", "Codex"] |
| subagents.defs[].tools | string | ["Read · Write · Edit · Bash · Glob · Grep", "Read · Write · Edit · Bash", "Read · Glob · Grep"] |
| subagents.defs[].sandbox | string | ["worktree 쓰기", "읽기 전용", "worktree 쓰기 (docs/ 만)"] |
| subagents.defs[].v | number | [3, 2, 1] |
| subagents.defs[].hash | string | ["4c1e9a", "91b07d", "0a77f3"] |
| subagents.defs[].updated | string | ["2026-11-02 18:10", "2026-10-30 11:20", "2026-10-28 09:00"] |
| subagents.defs[].allowed | boolean | [true, false] |
| subagents.defs[].ref | string | ["awesome-claude-code-subagents · react-specialist 점검 목록 일부", "awesome-claude-code-subagents · backend-developer 점검 목록 일부", "awesome-claude-code-subagents · postgres-pro 점검 목록 일부"] |
| subagents.defs[].text | string | ["React + TypeScript + Vite + Mantine 화면을 Task 명세의 FE 설계(화면 · 컴포넌트 · Interaction · API 연결 · Loading/Empty/Error 상태)대로 구현한다.\n- 프로토타입(Main.dc.html)의 같은 화면 · 문구 · 상태를 그대로 맞춘다.\n- 제외 범위에 있는 화면은 건드리지 않는다.\n- 완료 전에 Acceptance Criteria를 하나씩 직접 확인하고 결과를 남긴다.", "Fastify + TypeScript로 Task 명세의 API 설계(Endpoint · Request/Response · Validation · Error)를 구현한다.\n- 판정 로직(차단 · 순환 · Gate · 일정)은 packages/shared 순수 함수를 쓴다.\n- 모든 수정 API는 updatedAt 버전을 비교한다(409 VERSION_CONFLICT).", "Drizzle Schema · Migration을 Task의 DB 설계(컬럼 · 제약 · Index · Seed)대로 작성한다.\n- 되돌리기(down) Migration을 함께 작성하고 worktree 전용 DB에서 up → down → up을 실행해 결과를 Evidence로 남긴다."] |
| subagents.refs | array | [] |
| subagents.refs[] | object | [] |
| subagents.refs[].repo | string | ["VoltAgent/awesome-claude-code-subagents", "VoltAgent/awesome-codex-subagents"] |
| subagents.refs[].l | string | ["Claude Code 하위 Agent 모음 (약 154개)", "Codex 하위 Agent 모음 (약 175개)"] |
| subagents.refs[].use | string | ["참고 자료 — 점검 목록을 골라 우리 정의에 반영. 실행 중 직접 설치하지 않음", "참고 자료 — 같은 방식"] |
| ready | object | [] |
| ready.at | string | ["2026-11-03 19:58"] |
| ready.items | array | [] |
| ready.items[] | object | [] |
| ready.items[].k | string | ["claude", "codex", "git"] |
| ready.items[].l | string | ["Claude Code CLI", "Codex CLI", "git"] |
| ready.items[].st | string | ["ok", "warn"] |
| ready.items[].v | string | ["설치됨 · 로그인됨", "설치됨 · 로그인 만료 7일 전", "2.47"] |
| ready.items[].fix | string | ["", "만료 전에 &#96;codex login&#96;을 다시 실행하세요.", "실행은 계속합니다. 검증되지 않은 CLI 세션은 하위 Agent를 「1 + 예산」으로 보수 계산하고, 슬롯은 프로세스 그룹 종료 시에만 반환합니다."] |
| split | object | [] |
| split.maxH | number | [4] |
| split.minH | number | [0.5] |
| split.maxFiles | number | [8] |
| split.testIn | boolean | [true] |
| split.dir | string | ["layer"] |
| split.on | object | [] |
| split.on.one | boolean | [true] |
| split.on.domain | boolean | [true] |
| split.on.size | boolean | [true] |
| split.on.verify | boolean | [true] |
| split.on.revert | boolean | [true] |
| split.on.cg | boolean | [true] |
| split.on.contract | boolean | [true] |
| split.on.irrev | boolean | [true] |
| split.on.refactor | boolean | [true] |
| split.on.unknown | boolean | [true] |
| host | object | [] |
| host.id | string | ["KEEPROLL-PC"] |
| host.cpu | string | ["Intel Core Ultra 7 265K"] |
| host.cores | number | [20] |
| host.memGB | number | [23] |
| host.swapGB | number | [4] |
| host.diskGB | number | [952] |
| host.os | string | ["WSL2 · Linux 6.18.54.1"] |
| host.perSessGB | number | [1] |
| host.perSessN | number | [38] |
| host.at | string | ["2026-10-27 09:58"] |
| host.hist | array | [] |
| host.hist[] | object | [] |
| host.hist[].at | string | ["2026-10-27 09:58"] |
| host.hist[].id | string | ["KEEPROLL-PC"] |
| host.hist[].spec | string | ["Intel Core Ultra 7 265K · 20코어 · 메모리 23GB"] |
| host.hist[].why | string | ["최초 연결"] |
| conc | object | [] |
| conc.mode | string | ["auto"] |
| conc.cap | object | [] |
| conc.cap.total | number | [16] |
| conc.cap.Claude | number | [12] |
| conc.cap.Codex | number | [12] |
| conc.cap.heavy | number | [6] |
| conc.cap.memGB | number | [4] |
| conc.cur | number | [10] |
| conc.step | number | [2] |
| conc.subRatio | number | [0.5] |
| conc.res | object | [] |
| conc.res.cpu | number | [31] |
| conc.res.memUsed | number | [9.4] |
| conc.res.memTotal | number | [23] |
| conc.res.swap | number | [0] |
| conc.res.heavyRun | number | [1] |
| conc.res.at | string | ["2026-11-03 19:58"] |
| conc.log | array | [] |
| conc.log[] | object | [] |
| conc.log[].at | string | ["2026-11-03 10:02", "2026-11-03 10:14", "2026-11-03 19:58"] |
| conc.log[].from | number | [6, 8, 10] |
| conc.log[].to | number | [8, 10] |
| conc.log[].by | string | ["Runner"] |
| conc.log[].reason | string | ["시작값 6 → 자원 여유 · 오류 없음 10분 유지", "자원 여유 · 오류 없음 10분 유지", "재부팅 후 재연결 — 직전 한도 유지"] |
| obs | object | [] |
| obs.budget | object | [] |
| obs.budget.dev | number | [2] |
| obs.budget.qa | number | [3] |
| obs.enforce | string | ["observe"] |
| obs.cli | object | [] |
| obs.cli.Claude | object | [] |
| obs.cli.Claude.cli | string | ["Claude Code CLI"] |
| obs.cli.Claude.out | string | ["stream-json"] |
| obs.cli.Claude.inst | string | ["2.4.1 (Mock)"] |
| obs.cli.Claude.ver | string | [""] |
| obs.cli.Claude.model | string | [""] |
| obs.cli.Claude.opts | string | [""] |
| obs.cli.Claude.grade | string | ["unver"] |
| obs.cli.Claude.at | string | [""] |
| obs.cli.Claude.note | string | ["stream-json 하위 Agent 관측 검증 전"] |
| obs.cli.Codex | object | [] |
| obs.cli.Codex.cli | string | ["Codex CLI"] |
| obs.cli.Codex.out | string | ["exec --json"] |
| obs.cli.Codex.inst | string | ["0.167.0"] |
| obs.cli.Codex.ver | string | ["0.167.0"] |
| obs.cli.Codex.model | string | ["gpt-6.1-sol"] |
| obs.cli.Codex.opts | string | ["exec --json --skip-git-repo-check · 동시 수 · 깊이 기본값"] |
| obs.cli.Codex.grade | string | ["partial"] |
| obs.cli.Codex.at | string | ["2026-11-09"] |
| obs.cli.Codex.note | string | ["수행 · 병렬(약 4.9초 겹침) 관측 / ID · 상태 · 부모 연결 누락 / 종료 · 슬롯 반환 미확인 / 중단 · 재개 · 중첩 · 강제 종료 · 스트림 단절 보류"] |
| sched | object | [] |
| sched.policy | object | [] |
| sched.policy.autoReplan | boolean | [true] |
| sched.policy.cpAuto | boolean | [true] |
| sched.policy.threshold | number | [1] |
| sched.policy.assumeRate | number | [0.6] |
| sched.blackouts | array | [] |
| sched.blackouts[] | object | [] |
| sched.blackouts[].date | string | ["2026-11-08", "2026-11-15"] |
| sched.blackouts[].note | string | ["외부 일정 — PC 사용 불가", "정기 점검 — 전원 차단 예정"] |
| sched.baselines | array | [] |
| sched.baselines[] | object | [] |
| sched.baselines[].v | number | [1] |
| sched.baselines[].at | string | ["2026-10-27 10:20"] |
| sched.baselines[].reason | string | ["초기 WBS 등록 — Planning Agent 추정 (가동률 85% 가정)"] |
| sched.baselines[].rp | string | ["RP-001"] |
| sched.baselines[].ends | object | [] |
| sched.baselines[].ends.TASK-* | object | [] |
| sched.baselines[].ends.TASK-*.s | number | [20754, 20755, 20760] |
| sched.baselines[].ends.TASK-*.e | number | [20754, 20755, 20756] |
| sched.baselines[].projEnd | number | [20783] |
| sched.baselines[].lo | number | [20783] |
| sched.baselines[].hi | number | [20784] |
| sched.replans | array | [] |
| sched.replans[] | object | [] |
| sched.replans[].id | string | ["RP-001"] |
| sched.replans[].at | string | ["2026-10-27 10:20"] |
| sched.replans[].trigger | string | ["초기 WBS 등록 — Planning Agent 추정 (가동률 85% 가정)"] |
| sched.replans[].by | string | ["Planning Agent (Codex · Claude 합의)"] |
| sched.replans[].auto | boolean | [true] |
| sched.replans[].v | number | [1] |
| sched.replans[].after | number | [20783] |
| sched.replans[].lo | number | [20783] |
| sched.replans[].hi | number | [20784] |
| sched.replans[].rate | number | [0.85] |
| sched.replans[].moved | array | [] |
| reports | array | [] |
| reports[] | object | [] |
| reports[].id | string | ["RPT-D-261027", "RPT-D-261028", "RPT-D-261029"] |
| reports[].kind | string | ["daily", "weekly"] |
| reports[].from | string | ["2026-10-27", "2026-10-28", "2026-10-29"] |
| reports[].to | string | ["2026-10-27", "2026-10-28", "2026-10-29"] |
| reports[].at | string | ["2026-10-28 07:00", "2026-10-29 07:00", "2026-10-30 07:00"] |
| reports[].by | string | ["시스템 (정기)"] |
| reports[].data | object | [] |
| reports[].data.kind | string | ["daily", "weekly"] |
| reports[].data.from | string | ["2026-10-27", "2026-10-28", "2026-10-29"] |
| reports[].data.to | string | ["2026-10-27", "2026-10-28", "2026-10-29"] |
| reports[].data.at | string | ["2026-10-28 07:00", "2026-10-29 07:00", "2026-10-30 07:00"] |
| reports[].data.by | string | ["시스템 (정기)"] |
| reports[].data.det | object | [] |
| reports[].data.det.doneDet | array | [] |
| reports[].data.det.actDet | array | [] |
| reports[].data.det.failDet | array | [] |
| reports[].data.det.attTab | array | [] |
| reports[].data.det.rpDet | array | [] |
| reports[].data.det.rpDet[] | object | [] |
| reports[].data.det.rpDet[].id | string | ["RP-001"] |
| reports[].data.det.rpDet[].at | string | ["2026-10-27 10:20"] |
| reports[].data.det.rpDet[].trigger | string | ["초기 WBS 등록 — Planning Agent 추정 (가동률 85% 가정)"] |
| reports[].data.det.rpDet[].ch | string | ["최초 → 2026-11-26"] |
| reports[].data.det.rpDet[].range | string | ["11-26 ~ 11-27"] |
| reports[].data.det.rpDet[].moved | array | [] |
| reports[].data.det.rpDet[].more | number | [0] |
| reports[].data.det.msgDet | array | [] |
| reports[].data.det.nextDet | array | [] |
| reports[].data.det.nextDet[] | object | [] |
| reports[].data.det.nextDet[].id | string | ["TASK-0006", "TASK-0008", "TASK-0009"] |
| reports[].data.det.nextDet[].wbs | string | ["2.1.2", "2.2.2", "2.2.3"] |
| reports[].data.det.nextDet[].title | string | ["Dependency 검증", "Task Detail UI", "Checklist 기능"] |
| reports[].data.det.nextDet[].who | string | ["Claude 개발 · Codex 검증", "Codex 개발 · Claude 검증"] |
| reports[].data.det.nextDet[].per | string | ["10-28 ~ 10-28", "10-28 ~ 10-29", "10-29 ~ 10-29"] |
| reports[].data.det.nextDet[].est | string | ["3h", "6h", "4h"] |
| reports[].data.det.nextDet[].grade | string | ["Opus 5.5 · 높음", "Codex Large · 매우 높음"] |
| reports[].data.det.nextDet[].pre | string | ["선행 미충족 — TASK-0005(FS, 실행 중)", "선행 미충족 — TASK-0007(FS, 재작업 필요), TASK-0005(FS, 실행 중)", "선행 미충족 — TASK-0008(FS, 실행 대기)"] |
| reports[].data.det.nextDet[].cg | string | ["FE WBS 화면 (apps/web/src/wbs)", "BE Task API (apps/api/src/tasks)", "Runner API (apps/api/src/runner)"] |
| reports[].data.det.nextDet[].st | string | ["실행 대기", "계획 중", "승인 대기"] |
| reports[].data.det.allTab | array | [] |
| reports[].data.det.allTab[] | object | [] |
| reports[].data.det.allTab[].wbs | string | ["1.1.1", "1.1.2", "1.2.1"] |
| reports[].data.det.allTab[].id | string | ["TASK-0001", "TASK-0002", "TASK-0003"] |
| reports[].data.det.allTab[].title | string | ["Monorepo 구성", "PostgreSQL 연결", "Task 데이터 모델 설계"] |
| reports[].data.det.allTab[].st | string | ["완료", "QA 진행", "실행 중"] |
| reports[].data.det.allTab[].who | string | ["Claude/Codex", "Codex/Claude"] |
| reports[].data.det.allTab[].pct | string | ["100%", "65%", "35%"] |
| reports[].data.det.allTab[].cl | string | ["3/3", "2/2", "3/5"] |
| reports[].data.det.allTab[].verif | string | ["PASS", "검증 중", "미실시"] |
| reports[].data.det.allTab[].fc | string | ["완료 10-28", "완료 10-29", "완료 10-30"] |
| reports[].data.det.allTab[].slip | string | ["", "-28일", "-29일"] |
| reports[].data.det.allTab[].bl | string | ["", "차단"] |
| reports[].data.det.stL | string | ["완료 3 · QA 진행 1 · 실행 중 1 · 실행 대기 2 · 재작업 필요 1 · 계획 중 2 · 승인 대기 2"] |
| reports[].data.n | number | [12] |
| reports[].data.doneN | number | [0, 1, 2] |
| reports[].data.doneFromN | number | [0, 1, 2] |
| reports[].data.workPct | number | [0, 3.6, 6] |
| reports[].data.workPctFrom | number | [0, 3.6, 6] |
| reports[].data.done | array | [] |
| reports[].data.started | array | [] |
| reports[].data.atts | number | [0, 2, 3] |
| reports[].data.devAtts | number | [0, 1, 2] |
| reports[].data.qaAtts | number | [0, 1, 2] |
| reports[].data.pass | number | [0, 1] |
| reports[].data.failN | number | [0, 1] |
| reports[].data.fails | array | [] |
| reports[].data.esc | number | [0] |
| reports[].data.intr | array | [] |
| reports[].data.tok | number | [0, 270, 610] |
| reports[].data.v | number | [1] |
| reports[].data.fc | number | [20783] |
| reports[].data.lo | number | [20783] |
| reports[].data.hi | number | [20784] |
| reports[].data.rps | array | [] |
| reports[].data.rps[] | object | [] |
| reports[].data.rps[].id | string | ["RP-001"] |
| reports[].data.rps[].at | string | ["2026-10-27 10:20"] |
| reports[].data.rps[].trigger | string | ["초기 WBS 등록 — Planning Agent 추정 (가동률 85% 가정)"] |
| reports[].data.rps[].n | number | [0] |
| reports[].data.rps[].after | number | [20783] |
| reports[].data.up | number | [60, 64, 99] |
| reports[].data.gaps | array | [] |
| reports[].data.gaps[] | object | [] |
| reports[].data.gaps[].from | string | ["2026-10-27 23:50", "2026-10-29 02:10", "2026-10-30 21:05"] |
| reports[].data.gaps[].to | string | ["2026-10-28 08:40", "2026-10-29 02:25", "2026-11-01 10:00"] |
| reports[].data.gaps[].min | number | [10, 520, 15] |
| reports[].data.gaps[].reason | string | ["PC 꺼짐", "재부팅"] |
| reports[].data.issues | array | [] |
| reports[].data.next | array | [] |
| reports[].data.next[] | object | [] |
| reports[].data.next[].id | string | ["TASK-0006", "TASK-0008", "TASK-0009"] |
| reports[].data.next[].title | string | ["Dependency 검증", "Task Detail UI", "Checklist 기능"] |
| reports[].data.next[].fs | number | [20754, 20755, 20756] |
| reports[].data.next[].fe | number | [20754, 20755, 20756] |
| reports[].data.next[].started | boolean | [false, true] |
| reports[].data.blocked | number | [4] |
| reports[].data.series | array | [] |
| reports[].data.tgt | number | [20805] |
| reports[].data.rate | number | [60, 44, 49] |
| reports[].data.det.doneDet[] | object | [] |
| reports[].data.det.doneDet[].id | string | ["TASK-0001", "TASK-0002", "TASK-0003"] |
| reports[].data.det.doneDet[].wbs | string | ["1.1.1", "1.1.2", "1.2.1"] |
| reports[].data.det.doneDet[].title | string | ["Monorepo 구성", "PostgreSQL 연결", "Task 데이터 모델 설계"] |
| reports[].data.det.doneDet[].cls | string | ["구성 / DevOps", "분석 / Architecture"] |
| reports[].data.det.doneDet[].who | string | ["Claude 개발 · Codex 검증", "Codex 개발 · Claude 검증"] |
| reports[].data.det.doneDet[].act | string | ["2026-10-28 14:02 ~ 2026-10-28 16:40", "2026-10-29 09:10 ~ 2026-10-29 11:05", "2026-10-29 13:00 ~ 2026-10-30 18:10"] |
| reports[].data.det.doneDet[].est | string | ["1.5h → 실제 2h (시도 2회)", "1h → 실제 0h (시도 0회)", "3h → 실제 0h (시도 0회)"] |
| reports[].data.det.doneDet[].verif | string | ["PASS · pnpm install && pnpm -r build → 종료 코드 0 (52.4s)", "검증 기록 없음"] |
| reports[].data.det.doneDet[].cl | string | ["3 / 3 (필수 완료)", "2 / 2 (필수 완료)"] |
| reports[].data.det.doneDet[].out | string | ["3 / 3 제출 — pnpm-workspace.yaml, tsconfig.base.json, 루트 package.json 스크립트", "2 / 2 제출 — docker-compose.yml, apps/api/src/db/pool.ts", "1 / 1 제출 — docs/data-model.md"] |
| reports[].data.det.doneDet[].cond | string | ["루트에서 &#96;pnpm install && pnpm -r build&#96;가 오류 없이 완료된다.", "&#96;docker compose up -d&#96; 후 API의 &#96;/health/db&#96;가 200을 반환한다.", "&#96;docs/data-model.md&#96; v1.2가 교차 검토 후 승인된다."] |
| reports[].data.det.doneDet[].slip | string | ["기준 내"] |
| reports[].data.det.attTab[] | object | [] |
| reports[].data.det.attTab[].id | string | ["ATT-0001-1", "ATT-0001-2", "ATT-0007-1"] |
| reports[].data.det.attTab[].task | string | ["TASK-0001", "TASK-0007", "TASK-0004"] |
| reports[].data.det.attTab[].kind | string | ["개발", "QA"] |
| reports[].data.det.attTab[].agent | string | ["Claude", "Codex"] |
| reports[].data.det.attTab[].grade | string | ["Sonnet 5.5 · 낮음", "Codex Mini · 보통", "Opus 5.5 · 높음"] |
| reports[].data.det.attTab[].time | string | ["10-28 14:02 ~ 15:10", "10-28 15:30 ~ 16:20", "11-01 10:02 ~ 11:40"] |
| reports[].data.det.attTab[].st | string | ["완료", "실행 중"] |
| reports[].data.det.attTab[].sum | string | ["Workspace 구조와 공통 tsconfig 구성, 루트 스크립트 추가.", "클린 컨테이너 설치·빌드 검증 — PASS (V-0001-1).", "Tree 평탄화 훅과 Table 컴포넌트 구현, 필터 9종 연결."] |
| reports[].data.det.attTab[].files | number | [3, 0, 1] |
| reports[].data.det.attTab[].tok | number | [210, 60, 520] |
| reports[].data.det.attTab[].esc | string | [""] |
| reports[].data.done[] | object | [] |
| reports[].data.done[].id | string | ["TASK-0001", "TASK-0002", "TASK-0003"] |
| reports[].data.done[].title | string | ["Monorepo 구성", "PostgreSQL 연결", "Task 데이터 모델 설계"] |
| reports[].data.done[].at | string | ["2026-10-28 16:40", "2026-10-29 11:05", "2026-10-30 18:10"] |
| reports[].data.done[].wbs | string | ["1.1.1", "1.1.2", "1.2.1"] |
| reports[].data.started[] | object | [] |
| reports[].data.started[].id | string | ["TASK-0001", "TASK-0002", "TASK-0003"] |
| reports[].data.started[].title | string | ["Monorepo 구성", "PostgreSQL 연결", "Task 데이터 모델 설계"] |
| reports[].data.started[].at | string | ["2026-10-28 14:02", "2026-10-29 09:10", "2026-10-29 13:00"] |
| reports[].data.started[].wbs | string | ["1.1.1", "1.1.2", "1.2.1"] |
| reports[].data.fcPrev | number | [20783] |
| reports[].data.det.actDet[] | object | [] |
| reports[].data.det.actDet[].id | string | ["TASK-0007", "TASK-0004", "TASK-0005"] |
| reports[].data.det.actDet[].wbs | string | ["2.2.1", "1.2.2", "2.1.1"] |
| reports[].data.det.actDet[].title | string | ["WBS Tree UI", "Drizzle Schema 설계", "Task CRUD API"] |
| reports[].data.det.actDet[].cls | string | ["구현 / FE", "설계 / DB", "구현 / BE"] |
| reports[].data.det.actDet[].st | string | ["재작업 필요", "QA 진행", "실행 중"] |
| reports[].data.det.actDet[].who | string | ["Claude 개발 · Codex 검증"] |
| reports[].data.det.actDet[].pct | string | ["50%", "65%", "35%"] |
| reports[].data.det.actDet[].start | string | ["2026-11-01 10:02", "2026-11-03 15:10", "2026-11-03 19:58"] |
| reports[].data.det.actDet[].fc | string | ["2026-11-02 (범위 11-02 ~ 11-06)", "2026-11-03 (범위 11-03 ~ 11-03)", "2026-11-04 (범위 11-04 ~ 11-04)"] |
| reports[].data.det.actDet[].remain | string | ["2.5h", "1.4h", "3.9h"] |
| reports[].data.det.actDet[].slip | string | ["기준보다 24일 빠름", "기준보다 23일 빠름", "기준보다 21일 빠름"] |
| reports[].data.det.actDet[].last | string | ["ATT-0007-2 QA (Codex · Codex Large · 높음, 완료) — 기능 · 성능 QA — 14건 중 2건 FAIL (V-0007-1). 재작업 요청.", "ATT-0004-2 QA (Codex · Codex Large · 높음, 실행 중) — 빈 DB에서 migrate 및 제약 위반 SQL 실행 중.", "ATT-0005-1 개발 (Claude · Opus 5.5 · 높음, 실행 중) — Route 등록 완료, Service 계층 작성 중."] |
| reports[].data.det.actDet[].verif | string | ["FAIL — 12/14 통과 — 필터 시 상위 Phase 행 누락, 1,000행 펼치기 412ms", "검증 중", "미실시"] |
| reports[].data.det.actDet[].cl | string | ["3 / 5 (필수 2건 남음)", "3 / 5 (필수 1건 남음)", "1 / 5 (필수 3건 남음)"] |
| reports[].data.det.actDet[].gate | string | ["1 / 5 — 미충족: 필수 Checklist 완료, 필수 산출물 존재, 필요한 Verification 통과, 미해결 차단 결함 없음", "2 / 5 — 미충족: 필수 Checklist 완료, 필수 산출물 존재, 필요한 Verification 통과"] |
| reports[].data.det.actDet[].next | string | ["Claude 재작업 → Codex 재검증", "Codex QA 진행 → 결과에 따라 Gate 또는 재작업", "Claude 개발 진행 → 완료 보고 후 Codex QA"] |
| reports[].data.det.actDet[].issue | string | ["차단 결함 2건", "없음"] |
| reports[].data.det.failDet[] | object | [] |
| reports[].data.det.failDet[].id | string | ["V-0007-1"] |
| reports[].data.det.failDet[].task | string | ["TASK-0007"] |
| reports[].data.det.failDet[].title | string | ["WBS Tree UI"] |
| reports[].data.det.failDet[].agent | string | ["Codex"] |
| reports[].data.det.failDet[].at | string | ["2026-11-01 13:35"] |
| reports[].data.det.failDet[].cmd | string | ["pnpm --filter web test -- wbs-tree"] |
| reports[].data.det.failDet[].exp | string | ["14/14 통과, 1,000행 펼치기 100ms 이내"] |
| reports[].data.det.failDet[].act | string | ["12/14 통과 — 필터 시 상위 Phase 행 누락, 1,000행 펼치기 412ms"] |
| reports[].data.det.failDet[].defects | string | ["DEF-0007-1 필터 결과에서 상위 노드 누락 (차단 결함) / DEF-0007-2 대량 펼치기 성능 기준 미달 (차단 결함)"] |
| reports[].data.det.failDet[].ev | string | ["evidence/TASK-0007/qa-1/vitest.txt, evidence/TASK-0007/qa-1/perf.json, evidence/TASK-0007/qa-1/filter-missing-parent.png"] |
| reports[].data.det.failDet[].follow | string | ["수정 지시 MSG-001(Acknowledged) · 재작업 시작 전"] |
| reports[].data.det.msgDet[] | object | [] |
| reports[].data.det.msgDet[].at | string | ["2026-11-01 14:02", "2026-11-01 14:09", "2026-11-03 19:42"] |
| reports[].data.det.msgDet[].task | string | ["TASK-0007", "TASK-0005"] |
| reports[].data.det.msgDet[].dir | string | ["팀장 → Claude", "Claude → 팀장", "팀장 → Codex"] |
| reports[].data.det.msgDet[].type | string | ["수정 요청", "응답", "질문"] |
| reports[].data.det.msgDet[].st | string | ["Acknowledged", "응답", "Failed"] |
| reports[].data.det.msgDet[].body | string | ["QA-1 실패 2건을 재작업해 주세요.", "수정 요청을 수신했습니다. 재작업 계획입니다.", "Task CRUD API QA 시 soft delete된 Task가 목록 조회에서 제외되는지도 확인 항목에 넣을 수 있을까요?"] |
| reports[].data.fails[] | object | [] |
| reports[].data.fails[].id | string | ["V-0007-1"] |
| reports[].data.fails[].task | string | ["TASK-0007"] |
| reports[].data.fails[].title | string | ["WBS Tree UI"] |
| reports[].data.fails[].actual | string | ["12/14 통과 — 필터 시 상위 Phase 행 누락, 1,000행 펼치기 412ms"] |
| reports[].data.issues[] | object | [] |
| reports[].data.issues[].lv | string | ["warn", "info", "bad"] |
| reports[].data.issues[].t | string | ["TASK-0007 재작업 필요 — WBS Tree UI", "CP-002 Change Proposal 검토 대기 — Dependency 검증을 Task CRUD API와 병행 착수", "메시지 MSG-003 전달 실패 (TASK-0005)"] |
| reports[].data.issues[].task | string | ["TASK-0007", "", "TASK-0005"] |
| reports[].data.series[] | object | [] |
| reports[].data.series[].day | string | ["2026-10-27", "2026-10-28", "2026-10-29"] |
| reports[].data.series[].done | number | [0, 1] |
| reports[].data.series[].atts | number | [0, 2, 3] |
| reports[].data.series[].fails | number | [0, 1] |
| reports[].data.series[].up | number | [60, 64, 99] |
| reports[].data.series[].fc | number | [20783] |
| reports[].late | boolean | [true] |
| reports[].lateL | string | ["서버 시작 시 누락분 보충 — 예정 2026-11-05 07:00", "서버 시작 시 누락분 보충 — 예정 2026-11-06 07:00", "서버 시작 시 누락분 보충 — 예정 2026-11-07 07:00"] |
| mail | object | [] |
| mail.smtp | object | [] |
| mail.smtp.host | string | ["smtp.example.com"] |
| mail.smtp.port | number | [587] |
| mail.smtp.sec | string | ["STARTTLS"] |
| mail.smtp.from | string | ["Agent WBS <agent-wbs@example.com>"] |
| mail.smtp.user | string | ["agent-wbs@example.com"] |
| mail.smtp.pwSet | boolean | [true] |
| mail.smtp.ok | boolean | [true] |
| mail.smtp.checkedAt | string | ["2026-11-03 07:00"] |
| mail.smtp.err | string | [""] |
| mail.recips | array | [] |
| mail.recips[] | object | [] |
| mail.recips[].id | string | ["RC-1", "RC-2", "RC-3"] |
| mail.recips[].email | string | ["leader@example.com", "director@example.com", "pm-archive@example.com"] |
| mail.recips[].name | string | ["팀장", "상급자 (주간보고)", "PM 보관함"] |
| mail.recips[].daily | boolean | [true, false] |
| mail.recips[].weekly | boolean | [true] |
| mail.recips[].view | string | ["int", "ext"] |
| mail.recips[].pdf | boolean | [false, true] |
| mail.recips[].active | boolean | [true, false] |
| mail.recips[].at | string | ["2026-10-27 09:50", "2026-10-27 09:52", "2026-10-29 14:00"] |
| mail.log | array | [] |
| mail.log[] | object | [] |
| mail.log[].id | string | ["ML-0001", "ML-0002", "ML-0003"] |
| mail.log[].at | string | ["2026-10-28 07:01", "2026-10-29 07:01", "2026-10-30 07:01"] |
| mail.log[].rep | string | ["RPT-D-261027", "RPT-D-261028", "RPT-D-261029"] |
| mail.log[].to | string | ["leader@example.com", "director@example.com"] |
| mail.log[].rid | string | ["RC-1", "RC-2"] |
| mail.log[].view | string | ["int", "ext"] |
| mail.log[].pdf | boolean | [false, true] |
| mail.log[].subject | string | ["[Agent WBS] 일간 보고 2026-10-27 — 완료 0건 · 완료 예상 11-26", "[Agent WBS] 일간 보고 2026-10-28 — 완료 1건 · 완료 예상 11-26", "[Agent WBS] 일간 보고 2026-10-29 — 완료 1건 · 완료 예상 11-26"] |
| mail.log[].st | string | ["발송됨", "실패"] |
| mail.log[].err | string | ["", "수신 서버 일시 거부 (451 4.7.1 — 잠시 후 재시도)"] |
| mail.log[].why | string | ["정기 발송", "자동 재시도 (15분 후)", "서버 시작 시 누락분 보충 후 발송"] |
| mail.seq | number | [38] |
| design | object | [] |
| design.decisions | array | [] |
| design.decisions[] | object | [] |
| design.decisions[].id | string | ["TD-01", "TD-02", "TD-03"] |
| design.decisions[].area | string | ["데이터", "운영", "통신"] |
| design.decisions[].title | string | ["운영 DB", "캐시 · 잠금 · 하트비트", "시계열 데이터"] |
| design.decisions[].choice | string | ["PostgreSQL 16", "Redis 7", "QuestDB"] |
| design.decisions[].auth | string | ["lead", "agent", "free"] |
| design.decisions[].lv | string | ["must", "cond", "ban"] |
| design.decisions[].st | string | ["fixed", "pending", "approved"] |
| design.decisions[].by | string | ["팀장", "Planning Agent", "Claude (TASK-0005)"] |
| design.decisions[].at | string | ["2026-10-27 09:40", "2026-11-06 14:20", "2026-10-27 10:05"] |
| design.decisions[].cond | string | ["", "시계열 데이터(시간 순 대량 쓰기 · 구간 집계 · 보관 기간)가 있으면 QuestDB 사용"] |
| design.decisions[].reason | string | ["프로젝트 등록 시 기술 제약 (필수)", "조건 충족 판단 — Runner 자원 관측 샘플: 세션별 CPU · 메모리 10초 간격, 하루 약 70만 행, 조회는 1분 · 1시간 구간 평균, 원본 14일 보관. PostgreSQL에 두면 운영 테이블과 쓰기 경합.", "팀장 PC(WSL)에서 운영 — 외부 의존 없음"] |
| design.decisions[].alts | string | ["", "PostgreSQL 시간 파티션 (규모가 작으면 충분) — 기각: 보관 · 집계 관리를 직접 구현해야 함", "PostgreSQL 재귀 CTE — 기각: 깊이가 깊고 경로 조건이 복잡해 쿼리 유지가 어려움"] |
| design.comps | array | [] |
| design.comps[] | object | [] |
| design.comps[].id | string | ["web", "api", "worker"] |
| design.comps[].layer | string | ["클라이언트", "서버", "팀장 PC"] |
| design.comps[].name | string | ["Web (FE)", "API 서버", "이벤트 소비자"] |
| design.comps[].tech | string | ["React · TypeScript · Vite · Mantine", "Node.js · Fastify · Drizzle", "Node.js"] |
| design.comps[].note | string | ["팀장 브라우저", "REST · SSE · Runner WebSocket", "Kafka 소비 → 일정 재조정 · 보고서 · Neo4j 반영"] |
| design.comps[].dec | string | ["TD-01", "TD-05", "TD-03"] |
| design.links | array | [] |
| design.links[] | array | [] |
| design.links[][] | string | ["web", "api", "REST"] |
| design.files | array | [] |
| design.files[] | object | [] |
| design.files[].path | string | ["contracts/api/openapi.yaml", "contracts/events/asyncapi.yaml", "contracts/db/postgres/migrations/*.sql"] |
| design.files[].kind | string | ["REST", "이벤트 · WebSocket · SSE", "PostgreSQL"] |
| design.files[].fmt | string | ["OpenAPI 3.1", "AsyncAPI 3.0", "SQL 마이그레이션 (기준) — src/의 Drizzle 스키마는 이것과 대조"] |
| design.files[].st | string | ["ok", "draft"] |
| design.files[].commit | string | ["a41f0c2 · 11-05", "9c2e7aa · 11-04", "3be19d0 · 11-02"] |
| design.files[].n | string | ["엔드포인트", "채널", "테이블"] |
| design.ifaces | array | [] |
| design.ifaces[] | object | [] |
| design.ifaces[].id | string | ["WS:runner", "SSE:events", "K:attempt"] |
| design.ifaces[].kind | string | ["WebSocket", "SSE", "Kafka"] |
| design.ifaces[].name | string | ["/runner/ws", "GET /api/events", "runner.attempt.events"] |
| design.ifaces[].desc | string | ["Runner ↔ 서버 제어 채널", "화면 실시간 갱신", "Runner 실행 이벤트 (시작 · 진행 · 종료 · 산출물)"] |
| design.ifaces[].task | string | ["TASK-0012", "TASK-0010"] |
| design.ifaces[].st | string | ["계획"] |
| design.ifaces[].auth | string | ["Runner 토큰 (등록 시 발급)", "팀장 세션", "—"] |
| design.ifaces[].dec | string | ["TD-07", "TD-08", "TD-06"] |
| design.ifaces[].msgs | array | [] |
| design.ifaces[].msgs[] | object | [] |
| design.ifaces[].msgs[].n | string | ["hello", "attempt.start", "instruction.deliver"] |
| design.ifaces[].msgs[].dir | string | ["Runner → 서버", "서버 → Runner", "서버 → 화면"] |
| design.ifaces[].msgs[].s | string | ["{ runnerId, version, host: { cores, memGB }, cli: { claude, codex } }", "{ attemptId, taskKey, agent, model, effort, worktree, instructions, subBudget }", "{ attemptId, messageId, text }"] |
| design.ifaces[].rules | array | [] |
| design.ifaces[].rules[] | string | ["연결 끊김 30초 → Runner 오프라인 처리", "메시지마다 msgId — 재전송 시 중복 무시", "Last-Event-ID로 재연결 시 놓친 이벤트 재전송 (최근 5분)"] |
| design.ifaces[].topic | object | [] |
| design.ifaces[].topic.key | string | ["taskKey (같은 Task 이벤트 순서 보장)", "itemKey"] |
| design.ifaces[].topic.parts | string | ["3", "1"] |
| design.ifaces[].topic.retention | string | ["7일", "30일"] |
| design.ifaces[].topic.delivery | string | ["최소 1회 — 소비자는 eventId로 중복 제거", "최소 1회"] |
| design.ifaces[].topic.dlq | string | ["runner.attempt.events.dlq", "—"] |
| design.ifaces[].topic.compat | string | ["하위 호환만 허용 (필드 추가 OK · 삭제 · 타입 변경 금지)", "하위 호환만 허용"] |
| design.ifaces[].topic.consumers | string | ["schedule-replanner, report-builder, graph-sync", "graph-sync"] |
| design.stores | object | [] |
| design.stores.neo4j | object | [] |
| design.stores.neo4j.labels | array | [] |
| design.stores.neo4j.labels[] | object | [] |
| design.stores.neo4j.labels[].n | string | ["Task", "DesignItem", "Screen"] |
| design.stores.neo4j.labels[].props | string | ["taskKey (UNIQUE) · title · status", "itemKey (UNIQUE) · kind · name", "screenId (UNIQUE) · name"] |
| design.stores.neo4j.labels[].note | string | ["PostgreSQL tasks 복제", "API · 테이블 · 채널 · 토픽", "프로토타입 화면"] |
| design.stores.neo4j.rels | array | [] |
| design.stores.neo4j.rels[] | object | [] |
| design.stores.neo4j.rels[].n | string | ["DEPENDS_ON", "TOUCHES", "READS_WRITES"] |
| design.stores.neo4j.rels[].from | string | ["Task", "DesignItem", "Screen"] |
| design.stores.neo4j.rels[].to | string | ["Task", "DesignItem"] |
| design.stores.neo4j.rels[].props | string | ["type (FS &#124; SS)", "role (만듦 &#124; 바꿈 &#124; 사용 &#124; 검증)", "mode (R &#124; W) — API → 테이블"] |
| design.stores.neo4j.cons | array | [] |
| design.stores.neo4j.cons[] | string | ["CREATE CONSTRAINT task_key FOR (t:Task) REQUIRE t.taskKey IS UNIQUE", "CREATE CONSTRAINT item_key FOR (d:DesignItem) REQUIRE d.itemKey IS UNIQUE"] |
| design.stores.neo4j.task | string | ["TASK-0010"] |
| design.stores.neo4j.st | string | ["계획"] |
| design.stores.questdb | object | [] |
| design.stores.questdb.tables | array | [] |
| design.stores.questdb.tables[] | object | [] |
| design.stores.questdb.tables[].n | string | ["runner_samples"] |
| design.stores.questdb.tables[].ts | string | ["ts (기준 타임스탬프)"] |
| design.stores.questdb.tables[].part | string | ["DAY"] |
| design.stores.questdb.tables[].ret | string | ["14일 (TTL)"] |
| design.stores.questdb.tables[].dedup | string | ["ts, runner_id, session_id"] |
| design.stores.questdb.tables[].sym | string | ["runner_id, session_id, agent"] |
| design.stores.questdb.tables[].cols | string | ["cpu_pct DOUBLE · mem_mb DOUBLE · subs INT"] |
| design.stores.questdb.tables[].ingest | string | ["ILP (Runner → QuestDB 9009)"] |
| design.stores.questdb.tables[].agg | string | ["1분 · 1시간 평균은 QuestDB SAMPLE BY 조회 — PostgreSQL로 보내지 않음"] |
| design.stores.questdb.task | string | ["TASK-0013 (승인 시 생성)"] |
| design.stores.questdb.st | string | ["승인 대기"] |
| design.stores.redis | object | [] |
| design.stores.redis.keys | array | [] |
| design.stores.redis.keys[] | object | [] |
| design.stores.redis.keys[].p | string | ["runner:{runnerId}:hb", "lock:task:{taskKey}", "cache:wbs:{projectId}:tree"] |
| design.stores.redis.keys[].use | string | ["하트비트", "실행 잠금 (같은 Task 동시 실행 방지)", "WBS 트리 요약 캐시"] |
| design.stores.redis.keys[].val | string | ["JSON { at, sessions }", "attemptId", "JSON"] |
| design.stores.redis.keys[].ttl | string | ["30초", "15분 (갱신)", "5분"] |
| design.stores.redis.keys[].inv | string | ["만료 = 오프라인", "실행 종료 시 삭제", "Task · 의존성 변경 시 삭제"] |
| design.stores.redis.keys[].persist | string | ["불필요"] |
| design.stores.redis.task | string | ["TASK-0012"] |
| design.stores.redis.st | string | ["계획"] |
| design.own | array | [] |
| design.own[] | object | [] |
| design.own[].data | string | ["Task · 의존성 · 체크리스트", "설계 항목 연결 (API ↔ 테이블 ↔ 화면)", "실행 시도 · 결과"] |
| design.own[].src | string | ["PostgreSQL", "저장소 계약 파일", "QuestDB (승인 시)"] |
| design.own[].copy | string | ["Neo4j (Task · DEPENDS_ON)", "Neo4j (DesignItem · READS_WRITES · SHOWS)", "—"] |
| design.own[].sync | string | ["design.item.changed / task 변경 이벤트 → graph-sync", "main 병합 시 Runner가 파싱 → 이벤트", "Kafka runner.attempt.events → 서버가 기록"] |
| design.own[].lag | string | ["수 초", "병합 후 1분", "—"] |
| design.versions | array | [] |
| design.versions[] | object | [] |
| design.versions[].v | number | [3, 2, 1] |
| design.versions[].at | string | ["2026-11-05 17:40", "2026-10-31 15:10", "2026-10-27 10:20"] |
| design.versions[].by | string | ["팀장 승인 (CP-004)", "TASK-0004 병합", "기술 결정 확정 (팀장)"] |
| design.versions[].note | string | ["Runner API 계약 16개 · Runner WebSocket · Kafka 토픽 2개 추가", "PostgreSQL 테이블 4개 (wbs_nodes · tasks · task_dependencies · checklist_items)", "기술 결정 9건 확정 · 계약 파일 골격 생성"] |
| design.versions[].brk | boolean | [false] |
| design.drifts | array | [] |
| design.drifts[] | object | [] |
| design.drifts[].id | string | ["DR-01", "DR-02", "DR-03"] |
| design.drifts[].kind | string | ["REST", "PostgreSQL", "Kafka"] |
| design.drifts[].item | string | ["PATCH /api/tasks/:taskKey", "tasks", "runner.attempt.events"] |
| design.drifts[].where | string | ["feature/TASK-0005 브랜치", "feature/TASK-0004 브랜치 마이그레이션", "main"] |
| design.drifts[].t | string | ["코드 응답에 &#96;updatedBy&#96; 필드가 있으나 계약(openapi.yaml)에는 없음", "&#96;tasks.deleted_at&#96; 부분 인덱스가 마이그레이션에만 있고 schema.ts에 없음", "계약의 AttemptProgress에 &#96;subObserved&#96; 필드 추가됨 — 소비자 report-builder가 아직 모름 (호환 변경)"] |
| design.drifts[].task | string | ["TASK-0005", "TASK-0004", "TASK-0012"] |
| design.drifts[].brk | boolean | [false] |
| design.drifts[].st | string | ["open", "done"] |
| github | object | [] |
| github.mode | string | ["gh"] |
| github.ok | boolean | [true] |
| github.account | string | ["team-lead (gh)"] |
| github.checkedAt | string | ["2026-11-03 07:00"] |
| github.err | string | [""] |
| github.tokenSet | boolean | [false] |
| github.expires | string | [""] |
| github.scopes | object | [] |
| github.scopes.contents | boolean | [true] |
| github.scopes.pulls | boolean | [true] |
| github.scopes.statuses | boolean | [true] |
| github.scopes.metadata | boolean | [true] |
| ci | object | [] |
| ci.main | object | [] |
| ci.main.st | string | ["pass"] |
| ci.main.commit | string | ["c4e81f0"] |
| ci.main.at | string | ["2026-11-03 02:14"] |
| ci.main.e2e | string | ["12 / 12"] |
| ci.runs | array | [] |
| ci.runs[] | object | [] |
| ci.runs[].id | string | ["CI-0101", "CI-0102", "CI-0108"] |
| ci.runs[].stage | string | ["task", "int", "night"] |
| ci.runs[].task | string | ["TASK-0001", "TASK-0002", "TASK-0003"] |
| ci.runs[].att | string | ["ATT-0001-1", "", "ATT-0007-1"] |
| ci.runs[].ref | string | ["agent/TASK-0001 @ 3b7d2e1", "main + #3", "main + #5"] |
| ci.runs[].pr | string | ["#3", "#5", "#7"] |
| ci.runs[].at | string | ["2026-10-28 15:11", "2026-10-28 16:24", "2026-10-29 17:02"] |
| ci.runs[].dur | string | ["3분 02초", "7분 40초", "8분 15초"] |
| ci.runs[].st | string | ["pass", "fail"] |
| ci.runs[].trig | string | ["Agent 작업 종료", "검증 PASS → 병합 대기열", "야간 일정"] |
| ci.runs[].merged | string | ["병합됨 → main @ 4c1a0f7", "병합됨 → main @ 8e33b1d", "병합됨 → main @ c4e81f0"] |
| ci.runs[].note | string | ["검사는 통과 — 이후 QA(ATT-0007-2)에서 수용 기준 미충족으로 FAIL. 기계 검사는 필요조건일 뿐 충분조건이 아님", "E2E 12/12 · 화면 비교 9개 중 2개 경미한 차이(여백) · 불안정 후보 1", "접속 확인 — 로그인 · WBS · Task 상세 스크린샷 3장"] |
| ci.runs[].url | string | ["http://localhost:8080"] |
| ci.runs[].failStep | number | [6] |
| ci.runs[].log | string | ["contract-test › contracts/db/postgres/migrations/0004_tasks.sql\n  ✗ index \"tasks_deleted_at_idx\" exists in database but not in contracts/\n  1 failed, 38 passed (3.1s)\nexit code 1"] |
| ci.queue | array | [] |
| ci.queue[] | object | [] |
| ci.queue[].pr | string | ["#3", "#5", "#7"] |
| ci.queue[].task | string | ["TASK-0001", "TASK-0002", "TASK-0003"] |
| ci.queue[].st | string | ["병합됨", "검증 대기"] |
| ci.queue[].at | string | ["2026-10-28 16:32", "2026-10-29 17:11", "2026-10-31 11:49"] |
| ci.flaky | array | [] |
| ci.flaky[] | object | [] |
| ci.flaky[].t | string | ["wbs-tree.spec.ts › 접힘 상태 유지"] |
| ci.flaky[].rate | string | ["2 / 20 실패"] |
| ci.flaky[].last | string | ["2026-11-03 02:00"] |
| ci.flaky[].st | string | ["격리"] |
| ci.flaky[].task | string | ["TASK-0007"] |
| ci.settings | object | [] |
| ci.settings.night | string | ["02:00"] |
| ci.settings.retry | number | [1] |
| ci.settings.svc | string | ["docker compose — docker-compose.ci.yml"] |
| ci.settings.deployUrl | string | ["http://localhost:8080"] |
| appUrl | string | ["http://localhost:5173"] |
| tg | object | [] |
| tg.conf | object | [] |
| tg.conf.on | boolean | [true] |
| tg.conf.tokenSet | boolean | [true] |
| tg.conf.tokenLast4 | string | ["xxxx"] |
| tg.conf.bot | object | [] |
| tg.conf.bot.name | string | ["Agent WBS 알림 (Mock)"] |
| tg.conf.bot.user | string | ["@agentwbs_mock_bot"] |
| tg.conf.botSt | string | ["ok"] |
| tg.conf.botKind | string | [""] |
| tg.conf.botErr | string | [""] |
| tg.conf.target | string | ["팀장 개인 알림"] |
| tg.conf.chatId | string | ["512345678"] |
| tg.conf.chat | object | [] |
| tg.conf.chat.name | string | ["팀장 (개인 · Mock)"] |
| tg.conf.chat.type | string | ["개인"] |
| tg.conf.test | string | ["ok"] |
| tg.conf.testKind | string | [""] |
| tg.conf.testErr | string | [""] |
| tg.rules | object | [] |
| tg.rules.done | boolean | [false] |
| tg.rules.fail | boolean | [true] |
| tg.rules.admin | boolean | [true] |
| tg.rules.approve | boolean | [true] |
| tg.rules.buildOk | boolean | [false] |
| tg.rules.buildFail | boolean | [true] |
| tg.log | array | [] |
| tg.log[] | object | [] |
| tg.log[].id | string | ["TG-0001", "TG-0002", "TG-0003"] |
| tg.log[].proj | string | ["Verum-SDN Agent WBS — Self Development"] |
| tg.log[].dup | number | [0, 1] |
| tg.log[].tries | number | [1, 2] |
| tg.log[].err | string | ["전송 권한 없음 · 봇 차단 — 403 Forbidden (그룹에 봇 미초대)", "", "요청 제한(429) 1회 → 15초 후 재시도 성공"] |
| tg.log[].at | string | ["2026-10-27 10:05", "2026-10-27 10:12", "2026-11-01 13:35"] |
| tg.log[].kind | string | ["테스트", "업무"] |
| tg.log[].ev | string | ["test", "fail", "admin"] |
| tg.log[].target | string | ["테스트 알림", "TASK-0007 WBS Tree UI", "Runner 준비 상태 — Codex CLI"] |
| tg.log[].to | string | ["Verum-SDN 개발 (-4123456789)", "팀장 개인 알림 (512345678)"] |
| tg.log[].key | string | ["test", "fail&#124;sample", "admin&#124;ready-codex"] |
| tg.log[].st | string | ["실패", "전송 요청 수락"] |
| tg.log[].msg | string | ["[Agent WBS] 테스트 알림\n이 대화로 Agent WBS 알림을 받도록 설정하는 중입니다.\n수신 대상: Verum-SDN 개발\n발생: 2026-10-27 10:05", "[Agent WBS] 테스트 알림\n이 대화로 Agent WBS 알림을 받도록 설정하는 중입니다.\n수신 대상: 팀장 개인 알림\n발생: 2026-10-27 10:12", "[Agent WBS] Task 실패\n프로젝트: Verum-SDN Agent WBS — Self Development\n대상: TASK-0007 WBS Tree UI\n상태: 검증 FAIL 확정 (V-0007-1) — 수용 기준 미충족\n이유: 접힘 상태 유지 시나리오 실패. 원인은 분석 전(확정 아님)\n발생: 2026-11-01 13:35\n다음 행동: WBS에서 검증 결과 확인 · 재작업 지시 검토\nWBS에서 확인: http://localhost:5173/wbs/TASK-0007"] |
| tg.log[].nav | object | [] |
| tg.log[].nav.k | string | ["task", "settings", "cp"] |
| tg.log[].nav.id | string | ["TASK-0007", "CP-002"] |
| tg.log[].resolved | boolean | [true, false] |
| tg.seq | number | [5] |
