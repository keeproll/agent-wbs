# 보고서 화면 (M6-01, UI-11)

보고서 화면은 서버가 저장한 **스냅샷**(어느 순간의 데이터를 그대로 찍어 둔 것)을 보여 준다.
열 때 다시 계산하지 않는다(G L373).
왜: 일정이 자동으로 다시 짜이기 때문에, 다시 계산하면 「그때 무엇을 예상했는지」가 사라진다.

## 파일

- `ReportPage.tsx` — 화면. 원본 P L2089–2249의 마크업과 클래스(`rp-*`, `rpt-*`)를 그대로 썼다.
  - 왜: 원본 CSS(`shared/styles/prototype.css`)가 같은 클래스를 그리므로 원본과 같은 모습이 된다.
- `model.ts` — 화면 없는 계산(목록 행·기간 검사·단축 기간·팀장용 문구). 원본 rpVM(P L6371)을 옮겼다.
- `report.css` — 좁은 화면(390px)에서 목록이 화면 밖으로 넘치던 것만 고친 보정.

## 주소

- `/report` — 가장 최근 보고서를 연다.
- `/report/<보고서 id>` — 그 보고서를 연다. 메일 발송 기록의 「보고서」 링크가 이 주소를 쓴다(M6-03).
- `?kind=daily|weekly|custom` — 목록 필터. `?view=int|ext` — 팀장용(상세)·보고용(요약) 보기.
  - 일간은 팀장용만 있다(원본 그대로).

## 같은 숫자를 지키는 방법

- 팀장용 핵심 지표와 보고용 문장은 `@awbs/shared`의 `internalKpis`·`externalView` 하나로 만든다.
- 메일(M6-03)과 PDF(M6-02)도 같은 함수를 쓰면 화면·메일·PDF의 숫자와 문장이 같아진다.
- 보고용에는 내부 용어(Task ID, 실행 시도, 모델·Effort, 토큰, RP 번호)를 쓰지 않는다(G L396).
  - `internalTerms(글)`로 검사한다. 시험(`test/report-model.test.ts`, `e2e/api-report.spec.ts`)이 0건을 확인한다.

## 아직 다른 작업이 붙일 것

- 「PDF 다운로드」 버튼은 `GET /api/reports/:id/pdf`(M6-02)를 연다. M6-02 전에는 서버에 경로가 없다.
- 「메일 미리보기」·「메일로 보내기」·발송 기록 펼침은 M6-03이 붙인다.

## 시험

- 모델: `pnpm test -- apps/web/test/report-model`
- 실제 API 화면: `pnpm --filter @awbs/web e2e:api:report` (전용 DB 컨테이너를 만들고 끝나면 지운다)
