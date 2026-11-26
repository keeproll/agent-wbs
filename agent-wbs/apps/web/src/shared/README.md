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

라우터(`src/app/router.tsx`)는 메뉴 12개를 `MENU.map`으로 한꺼번에 만든다. 그래서 각 작업은 feature 컴포넌트를 내보내기만 하고, 라우터 연결은 병합 때 coordinator가 한다(충돌을 줄이기 위해).
연결할 때는 메뉴를 옮기면 화면을 새로 만들도록 `key`를 메뉴 이름으로 준다.

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
- 파일(PDF·ZIP·Evidence 원본)을 내려받는 요청(`getReportPdf`·`exportProject`·`getEvidenceContent`)은 `call`로 부를 수 없다(타입에서 빠짐).
  - `<a href={apiUrl('getReportPdf', { params: { reportId } })} download>`처럼 주소만 만들어 브라우저가 내려받게 한다.
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
  onSuccess: (result) => { /* 캐시 갱신 후 편집 닫기 */ },
  successNotice: '제목을 저장했습니다.',
  onFieldErrors: setFieldErrors,            // 400의 고칠 항목
  onConflictReload: () => { /* 편집 버리고 최신 다시 읽기 */ },
  // 실패는 catch로 삼키지 말고 그대로 던진다. 창 안에 이유가 보이고, 끝까지 성공해야 창이 닫힌다.
  onConflictReapply: async () => { const latest = await reload(); await saveWith(latest.updatedAt, draft); },
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
    - 결과를 모르는 요청이 남아 있는데 입력을 바꿔 다시 「저장」하면 보내지 않고 안내한다. 「다시 시도」로 끝내거나 오류 막대 「닫기」로 포기한 뒤 새로 저장한다.
  - 400: 오류 막대 + 고칠 항목. 「다시 시도」는 없다. 왜: 같은 잘못된 요청을 다시 보내도 또 실패한다.
  - 409 `VERSION_CONFLICT`: 충돌 창. 「최신 불러오기(내 변경 버림)」와 「최신 위에 다시 적용」 중 고른다. Esc는 아무것도 하지 않고 창만 닫는다(입력 유지). 다시 적용이 실패하면 창 안에 이유를 보인다.
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

## 5. 그 밖의 공통 부품

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

## 6. E2E에서 가짜 API 쓰기

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

## 7. 알아 둘 함정

- 계약의 열거값(`AnyOf`)은 TypeScript에서 글자 그대로의 타입이 아니라 `string | number`로 나온다(@awbs/shared 결함, 보고함).
  - 그래서 `project.state === 'active'`로 타입이 좁혀지지 않는다. 필드 존재(`'name' in project`)로 구분하거나 값을 비교만 한다.
- 화면은 `@awbs/api`·`@awbs/db`를 import할 수 없다(lint가 막는다). 필요한 것은 `@awbs/shared`에 있어야 한다.
- 원본 CSS 파일(`styles/prototype.css`)은 직접 고치지 않는다. 다시 만들면 덮어써진다.
