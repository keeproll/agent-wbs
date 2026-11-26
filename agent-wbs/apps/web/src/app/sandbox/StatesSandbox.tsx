/**
 * 공통 컴포넌트 견본(/_states) — 개발 서버·E2E 빌드에만 있다(router.tsx).
 * M3 화면을 만드는 사람이 공통 상태를 「어떻게 쓰는지」 보는 살아 있는 예시이고, `W e2e -- states`가 이 화면으로 공통 동작을 검사한다.
 * 실제 계약 요청(getTask·updateTask·runReplan·getTaskHistory)을 쓴다. E2E는 이 요청에 가짜 응답을 준다.
 */
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import type { ApiError } from '../../shared/api/client.ts';
import { apiKey, useApiQuery } from '../../shared/api/queries.ts';
import { MenuScreen } from '../../shared/layout/MenuScreen.tsx';
import { Page } from '../../shared/layout/Page.tsx';
import { useEditGuard } from '../../shared/state/useEditGuard.ts';
import { useSave } from '../../shared/state/useSave.tsx';
import { useSessionDraft } from '../../shared/state/useSessionDraft.tsx';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { EmptyState } from '../../shared/ui/EmptyState.tsx';
import { useConfirm, useDim } from '../../shared/ui/feedback.tsx';
import { AreaLoading } from '../../shared/ui/loading.tsx';
import { TableScroll } from '../../shared/ui/TableScroll.tsx';
import { Modal } from '../../shared/ui/Modal.tsx';

const TASK = 'TASK-0001';

function TitleEditor() {
  const { client } = useApi();
  const queryClient = useQueryClient();
  const task = useApiQuery('getTask', { params: { taskKey: TASK } }, { topics: ['task'] });
  const [draft, setDraft] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<ApiError['fieldErrors']>([]);
  const editing = draft !== null;
  const dirty = editing && draft !== task.data?.title;
  const { guard } = useEditGuard(dirty);
  // 「최신 내용」은 반드시 서버에서 새로 읽는다. queryClient.fetchQuery는 캐시를 돌려줄 수 있어
  // 충돌 뒤 다시 적용이 옛 버전으로 또 충돌하는 일이 있었다(부하 시험에서 재현).
  const reload = async (signal?: AbortSignal) => {
    const latest = await client.call('getTask', { params: { taskKey: TASK }, ...(signal ? { signal } : {}) });
    signal?.throwIfAborted();
    queryClient.setQueryData(apiKey('getTask', { params: { taskKey: TASK } }), latest);
    return latest;
  };

  const saveWith = (updatedAt: string, title: string) => client.call('updateTask', { params: { taskKey: TASK }, body: { updatedAt, title } });
  const { save, busy, conflictModal } = useSave({
    target: `${TASK} 제목 저장`,
    mine: `제목: ${draft ?? ''}`,
    // 저장 버튼을 누른 순간의 내용을 찍어 둔다. 재시도는 이 값을 그대로 보낸다.
    request: () => ({ updatedAt: task.data?.updatedAt ?? '', title: draft ?? '' }),
    run: ({ payload }) => saveWith(payload.updatedAt, payload.title),
    onSuccess: (result, payload) => {
      queryClient.setQueryData(apiKey('getTask', { params: { taskKey: TASK } }), result.task);
      // 성공한 요청과 지금 초안이 같을 때만 편집을 닫는다. 그 사이 더 고쳤으면 초안을 지키고 편집을 이어 간다.
      setDraft((current) => (current === payload.title ? null : current));
    },
    successNotice: `${TASK} 제목을 저장했습니다.`,
    onFieldErrors: setFieldErrors,
    // 최신 불러오기가 끝날 때까지 기다린다. 실패하면 창이 열린 채 이유를 보인다(M3-02 7cddacd를 공통으로).
    // 창을 닫으면 signal이 취소돼 reload가 AbortError를 던지므로 아래 setDraft(null)까지 가지 않는다.
    onConflictReload: async ({ signal }) => { await reload(signal); setDraft(null); },
    // 실패는 삼키지 않고 던진다. useSave가 충돌 창 안에 이유를 보인다.
    onConflictReapply: async () => {
      const latest = await reload();
      const result = await saveWith(latest.updatedAt, draft ?? '');
      queryClient.setQueryData(apiKey('getTask', { params: { taskKey: TASK } }), result.task);
      setDraft(null);
    },
  });
  // 세션이 끊기면 이 초안을 탭 안에 남기고, 다시 로그인하면 복원을 제안한다.
  const { restoreOffer } = useSessionDraft({
    id: `task:${TASK}:title`,
    label: `${TASK} 제목 편집`,
    value: dirty ? { title: draft } : null,
    onRestore: (data) => { setDraft(data.title); },
  });
  const titleError = fieldErrors.find((e) => e.path === 'title' || e.path === '/title');

  return (
    <section className="card" aria-labelledby="sb-edit">
      <h2 id="sb-edit" className="sb-h">저장·오류 막대·충돌 창·편집 보호</h2>
      {restoreOffer}
      {task.isPending && <AreaLoading label="Task 불러오는 중" />}
      {task.data && !editing && (
        <p>
          제목: <b data-testid="title">{task.data.title}</b>{' '}
          <button type="button" className="btn sm" onClick={() => { setDraft(task.data.title); }}>편집</button>
        </p>
      )}
      {editing && (
        <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <label className="fsel-l" htmlFor="sb-title">제목</label>
          <input id="sb-title" className="inp" style={{ width: 360, display: 'block' }} value={draft}
            aria-invalid={titleError ? true : undefined} aria-describedby={titleError ? 'sb-title-err' : undefined}
            onChange={(event) => { setDraft(event.target.value); }} />
          {titleError && <p id="sb-title-err" className="fhint" style={{ color: 'var(--dg)' }}>{titleError.message}</p>}
          <div className="form-acts" style={{ justifyContent: 'flex-start' }}>
            <BusyButton type="submit" busy={busy} busyLabel="저장 중…">저장</BusyButton>
            <button type="button" className="btn" disabled={busy} onClick={() => { void guard(() => { setDraft(null); setFieldErrors([]); }); }}>취소</button>
          </div>
        </form>
      )}
      {conflictModal}
    </section>
  );
}

/** POST 저장의 재시도: 처음 요청 내용과 멱등 키를 그대로 다시 보낸다. */
function MessageDemo() {
  const { client } = useApi();
  const [text, setText] = useState('');
  const [botToken, setBotToken] = useState('');
  const { save, busy } = useSave({
    target: `${TASK} 메시지 초안 만들기`,
    request: () => ({ taskKey: TASK, type: 'instruction', toAgent: 'Claude', body: text }),
    run: ({ payload, idempotencyKey }) => client.call('createMessage', { body: payload as never, idempotencyKey }),
    onSuccess: (_result, payload) => { setText((current) => (current === payload.body ? '' : current)); },
    successNotice: '메시지 초안을 만들었습니다.',
  });
  // botToken은 이름 규칙(token)으로 저장에서 빠진다.
  const { restoreOffer } = useSessionDraft({
    id: 'sandbox:message',
    label: '메시지 초안',
    value: text || botToken ? { body: text, botToken } : null,
    onRestore: (data) => { setText(data.body); },
  });
  return (
    <section className="card" aria-labelledby="sb-msg">
      <h2 id="sb-msg" className="sb-h">POST 재시도(멱등 키)</h2>
      {restoreOffer}
      <label className="fsel-l" htmlFor="sb-msg-in">메시지</label>
      <input id="sb-msg-in" className="inp" style={{ width: 360, display: 'block' }} value={text} onChange={(event) => { setText(event.target.value); }} />
      <label className="fsel-l" htmlFor="sb-msg-token">봇 토큰(비밀값)</label>
      <input id="sb-msg-token" className="inp" type="password" autoComplete="off" style={{ width: 360, display: 'block' }} value={botToken} onChange={(event) => { setBotToken(event.target.value); }} />
      <div className="form-acts" style={{ justifyContent: 'flex-start' }}>
        <BusyButton busy={busy} busyLabel="만드는 중…" onClick={() => { void save(); }}>메시지 초안 만들기</BusyButton>
      </div>
    </section>
  );
}

/** 대상이 바뀌는 화면(예: Task 전환)의 초안 보관. id가 바뀌면 그 대상의 초안만 제안한다. */
function TargetDemo() {
  const [target, setTarget] = useState<'A' | 'B'>('A');
  const [text, setText] = useState('');
  const { restoreOffer } = useSessionDraft({
    id: `sandbox:target:${target}`,
    label: `대상 ${target} 메모`,
    value: text ? { text } : null,
    onRestore: (data) => { setText(data.text); },
  });
  return (
    <section className="card" aria-labelledby="sb-target">
      <h2 id="sb-target" className="sb-h">대상 전환과 초안</h2>
      {restoreOffer}
      <label className="fsel-l" htmlFor="sb-target-sel">대상</label>
      <select id="sb-target-sel" className="inp" value={target} onChange={(event) => { setTarget(event.target.value as 'A' | 'B'); setText(''); }}>
        <option value="A">A</option>
        <option value="B">B</option>
      </select>
      <label className="fsel-l" htmlFor="sb-target-in">대상 메모</label>
      <input id="sb-target-in" className="inp" style={{ width: 360, display: 'block' }} value={text} onChange={(event) => { setText(event.target.value); }} />
    </section>
  );
}

/** 모달 안에서 저장: 실패하면 오류 막대가 모달 위에 떠서 「다시 시도」를 누를 수 있어야 한다(M3-04 보고 6). */
function ModalSaveDemo() {
  const { client } = useApi();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const { save, busy } = useSave({
    target: `${TASK} 제목 저장(창)`,
    request: () => ({ title }),
    run: ({ payload }) => client.call('updateTask', { params: { taskKey: TASK }, body: { updatedAt: 'x', title: payload.title } }),
    onSuccess: (result) => {
      queryClient.setQueryData(apiKey('getTask', { params: { taskKey: TASK } }), result.task);
      setOpen(false);
    },
  });
  return (
    <section className="card" aria-labelledby="sb-modal-save">
      <h2 id="sb-modal-save" className="sb-h">모달 안 저장</h2>
      <button type="button" className="btn sm" onClick={() => { setOpen(true); }}>창에서 제목 저장</button>
      {open && (
        <Modal
          title="창에서 저장"
          role="dialog"
          onCancel={() => { setOpen(false); }}
          footer={(
            <>
              <button type="button" className="btn" onClick={() => { setOpen(false); }}>닫기</button>
              <BusyButton busy={busy} busyLabel="저장 중…" onClick={() => { void save(); }}>창에서 저장</BusyButton>
            </>
          )}
        >
          <label className="fsel-l" htmlFor="sb-modal-title">창 제목</label>
          <input id="sb-modal-title" className="inp" value={title} onChange={(event) => { setTitle(event.target.value); }} />
        </Modal>
      )}
    </section>
  );
}

function RecalcDemo() {
  const { client } = useApi();
  const [running, setRunning] = useState(false);
  useDim(running ? '일정 다시 계산 중 — 잠시 후 갱신됩니다' : null);
  return (
    <section className="card" aria-labelledby="sb-dim">
      <h2 id="sb-dim" className="sb-h">흐림(일정 재계산)</h2>
      <BusyButton busy={running} busyLabel="재계산 중…" onClick={() => {
        setRunning(true);
        void client.call('runReplan', { body: {} as never }).catch(() => undefined).finally(() => { setRunning(false); });
      }}>일정 다시 계산</BusyButton>
    </section>
  );
}

function ListDemo() {
  const confirm = useConfirm();
  const [filtered, setFiltered] = useState(true);
  const [answer, setAnswer] = useState('');
  const columns = ['WBS', 'Task', '유형 · 영역', '담당', '상태 · 검증', '우선순위', '선행 Task', '진행 · 체크리스트', '완료 예상 · 기준 대비', '예상 실행'];
  return (
    <section className="card" aria-labelledby="sb-list">
      <h2 id="sb-list" className="sb-h">빈 상태·표 가로 스크롤·확인창</h2>
      {filtered
        ? <EmptyState kind="filtered" message="조건에 맞는 Task가 없습니다." onReset={() => { setFiltered(false); }} />
        : <EmptyState kind="none" message="아직 실행 기록이 없습니다." hint="Task를 실행하면 여기에 시도 기록이 표시됩니다." />}
      <TableScroll minWidth={960} label="견본 표">
        <div className="trow thead" style={{ gridTemplateColumns: `60px 220px repeat(${String(columns.length - 2)}, minmax(84px,1fr))` }}>
          {columns.map((c) => <span key={c} className="th">{c}</span>)}
        </div>
      </TableScroll>
      <p>
        <button type="button" className="btn sm" onClick={() => {
          void confirm({ title: 'Task 생성 취소', body: '입력한 내용이 저장되지 않습니다. 생성을 취소할까요?', ok: '생성 취소', danger: true })
            .then((ok) => { setAnswer(ok ? '확인' : '취소'); });
        }}>확인창 열기</button>{' '}
        {answer && <span data-testid="confirm-answer">답: {answer}</span>}
      </p>
    </section>
  );
}

export default function StatesSandbox() {
  // 메뉴 화면과 같은 조건에서 시험하도록 MenuScreen 안에 둔다(독립 리뷰 eebac50 #1).
  return (
    <MenuScreen menu="project" title="공통 컴포넌트 견본">
      {() => (
        <Page title="공통 컴포넌트 견본" sub="개발·시험용 화면입니다. 제품 빌드에는 들어가지 않습니다.">
          <TitleEditor />
          <MessageDemo />
          <TargetDemo />
          <ModalSaveDemo />
          <RecalcDemo />
          <ListDemo />
        </Page>
      )}
    </MenuScreen>
  );
}
