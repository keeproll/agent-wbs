# src/shared — 모든 화면이 함께 쓰는 부품 사용법

M3-02~08 화면을 만들 때 이 문서대로 쓰면 로딩·오류·충돌·잠금·편집 보호가 모든 메뉴에서 똑같이 동작한다.
직접 보고 만져 보려면 `W dev`로 개발 서버를 띄우고 `/_states`(공통 부품 견본)를 연다.
견본 코드는 `src/app/sandbox/StatesSandbox.tsx`이며, 아래 예시의 완성본이다.

> 규칙 하나: shared를 고쳐야 하면 고치기 전에 coordinator에게 알린다.
> 왜: 여러 M3 작업이 동시에 이 폴더를 쓰기 때문에, 한 사람이 바꾸면 다른 화면이 깨질 수 있다.

## 1. 메뉴 화면 만들기 — `MenuScreen` + `Page`

```tsx
// features/wbs/WbsPage.tsx
import { MenuScreen } from '../../shared/layout/MenuScreen.tsx';
import { Page } from '../../shared/layout/Page.tsx';

export function WbsPage() {
  return (
    <MenuScreen menu="wbs">
      {(project) => <Page title="WBS" sub="12 Tasks · …">…</Page>}
    </MenuScreen>
  );
}
```

라우터(`src/app/router.tsx`)는 메뉴 12개를 `MENU`로 한꺼번에 만든다. 메뉴 화면을 연결할 때는 메뉴 화면 표 `SCREENS`에 한 줄을 더한다(M3 통합).
- 상세 주소(`/exec/:taskKey` 등)가 있으면 하위 주소 표 `DETAIL`에도 한 줄을 더한다. 같은 화면·같은 `key`로 그려진다.
- 메뉴를 옮기면 화면을 새로 만들도록 `key`는 메뉴 이름이다. 왜: 같은 컴포넌트를 재사용하면 「재방문 갱신」(상단 진행 막대)이 일어나지 않는다.
- 다른 화면으로 가는 링크 주소는 `shared/links.ts`의 `LINK`로 만든다. 주소를 손으로 쓰지 않는다(apps/web README §2-1).

`MenuScreen`이 대신 해 주는 일:

- 프로젝트 상태(`GET /api/project`)를 먼저 읽는다. 왜: 메뉴 잠금 판정에 필요하다.
- 처음 열 때 0.2초가 지나도 응답이 없으면 그 메뉴 모양의 skeleton을 보인다.
- 실패하면(10초 무응답·503 등) 메뉴 제목 + 오류 카드 + 「다시 시도」를 보인다.
- 등록·초기 WBS 승인 전에는 프로젝트·설정 외 메뉴에 잠금 안내를 보인다.

`Page`는 원본 `.page.scroll` + `.page-h`(제목·설명·오른쪽 버튼) 틀이고, 브라우저 탭 제목도 「<제목> — Agent WBS」로 맞춘다.

## 2. 서버 데이터 읽기 — `useApiQuery`

```tsx
const tasks = useApiQuery('listTasks', { params: { projectId }, query: { status } }, { topics: ['task', 'dependency'] });
```

- 첫 인수는 **요청 이름(operation id)**이다. 경로·방식은 계약(`@awbs/shared/api`)에서 자동으로 찾는다.
  - 왜: 주소를 손으로 쓰면 서버와 어긋나도 모른다. 이름으로 부르면 typecheck가 잡아 준다.
- 인수(`params`·`query`·`body`)와 응답 타입은 계약에서 뽑아낸 타입이다(`api/contract.ts`). 손으로 타입을 다시 적지 않는다.
- `topics`는 이 데이터를 바꾸는 변경 이벤트 종류다(contracts §7).
  - 앱 틀이 3초마다(숨김 30초) `GET /api/changes`를 부르고, 바뀐 topic의 query만 다시 불러온다.
- 조건(필터·정렬)이 바뀌어도 새 응답이 올 때까지 이전 데이터를 그대로 보여 준다. 왜: 화면이 비지 않아 깜빡이지 않는다(G§0.3).
- 실패를 자동으로 되풀이하지 않는다. 사용자가 「다시 시도」를 누른다.
- 화면 안에서 query를 직접 쓰면 첫 로딩은 아래 §4의 부품을 쓴다.
- **이미 보여 준 데이터의 갱신이 실패해도 화면을 오류 카드로 바꾸지 않는다.** 바꾸면 그 안의 편집 중 입력이 사라진다.
  - `useRefreshError(query, '<무엇> 최신 내용 불러오기')`를 붙이면 오류 막대와 「다시 시도」로 알린다(MenuScreen은 이미 쓴다).
  - 오류 화면(`LoadError`)은 처음부터 데이터가 없을 때만 쓴다.
- 쪽으로 나뉜 목록(`{ items, nextCursor }`)을 모두 읽어야 하면 `useAllPages`(`api/allPages.ts`, M3-07이 더함)를 쓴다.
  - 예: `useAllPages('listVerifications', {}, { topics: ['verification'] })` → `data.items`가 모든 쪽을 이은 목록.
  - 왜: 건수·필터를 첫 쪽만 보고 정하면 서버와 어긋난다. 한 번에 200건씩, 같은 cursor가 다시 오면 멈춘다.
- query 밖에서 쪽을 넘겨야 하면(충돌 창의 최신 읽기 등) 같은 파일의 `readAllPages`(모두 읽기)·`findInPages`(찾을 때까지 읽기)를 쓴다.
  - 셋 다 반복 규칙 `eachPage` 하나를 쓴다. 쪽 크기는 `PAGE_LIMIT`(200), 질의는 `pageQuery(cursor)`.
  - 왜 한 곳에: 통합 전에는 화면마다 반복 코드가 4벌 있었고 무한 반복 방지가 서로 달랐다(M3 통합에서 합침).
  - 예: `findInPages((cursor) => client.call('getTaskMessages', { params: { taskKey }, query: pageQuery(cursor), signal }), (m) => m.id === id)`.
- 파일(PDF·ZIP·Evidence 원본)을 내려받는 요청(`getReportPdf`·`exportProject`·`getEvidenceContent`)은 `call`로 부를 수 없다(타입에서 빠짐).
  - `<a href={apiUrl('getReportPdf', { params: { reportId }, query: { view } })} download>`처럼 주소만 만들어 브라우저가 내려받게 한다.
  - 계약의 필수 query는 필수 인수다. PDF는 `view`(`'int'` 내부용 / `'ext'` 외부용)를 화면이 고른 값으로 꼭 넘긴다. 빠지면 typecheck 오류이고 실행해도 예외가 난다.
- `call`은 응답 본문을 다 읽을 때까지 10초 제한을 지킨다. 본문이 깨지거나 끊겨도 `ApiError`(server·network·timeout)로 온다.

## 3. 저장하기 — `useSave` + `BusyButton`

```tsx
const { save, busy, conflictModal } = useSave({
  target: `${taskKey} 제목 저장`,          // 오류 막대의 「대상」
  mine: `제목: ${draft}`,                   // 충돌 창의 「내 변경」
  // ① 저장 버튼을 누른 순간의 요청 내용을 찍어 둔다.
  request: () => ({ updatedAt, title: draft }),
  // ② payload만 써서 보낸다. 화면 상태(draft 등)를 여기서 직접 읽지 않는다.
  run: ({ payload, idempotencyKey }) => client.call('updateTask', { params: { taskKey }, body: payload }),
  // ③ 성공한 요청 내용(payload)과 지금 초안이 같을 때만 편집을 닫는다.
  onSuccess: (result, payload) => { /* 캐시 갱신 */ setDraft((d) => (d === payload.title ? null : d)); },
  successNotice: '제목을 저장했습니다.',
  onFieldErrors: setFieldErrors,            // 400의 고칠 항목
  // 최신 다시 읽기를 await한다. 실패(ApiError)는 그대로 던지면 창이 열린 채 「최신 내용을 불러오지 못했습니다」를 보인다.
  // 창을 닫으면(Esc) signal이 취소된다. 요청에 signal을 넘기면 AbortError로 끝나 아래 setDraft(null)까지 가지 않는다.
  onConflictReload: async ({ signal }) => { await reload(signal); setDraft(null); },
  // 실패는 catch로 삼키지 말고 그대로 던진다. 창 안에 이유가 보이고, 끝까지 성공해야 창이 닫힌다.
  // reload는 client.call로 서버에서 새로 읽는다(queryClient.fetchQuery는 캐시를 돌려줄 수 있어 옛 버전으로 또 충돌한다).
  // (권장) 다시 적용의 요청 내용만 최신 기준으로 만들어 돌려준다. 보내기는 useSave가 run으로 한다.
  reapplyRequest: async ({ signal }) => { const latest = await reload(signal); return { updatedAt: latest.updatedAt, title: draft }; },
  // (예전 방식, 계속 동작) onConflictReapply: async () => { … 직접 보내기 … },  — reapplyRequest가 있으면 쓰지 않는다.
});
…
<BusyButton busy={busy} busyLabel="저장 중…" onClick={() => void save()}>저장</BusyButton>
{conflictModal}
```

`useSave`가 지키는 규칙(G§0.3 「오류 처리 규칙」):

- 처리 중에는 버튼에 스피너와 「…중」을 보이고 비활성으로 만든다. 연타해도 요청은 한 번만 간다.
- 실패해도 입력은 지우지 않는다. 성공했을 때만 `onSuccess`에서 편집을 닫는다.
- 오류 종류별 화면:
  - 500·네트워크 끊김·10초 무응답·503: 오류 막대 + 「다시 시도」.
    - 다시 시도는 **처음 `request()`로 찍은 내용과 같은 멱등 키**로 보낸다. 왜: 서버가 첫 요청을 처리하고 응답만 잃었을 수 있고, 같은 키에 다른 내용을 보내면 서버가 `IDEMPOTENCY_CONFLICT`로 거부한다.
    - 결과를 모르는 요청이 남아 있는데 입력을 바꿔 다시 「저장」하면 보내지 않고 안내한다. 「다시 시도」(또는 같은 내용으로 다시 저장)로 먼저 끝낸 뒤 바꾼 내용을 저장한다.
    - 오류 막대의 「닫기」는 **안내만 닫는다.** 이전 요청과 키는 잊지 않는다. 왜: 서버가 이미 처리하고 응답만 잃었을 수 있어, 새 키로 보내면 같은 것이 두 번 만들어진다.
    - 재시도가 성공해도 그 사이 사용자가 더 고친 초안은 지우지 않는다. 그래서 `onSuccess`는 `payload`와 현재 초안을 비교해서 닫는다(예시 ③).
  - 400: 오류 막대 + 고칠 항목. 「다시 시도」는 없다. 왜: 같은 잘못된 요청을 다시 보내도 또 실패한다.
  - 409 `VERSION_CONFLICT`: 충돌 창. 「최신 불러오기(내 변경 버림)」와 「최신 위에 다시 적용」 중 고른다. Esc는 아무것도 하지 않고 창만 닫는다(입력 유지). 최신 불러오기·다시 적용은 끝까지 성공해야 창이 닫히고, 실패하면 창 안에 이유를 보인다(`onConflictReload`·`onConflictReapply`가 Promise를 돌려주면 기다린다).
    - 최신 불러오기 중에 창을 닫으면(Esc) 그 불러오기는 취소되고 결과를 화면에 적용하지 않는다. 그래서 콜백은 받은 `signal`을 요청에 넘기고, 취소됐으면 편집 닫기 같은 화면 변경을 하지 않는다. 왜: 닫은 뒤 새로 쓴 입력이 늦은 응답에 지워지지 않게 한다.
    - 다시 적용(저장) 중에는 창이 닫히지 않는다. 왜: 이미 보낸 저장은 서버에서 되돌릴 수 없다.
    - **다시 적용은 `reapplyRequest`로 만든다**(M3-04 재리뷰). 주면 다시 적용도 일반 저장과 같은 `run`·`onSuccess`·「결과 미확인 요청」 보관함을 쓴다.
      - M3 통합에서 모든 화면의 다시 적용을 이 규칙으로 맞췄다. 예외는 프로젝트 초기 분석(`features/project/BootView.tsx`)이다. 회차가 바뀌면 자동으로 다시 보내지 않고 새 상태를 보여 팀장이 다시 누르게 한다(M3-04 승인 동작).
      - `reapplyRequest`가 받은 `{ signal }`은 최신 읽기 요청에 넘긴다(M3-04 f542502). 다른 콜백과 같은 규칙이다.
      - 다시 적용의 응답을 잃으면 그 내용과 키를 보관한다. 다음 다시 적용, 오류 막대 「다시 시도」, 일반 저장은 **같은 내용·같은 키로만** 다시 보낸다.
      - 창을 Esc로 닫아도 보관은 남고 오류 막대로 알린다. 그 뒤 내용이 다른 저장은 보내지 않고 「이전 요청의 결과를 아직 모릅니다」를 안내한다.
      - 왜: `onConflictReapply`에서 `client.call`을 직접 부르면 키가 useSave 밖에서 만들어져, 창을 닫은 뒤 일반 저장이 새 키로 같은 일을 또 처리할 수 있다.
    - `onConflictReload`는 서버에서 **실제로 읽은 결과를 await**한다. `invalidateQueries`만 하고 끝내면 실패해도 성공 안내가 뜬다. 입력은 읽기가 성공한 뒤에 버린다.
  - 그 밖의 409: 오류 막대(다시 시도 없음) + `onRejected`. 왜: 「지금 상태와 맞지 않음」이라 최신 상태를 다시 읽어야 한다(contracts §1.1).
- POST 요청에는 `run`이 받은 `idempotencyKey`를 넘긴다(`client.call(id, { …, idempotencyKey })`).
- 변경 요청에는 `X-CSRF-Token`이 자동으로 붙는다.
- `request`를 빼면 `payload`는 `undefined`이고, 다시 시도는 `run`이 읽는 그때의 화면 상태를 보낸다. POST·승인처럼 중복이 위험한 요청에는 꼭 `request`를 쓴다.

## 4. 로딩 5종

| 상황 | 쓰는 것 | 모양(원본) |
|---|---|---|
| 처음 여는 메뉴 | `MenuScreen`이 자동, 직접 쓸 때 `<PageSkeleton menu="wbs" />` | 메뉴 배치 모양 회색(SKELETON, P L3451) |
| 이미 본 화면·필터 변경 | `useTopBar(fetching)` | 헤더 아래 3px 파란 막대 |
| 일정 재계산 | `useDim('일정 다시 계산 중 — 잠시 후 갱신됩니다')`, 끝나면 `useDim(null)` | 본문 흐림 + 오른쪽 위 칩, 클릭 막음 |
| 화면 일부만 다시 읽기 | `<AreaLoading label="문서 불러오는 중" />` | 큰 스피너 + 문구 |
| 저장·승인 버튼 | `<BusyButton busy busyLabel="승인 중…">` | 버튼 안 스피너 + 「…중」 |

- 0.2초 안에 끝나면 아무것도 보이지 않고, 한 번 보인 skeleton은 최소 0.3초 유지한다(`useDelayedFlag`). 왜: 아주 짧은 깜빡임은 거슬린다.
- 화면 전체를 가리는 스피너는 쓰지 않는다.
- 「움직임 줄이기」 설정이면 모든 애니메이션이 멈춘다(product.css).

## 5. 세션 만료 때 초안 지키기 — `useSessionDraft`

편집 중에 로그인이 끊기면(서버가 401을 주면) 화면은 로그인 화면으로 간다. 그때 작성 중이던 초안을 잃지 않게 하는 공통 기능이다(조정자 결정, 2026-11-27).

```tsx
const { restoreOffer } = useSessionDraft({
  id: `task:${taskKey}:spec`,              // 화면·대상마다 다른 이름(같은 이름이면 서로 덮어쓴다)
  label: `${taskKey} 명세 편집`,            // 복원 안내에 보일 이름
  value: dirty ? { goal, scope } : null,    // 저장하지 않은 초안. 없으면 null
  onRestore: (data) => { setDraft(data); }, // 복원을 누르면 편집 상태로 다시 연다
  secretFields: ['smtpPass'],               // 이름 규칙으로 못 거르는 비밀값이 있으면 추가
});
return <section>{restoreOffer}…</section>;
```

동작:

- 초안이 있는 동안(`value`가 null이 아님) 등록해 둔다. 401을 받는 순간 등록된 초안을 이 탭의 sessionStorage에 화면별로 저장한다.
- 다시 로그인하면 원래 주소로 돌아오고, 같은 `id`의 화면이 열리면 「복원 / 버리기」 안내(`restoreOffer`)를 보인다. 어느 쪽을 눌러도 그 `id`의 초안만 지운다.
- `id`가 바뀌면(예: 다른 Task로 이동) 새 `id`의 초안만 제안한다. 이전 대상의 초안은 그 대상으로 돌아왔을 때 다시 제안한다.

초안을 넘기지 않는 경우(원칙: 세션 만료로 끊긴 그 탭·그 화면·그 대상에서만 복원):

- **직접 로그아웃하면 보관 초안을 바로 모두 지운다. 다른 탭 것도 지운다.** 왜: 다음에 로그인하는 사람이 이전 작업자의 저장 안 된 내용을 보면 안 된다. 세션 만료 뒤 다시 로그인한 경우에만 복원을 제안한다.
  - 규칙은 하나다: **마지막 로그아웃 시각보다 먼저(같은 시각 포함) 보관된 초안은 복원하지 않고 버린다.**
  - 로그아웃 시각은 모든 탭이 함께 보는 localStorage(`awbs.logoutAt`)에 남긴다. 그래서 그때 닫혀 있었거나 알림을 못 받은 탭도 다음에 열릴 때 이 규칙으로 지킨다.
  - 열려 있는 다른 탭에는 BroadcastChannel로 바로 알려, 그 탭의 보관 초안과 복원 안내를 즉시 지운다.
  - **로그아웃 뒤에는 새로 보관하지도 않는다.** 로그아웃 알림을 받았거나 이 탭의 마지막 로그인보다 늦은 로그아웃 시각이 기록돼 있으면, 그 탭에서 새 로그인이 성공하기 전까지 어떤 401에서도 초안을 보관하지 않는다.
    - 왜: 로그아웃 뒤에도 화면에 남은 옛 입력이 다음 401에서 「새 기록」으로 다시 저장돼 다음 로그인으로 넘어가는 것을 막는다.
    - 이 탭의 로그인 시각은 로그인 성공 때 sessionStorage(`awbs.loginAt`)에 남긴다. 로그인 기록 없이 연 탭은 페이지를 연 시각을 쓴다.
- **다른 탭으로 복사되지 않는다.** `window.open`으로 연 새 탭은 브라우저가 sessionStorage 사본을 넘겨주지만, 탭마다 다른 탭 id(sessionStorage와 `window.name`에 함께 저장)로 구분해 복사본은 읽지 않고 지운다.
  - 화면에서 새 창을 열 때는 `rel="noopener"`(링크) 또는 `window.open(url, '_blank', 'noopener')`를 쓴다. 왜: 여는 탭의 저장소 사본과 `window.opener` 연결을 넘기지 않기 위해서다.
  - 브라우저 메뉴의 「탭 복제」는 `window.name`까지 복사할 수 있어 같은 탭으로 볼 수 있다. 이것은 막지 못한다.
- 이 제품의 로그인 주체는 팀장 한 명(`principal: lead`)이라 사용자 계정을 구분하지 않는다. 그래서 「다른 사용자」 구분은 로그아웃 삭제로만 지킨다. 저장소가 계정 구분을 보장한다고 설명하지 않는다.

비밀값:

- 필드 이름이 password·pass·secret·token·apiKey·privateKey·credential·otp 꼴이면 깊은 곳까지 빼고 저장한다. 그 밖의 비밀 필드는 `secretFields`에 적는다.
  - 왜: 비밀값은 서버에만 암호화해 두고 화면에서는 쓰기 전용으로 다룬다(G L554, UAT-GITHUB-02).
- 이것은 **필드 이름 규칙**이다. 내용으로 비밀을 알아보지 않는다. 그래서 `value`에는 비밀 필드를 담지 말고 보관할 일반 입력만 골라 넘기는 것이 가장 안전하다.
- 초안은 인증 수단이 아니다. 로그인한 뒤에만 보이고, 복원한 내용도 평소처럼 저장 버튼으로 서버 검사를 거친다.
- 저장소가 막힌 브라우저(사생활 보호 모드 등)에서는 조용히 건너뛴다. 이때는 초안을 지킬 수 없다.

## 6. 그 밖의 공통 부품

| 부품 | 언제 | 비고 |
|---|---|---|
| `useErrorBar().show({ error, target, retry?, owner? })` | `useSave`를 못 쓰는 특별한 실패 | 보통은 `useSave`가 대신 부른다. `owner`를 주면 `clear(owner)`가 자기 막대만 닫는다 |
| `useNotice()('…했습니다.')` | 처리 결과 안내(SYS-03) | 3.6초 뒤 사라짐. 결과를 안내로만 대신하지 않는다 |
| `useConfirm()({ title, body, ok, danger })` | 삭제·취소 같은 확인(MOD-08) | `Promise<boolean>`. 확인 전에는 아무것도 바꾸지 않는다 |
| `useEditGuard(dirty)` | 편집 중 이동 막기 | 메뉴·주소 이동은 자동으로 묻는다. 탭 전환 같은 화면 안 이동은 `guard(() => …)`로 감싼다 |
| `<EmptyState kind="none" message hint />` | 아직 기록 없음 | 무엇이 생기면 여기 보이는지 `hint`로 안내 |
| `<EmptyState kind="filtered" message onReset />` | 조건에 맞는 결과 없음 | 「필터 초기화」 버튼이 붙는다 |
| `<TableScroll minWidth={1000} label="WBS 표">` | 표 | 1280 미만에서 이 상자만 가로 스크롤(D-28). 열을 잘라 숨기지 않는다 |
| `<Modal title footer onCancel size style>` | 새 모달 | 포커스 가두기·Esc·포커스 복원·겹치지 않는 제목 ID를 해 준다. 폭은 원본 모달마다 다르니 `style`로 맞춘다 |
| `<Icon d={ICON.warning} />` | 선 아이콘 | 원본 `.ico`와 같은 18×18. 아이콘 패키지는 쓰지 않는다 |
| `formatDateTime(at)` | 시각 표시 | Asia/Seoul `YYYY-MM-DD HH:mm` |

오류 막대와 모달:

- 모달이 열려 있어도 오류 막대는 overlay 위(쌓임 순서 51, overlay 50과 안내 60 사이)에 뜬다. 원본은 순서를 정하지 않아 overlay 아래에 깔렸다.
- 모달의 Tab 순환에 오류 막대의 「다시 시도」·「닫기」가 들어간다. 그래서 모달 안 저장이 실패해도 마우스·키보드로 다시 시도할 수 있다.

## 7. E2E에서 가짜 API 쓰기

```ts
import { fakeApi, json, hold, delay, errorBody } from './support/fake-api.ts';

const api = await fakeApi(page);                         // 로그인·active 프로젝트·Runner 연결이 기본
api.on('GET /api/tasks/TASK-0001', (route) => json(route, 200, {...}));
api.on('PATCH /api/tasks/TASK-0001', (route) => json(route, 409, errorBody('VERSION_CONFLICT', { details: { changes: [...] } })));
const slow = hold((route) => json(route, 200, {...}));   // 응답을 붙잡아 두기
api.on('GET /api/project', slow.handler); …; slow.release();
```

- 10초 무응답 같은 시간 시험은 `page.clock.install()` 뒤 `page.clock.fastForward(10_000)`으로 빨리 감는다.
- 시험 파일 이름에 메뉴 이름을 넣는다(예: `wbs-filter.spec.ts`). 완료 명령 `W e2e -- wbs`가 파일 이름으로 고르기 때문이다.

## 8. 알아 둘 함정

- 계약의 열거값(`AnyOf`)은 TypeScript에서 글자 그대로의 타입이 아니라 `string | number`로 나온다(@awbs/shared 결함, 보고함).
  - 그래서 `project.state === 'active'`로 타입이 좁혀지지 않는다. 필드 존재(`'name' in project`)로 구분하거나 값을 비교만 한다.
- 계약에서 `.map`으로 만든 요청(CP의 submit·reject·request-changes·approve·apply)은 한 정의의 이름이 여러 개다.
  - 예전 `OperationOf`는 이런 요청을 never로 만들어 `client.call('approveProposal', …)`이 typecheck에서 막혔다. M3-05에서 고쳤고 `test/contract-types.test.ts`가 지킨다.
- 화면은 `@awbs/api`·`@awbs/db`를 import할 수 없다(lint가 막는다). 필요한 것은 `@awbs/shared`에 있어야 한다.
- 원본 CSS 파일(`styles/prototype.css`)은 직접 고치지 않는다. 다시 만들면 덮어써진다.
