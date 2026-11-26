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
import { Page } from '../../shared/layout/Page.tsx';
import { useEditGuard } from '../../shared/state/useEditGuard.ts';
import { useSave } from '../../shared/state/useSave.tsx';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { EmptyState } from '../../shared/ui/EmptyState.tsx';
import { useConfirm, useDim } from '../../shared/ui/feedback.tsx';
import { AreaLoading } from '../../shared/ui/loading.tsx';
import { TableScroll } from '../../shared/ui/TableScroll.tsx';

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
  const reload = () => queryClient.fetchQuery({
    queryKey: apiKey('getTask', { params: { taskKey: TASK } }),
    queryFn: () => client.call('getTask', { params: { taskKey: TASK } }),
  });

  const saveWith = (updatedAt: string) => client.call('updateTask', { params: { taskKey: TASK }, body: { updatedAt, title: draft ?? '' } });
  const { save, busy, conflictModal } = useSave({
    target: `${TASK} 제목 저장`,
    mine: `제목: ${draft ?? ''}`,
    run: () => saveWith(task.data?.updatedAt ?? ''),
    onSuccess: (result) => {
      queryClient.setQueryData(apiKey('getTask', { params: { taskKey: TASK } }), result.task);
      setDraft(null);
    },
    successNotice: `${TASK} 제목을 저장했습니다.`,
    onFieldErrors: setFieldErrors,
    onConflictReload: () => { setDraft(null); void reload(); },
    onConflictReapply: async () => {
      const latest = await reload();
      const result = await saveWith(latest.updatedAt).catch(() => null);
      if (result) {
        queryClient.setQueryData(apiKey('getTask', { params: { taskKey: TASK } }), result.task);
        setDraft(null);
      }
    },
  });
  const titleError = fieldErrors.find((e) => e.path === 'title' || e.path === '/title');

  return (
    <section className="card" aria-labelledby="sb-edit">
      <h3 id="sb-edit" style={{ marginTop: 0 }}>저장·오류 막대·충돌 창·편집 보호</h3>
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

function RecalcDemo() {
  const { client } = useApi();
  const [running, setRunning] = useState(false);
  useDim(running ? '일정 다시 계산 중 — 잠시 후 갱신됩니다' : null);
  return (
    <section className="card" aria-labelledby="sb-dim">
      <h3 id="sb-dim" style={{ marginTop: 0 }}>흐림(일정 재계산)</h3>
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
      <h3 id="sb-list" style={{ marginTop: 0 }}>빈 상태·표 가로 스크롤·확인창</h3>
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
  return (
    <Page title="공통 컴포넌트 견본" sub="개발·시험용 화면입니다. 제품 빌드에는 들어가지 않습니다.">
      <TitleEditor />
      <RecalcDemo />
      <ListDemo />
    </Page>
  );
}
