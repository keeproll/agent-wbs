# features/planning · features/change — Planning·변경 제안 화면(M3-05)

팀장이 Planning 결과를 보고 이견을 고르고, 변경 제안(CP)을 승인·반영하는 화면이다.
처음 읽는다면 [apps/web/README.md](../../../README.md) → [src/shared/README.md](../../shared/README.md) → 이 문서 순서로 읽는다.
낯선 말은 맨 아래 [용어집](#용어집)에 있다.

## 1. 화면과 주소

| 주소 | 화면 | 원본 |
|---|---|---|
| `/planning` | Planning 세션(UI-05·UI-05-01) | P L1614–1685 |
| `/planning?session=<id>` | 고른 세션 | 같음 |
| `/planning?tab=replans` | 일정 재조정 이력(UI-05-02) | P L1618–1637 |
| `/change` | 변경 제안 목록 + 가장 최근 CP 상세(UI-09·UI-09A) | P L1687–1745 |
| `/change/<CP 키 또는 id>` | 그 CP 상세. 알림 링크로 여는 주소 | 같음 |

- 탭과 고른 세션을 주소에 두는 이유: 새로고침·뒤로 가기·다른 화면의 링크(CP의 「출처」 버튼)로 같은 화면을 다시 열기 위해서다.
- 라우터 연결(`src/app/router.tsx`)은 이 작업에서 했다. 시험(E2E)이 실제 주소로 화면을 열어야 하기 때문이다. 병합 때 다른 작업과 겹치면 `DONE` 표에 메뉴를 하나씩 더하면 된다.

## 2. 파일 지도

```
features/change/
  ChangePage.tsx      목록·주소의 CP 찾기·편집 보호(이 화면에 하나)·작성 모달 열기
  ProposalDetail.tsx  상세: 배너·사유·Diff·문제·보류 사유·판단 결과·영향 분석·승인 상자·승인 이력
  ProposalModal.tsx   「Change Proposal 작성」 모달(MOD-07)
  model.ts            표시 계산(서버 값 → 원본 문구). 판정은 하지 않는다
  form.ts             모달 입력 → 계약 본문(createProposal) 변환과 검사
  find.ts             알림 링크의 CP를 목록 끝까지 넘겨 찾기
  types.ts            계약 타입 별칭
  change.css          이 화면 전용 CSS(제목 단계·휴대폰 폭)
features/planning/
  PlanningPage.tsx    탭·세션 목록·메모 초안·편집 보호
  SessionView.tsx     세션 한 건: 단계·독립 분석·교차 검토(이견 선택)·최종 Diff·CP 작성
  ReplanTab.tsx       재조정 이력·재조정 실행
  model.ts            단계·최종 변경·CP 사유·재조정 행 계산
```

## 3. 지키는 규칙과 이유

### 3.1 판정은 서버가 한다

- 문제(`issues`)·보류 사유(`holdReasons`)·영향(`impact`)은 모두 서버 미리보기(`GET /api/proposals/:id/preview`)의 값을 그대로 보인다.
  - 왜: 미리보기와 반영은 서버의 같은 함수다(contracts §2.1). 화면이 따로 계산하면 팀장이 본 결과와 실제 반영이 달라질 수 있다.
- 승인·반영 요청에는 미리보기의 `previewHash`를 함께 보낸다. 그 사이 결과가 바뀌었으면 서버가 409 `VERSION_CONFLICT`로 거부하고 충돌 창이 열린다.

### 3.2 저장은 모두 `useSave`

- 승인·반려·수정 요청·제출·WBS 반영·이견 선택·CP 작성·재조정 실행이 모두 공통 `useSave`를 쓴다(shared/README §3).
- 요청 내용은 버튼을 누른 순간 찍는다. 재시도는 같은 내용·같은 멱등 키로 보낸다.
  - 왜: 서버가 처리하고 응답만 잃었을 수 있다. 새 키로 다시 보내면 같은 CP가 두 개 생긴다.
- 성공해도 그 사이 고친 입력(의견·메모)은 지우지 않는다. `onSuccess`가 성공한 `payload`와 지금 입력을 비교한다.
- 409 처리:
  - `VERSION_CONFLICT` → 충돌 창. 「최신 위에 다시 적용」은 서버에서 CP와 미리보기를 새로 읽어 다시 보낸다(캐시를 쓰지 않는다).
  - 보류 코드(`SPLIT_JUDGEMENT_REQUIRED`·`ORDER_NOT_PRESERVED`·`ACTIVE_TASK_BLOCKED`)와 상태 불일치 → 오류 막대(다시 시도 없음) + 최신 다시 읽기. 새 미리보기의 보류 사유가 화면에 보인다.
    - 왜 다시 시도가 없나: 같은 요청을 다시 보내도 또 보류된다. 강제 우회는 없다(D-33~35).

### 3.3 편집 대상은 안정 키로

- 작성 모달의 행은 만들 때 받은 `id`로 고치고 지운다(`form.ts`의 `updateRow`·`removeRow`).
  - 왜: 배열 위치로 고르면 가운데 행을 지운 뒤 다른 행 입력이 엉뚱한 행에 들어간다(앞선 리뷰에서 반복된 결함).
- 이견 조정 메모 초안은 검토 `id`를 키로 모은다(`PlanningPage`의 `memos`).
- 재조정 기록의 펼침 상태는 기록 키(`RP-002`)로 기억한다.

### 3.4 편집 보호와 세션 초안

- `useEditGuard`는 한 화면에 하나만 둔다(React Router의 차단기는 하나만 동작).
  - 변경 제안: 승인 의견 또는 작성 모달 입력이 있으면 다른 CP·메뉴로 가기 전에 묻는다.
  - Planning: 조정 메모 초안이 있으면 탭·세션·메뉴를 옮기기 전에 묻는다.
- 모달 닫기(취소·Esc·×)는 주소 이동이 아니라서 모달이 스스로 같은 문구로 묻는다.
- 초안을 버린 뒤 이동할 때는 화면이 다시 그려진 다음에 이동한다.
  - 왜: 같은 처리 안에서 바로 이동하면 편집 보호가 아직 옛 「편집 중」 값을 보고 한 번 더 묻는다.
- 승인 의견(`cp:<id>:comment`)·작성 모달(`cp:new`)·조정 메모(`planning:<id>:memos`)는 `useSessionDraft`로 세션 만료에 대비한다.

### 3.5 알림 링크의 CP 찾기

- 계약에 CP 한 건을 읽는 API가 없다. 그래서 `/change/<키>`가 최근 목록(200건)에 없으면 status 필터 없이 cursor를 끝까지 넘겨 찾는다(`find.ts`).
- 끝까지 봐도 없을 때만 「찾지 못했습니다」를 보인다.
  - 왜: 오래된 알림의 CP는 첫 쪽에 없을 수 있다(milestones M3-05).

### 3.6 화면 폭(D-28)

- 1280·1920: 페이지 가로 스크롤 없음. 1280에서 Diff 표가 상세 칸(약 740px)에 들어가도록 「대상 Task」 열과 마지막 빈 열만 줄어들 수 있게 했다(1920에서는 원본과 같은 폭).
- 1280 미만: 표(`.gtb`)는 원본처럼 자체 가로 스크롤이다.
- 390px: 알림 링크로 연 CP 상세를 목록보다 먼저 보이고, 긴 「출처」 버튼은 여러 줄로 감싼다(`change.css`).

## 4. 원본과 다른 점(제품 결정·계약 때문)

| 위치 | 원본 | 제품 | 이유 |
|---|---|---|---|
| CP 상태 | 6가지 | `held`(보류) 추가, 주황(수정 요청과 같은 색) | 계약 ProposalStatus |
| CP 초안 | 없음 | `draft`면 「제출 — 승인 요청」 | 팀장·Planning CP는 draft로 만들고 따로 submit(contracts §2.1) |
| 문제(issues) 배너 | 「승인할 수 없습니다」, 승인 버튼 막음 | 「반영할 수 없는 문제가 있습니다」, 승인은 허용 | 계약: issues만 있으면 승인 허용, 반영 때 다시 판정해 held |
| 「제외」 버튼(수정 요청 중) | 있음 | 없음 | 계약에 CP 항목 제외 API가 없다(보고) |
| 작성 모달 미리보기 | 화면이 시뮬레이션 | 형식 검사는 화면, 완료 Task·순환 등은 서버 미리보기 | 판정은 서버. 문제가 있으면 제출하지 않고 초안만 남는다 |
| 세션·CP의 표시 ID(PLN-001) | 세션 ID | 요청 시각 | 계약 Planning에 표시 키가 없다(보고) |
| 재조정 실행 버튼 | 「Planning Agent 재조정 실행 (Mock)」 | 「재조정 실행」 | 실제 `POST /api/replans/run` |
| 세션이 없을 때 | 탭도 숨김 | 탭은 그대로, 세션 탭에 안내 | 재조정 이력은 세션과 무관하게 볼 수 있어야 한다(UAT-EMPTY-02) |
| 판단 결과·D-27 영향 | 없음 | 판단 결과 표, 「선행 관계 제거」「차단 해제」「계속 차단 — 남은 선행」 | D-27·D-33~35 |
| 제목 단계 | h2 → h4 | h2 → h3(h4 모양) | 화면 읽기 프로그램(axe heading-order) |

## 5. 시험

| 명령 | 내용 |
|---|---|
| `W e2e -- planning` | 완료 조건. `planning-change`·`planning-sessions`·`planning-responsive`·`planning-visual` |
| `W test` | `test/change-model`·`find-proposal`·`proposal-form`·`planning-model`·`contract-types` |

- 가짜 API 자료와 상태 저장소는 `e2e/support/planning-data.ts`다. 승인·반영을 계약대로 상태를 바꾸고 `updatedAt`을 올린다.

### 시각 비교

- 조건은 M3-01과 같다(apps/web/README §5). 결과는 `~/.orca/bots/agentwbs/archive/2026-11-26/M3-05/visual/`.
- 실패 기준(≤ 2%): 화면 머리(제목·설명·버튼·탭) — UI-05·UI-05-02·UI-09.
- 기록만: 목록·상세·모달. 글자가 다른 이유는 `summary.md`의 「차이 원인」 열과 위 §4 표에 있다.

## 용어집

| 용어 | 뜻 |
|---|---|
| CP(Change Proposal, 변경 제안) | WBS를 바꾸자는 제안서. 승인과 「WBS 반영」을 거쳐야 WBS가 바뀐다 |
| Diff | 바꾸기 전과 후를 나란히 보여 주는 표 |
| 미리보기(preview) | 실제로 바꾸지 않고 「바꾸면 어떻게 되는지」를 서버가 계산한 결과 |
| previewHash | 미리보기 결과의 지문. 승인·반영 때 보내 「본 결과 그대로인지」 서버가 확인한다 |
| 보류(held) | 반영할 수 없는 사유가 있어 멈춘 CP 상태 |
| 보류 사유(holdReasons) | D-33~35 사유: 판단 기록 없음·판단 불충족·실행 순서 보장 안 됨·진행 중 Task 새 차단 |
| 판단 기록(judgedRules) | Planning(Codex·Claude)이 분할 규칙을 충족했는지 남긴 결론·합의·근거 |
| 영향(impact) | 반영하면 지워지는 선행 관계와, 실제로 풀리는 후속 Task 목록(D-27) |
| SS·FS | 선행 관계 종류. FS는 선행이 끝나야 후속 시작, SS는 선행이 시작하면 후속 시작 |
| 멱등 키(Idempotency-Key) | 같은 요청을 두 번 보내도 한 번만 처리되게 붙이는 번호 |
| cursor | 긴 목록을 쪽으로 나눠 읽을 때 「다음 쪽 위치」 표시 |
| 재조정(replan) | 일정을 다시 계산해 새 기준 버전을 만드는 일. 자동 정책이 꺼져 있으면 「반영 대기」로만 기록된다(D-10) |
