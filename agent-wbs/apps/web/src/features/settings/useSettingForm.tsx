/**
 * 설정 카드 하나의 편집 흐름(조회 → 초안 → 저장). 모든 설정 카드가 이 hook 하나로 같은 규칙을 따른다.
 *
 * - 선택지(seg 버튼)를 누르면 바로 저장하지 않고 초안만 바꾼다. 카드 아래에 「변경 취소 / 저장」이 나타난다.
 *   왜: 저장 실패·충돌·세션 만료 때 입력을 지키고(useSave·useSessionDraft), 저장 전 이동을 막으려면(편집 보호) 초안이 있어야 한다.
 *   원본은 누르는 즉시 저장했다(P L6655 put). 화면 모양은 같고, 바뀐 것이 있을 때만 저장 줄이 보인다(README 「원본과 다른 점」).
 * - 저장은 GET이 준 `updatedAt`을 함께 보낸다(contracts §1.3). 다른 곳에서 먼저 바꿨으면 409 충돌 창이 뜬다.
 * - 편집 대상은 카드의 안정 키(`id`, 예: `exec-policy`)로 정한다. 목록 항목은 배열 위치가 아니라 항목 자신의 키(모델 ID, 날짜 등)로 고친다.
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type { ApiError } from '../../shared/api/client.ts';
import { useSave } from '../../shared/state/useSave.tsx';
import { useSessionDraft } from '../../shared/state/useSessionDraft.tsx';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** 설정 화면 전체에서 「저장하지 않은 카드가 있는가」를 모은다. 편집 보호(useEditGuard)는 화면에 하나만 둔다. */
export const DirtyContext = createContext<(id: string, dirty: boolean) => void>(() => undefined);

export function useDirtyRegistry(): { anyDirty: boolean; report: (id: string, dirty: boolean) => void } {
  const [dirty, setDirty] = useState<ReadonlySet<string>>(new Set());
  const [report] = useState(() => (id: string, value: boolean) => {
    setDirty((current) => {
      if (current.has(id) === value) return current;
      const next = new Set(current);
      if (value) next.add(id); else next.delete(id);
      return next;
    });
  });
  return { anyDirty: dirty.size > 0, report };
}

export interface SettingFormOptions<D extends { updatedAt: string | null }, F> {
  /** 카드의 안정 키. 초안 보관 이름(`settings:<id>`)에도 쓴다. */
  id: string;
  /** 오류 막대·복원 안내에 보일 이름. 예: 「실행 정책」 */
  label: string;
  query: UseQueryResult<D, ApiError>;
  queryKey: readonly unknown[];
  /** 서버에서 새로 읽는다(충돌 창용). 캐시를 쓰지 않는다. */
  load: (signal?: AbortSignal) => Promise<D>;
  toForm: (data: D) => F;
  /** 저장 요청. form과 그때의 updatedAt만 쓴다. */
  send: (form: F, updatedAt: string | null) => Promise<D>;
  /** 저장 전에 화면에서 거르는 규칙. 문구를 돌려주면 보내지 않고 그 문구를 보인다. */
  check?: (form: F) => string | null;
  /** 저장 성공 뒤 할 일(예: 일정 다시 읽기) */
  afterSave?: () => void | Promise<void>;
  successNotice?: string;
  /** 충돌 창 「내 변경」 */
  describe?: (form: F) => string;
}

export interface SettingForm<F, D = unknown> {
  /** 화면에 보일 값(초안이 있으면 초안, 없으면 서버 값). 아직 못 읽었으면 undefined */
  form: F | undefined;
  dirty: boolean;
  /** 초안 바꾸기. 서버 값 위에 덧씌운다. */
  edit: (change: (current: F) => F) => void;
  /** 저장 줄(바뀐 것이 있거나 저장 중일 때만 보인다) + 충돌 창 + 복원 안내 */
  footer: ReactNode;
  restoreOffer: ReactNode;
  checkError: string | null;
  busy: boolean;
  /** 다른 저장(예: 토큰 저장)이 돌려준 최신 값을 화면에 넣는다. */
  apply: (data: D) => void;
}

export function useSettingForm<D extends { updatedAt: string | null }, F>(options: SettingFormOptions<D, F>): SettingForm<F, D> {
  const { id, label, query, queryKey, load, toForm, send } = options;
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<F | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const base = query.data === undefined ? undefined : toForm(query.data);
  const form = draft ?? base;
  const dirty = draft !== null && base !== undefined && !same(draft, base);

  const report = useContext(DirtyContext);
  useEffect(() => { report(id, dirty); }, [report, id, dirty]);
  useEffect(() => () => { report(id, false); }, [report, id]);

  const apply = (data: D) => { queryClient.setQueryData(queryKey, data); };
  const { save, busy, conflictModal } = useSave<D, { form: F; updatedAt: string | null }>({
    target: `${label} 저장`,
    mine: options.describe && draft ? options.describe(draft) : `${label} 변경`,
    request: () => ({ form: draft ?? (base as F), updatedAt: query.data?.updatedAt ?? null }),
    run: ({ payload }) => send(payload.form, payload.updatedAt),
    onSuccess: (result, payload) => {
      apply(result);
      setDraft((current) => (current !== null && same(current, payload.form) ? null : current));
      void options.afterSave?.();
    },
    successNotice: options.successNotice ?? '설정을 저장했습니다.',
    onConflictReload: async ({ signal }) => {
      const latest = await load(signal);
      if (signal.aborted) return;
      apply(latest);
      setDraft(null);
    },
    onConflictReapply: async () => {
      const latest = await load();
      const mine = draft ?? (base as F);
      const result = await send(mine, latest.updatedAt);
      apply(result);
      setDraft((current) => (current !== null && same(current, mine) ? null : current));
      void options.afterSave?.();
    },
  });

  const { restoreOffer } = useSessionDraft<F>({
    id: `settings:${id}`,
    label: `설정 — ${label}`,
    value: dirty ? draft : null,
    onRestore: (data) => { setDraft(data); },
  });

  const submit = () => {
    if (!form) return;
    const problem = options.check?.(form) ?? null;
    setCheckError(problem);
    if (problem) return;
    void save();
  };

  const footer = (
    <>
      {(dirty || busy) && (
        <div className="form-acts" style={{ marginTop: 10 }}>
          <span className="fhint" style={{ marginRight: 'auto' }}>저장하지 않은 변경이 있습니다.</span>
          <button type="button" className="btn ghost sm" disabled={busy} onClick={() => { setDraft(null); setCheckError(null); }}>변경 취소</button>
          <BusyButton small busy={busy} busyLabel="저장 중…" onClick={submit}>저장</BusyButton>
        </div>
      )}
      {checkError && <p className="ferr" role="alert" style={{ margin: '6px 0 0' }}>{checkError}</p>}
      {conflictModal}
    </>
  );

  return {
    form,
    dirty,
    edit: (change) => { setCheckError(null); setDraft((current) => { const from = current ?? base; return from === undefined ? current : change(from); }); },
    footer,
    restoreOffer,
    checkError,
    busy,
    apply,
  };
}
