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
  /**
   * 저장 요청. form·updatedAt·data만 쓴다(화면 상태를 직접 읽지 않는다).
   * data는 그 요청의 기준 서버 값이다(편집 시작 값, 다시 적용이면 최신 값). 화면에서 고치지 않는 칸은 여기서 채운다.
   */
  send: (form: F, updatedAt: string | null, data: D) => Promise<D>;
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

/** 한 번의 저장 요청 내용. source는 이 저장이 끝나면 닫을 초안이다. */
interface SavePayload<D, F> { form: F; updatedAt: string | null; data: D; source: F }

/** 편집을 시작할 때의 서버 값(baseData)과 그 위에 고친 값(form). 저장은 baseData의 버전으로 보낸다. */
interface Draft<D, F> { form: F; baseData: D }

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * 「최신 위에 다시 적용」용 합치기. 편집 시작 값(base)과 비교해 **내가 바꾼 칸만** 최신 값(latest)에 얹는다.
 * 객체는 칸마다 따로 보고, 목록(배열)·글자·숫자는 한 덩어리로 본다.
 * 예: 내가 낮춤 기준만 20→30으로 바꿨고 그 사이 다른 탭이 알림 횟수를 2→3으로 저장했으면 결과는 낮춤 기준 30·알림 횟수 3이다.
 * 같은 칸을 둘 다 바꿨으면 내 값이 남는다(충돌 창 안내와 같다).
 */
export function mergeChanges<T>(base: T, mine: T, latest: T): T {
  if (isPlainObject(base) && isPlainObject(mine) && isPlainObject(latest)) {
    const keys = new Set([...Object.keys(base), ...Object.keys(mine), ...Object.keys(latest)]);
    return Object.fromEntries([...keys].map((key) => [key, mergeChanges(base[key], mine[key], latest[key])])) as T;
  }
  return same(base, mine) ? latest : mine;
}

export function useSettingForm<D extends { updatedAt: string | null }, F>(options: SettingFormOptions<D, F>): SettingForm<F, D> {
  const { id, label, query, queryKey, load, toForm, send } = options;
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft<D, F> | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const base = query.data === undefined ? undefined : toForm(query.data);
  // 편집 시작 값과 다를 때만 초안이다. 같아지면(직접 되돌림) 서버의 최신 값을 다시 보인다.
  const dirty = draft !== null && !same(draft.form, toForm(draft.baseData));
  const form = dirty ? draft.form : base;

  const report = useContext(DirtyContext);
  useEffect(() => { report(id, dirty); }, [report, id, dirty]);
  useEffect(() => () => { report(id, false); }, [report, id]);

  const apply = (data: D) => { queryClient.setQueryData(queryKey, data); };
  /**
   * 저장이 성공했을 때 초안 정리.
   * - 지금 초안이 이번에 보낸 내용(source)과 같으면 닫는다.
   * - 다르면(저장을 기다리는 동안 더 고쳤으면) 그 초안을 남기고, 기준을 **방금 성공한 결과**로 바꾼다.
   *   예: 20→30 저장 중에 다시 20을 고르면, 서버는 30이 되고 20은 미저장 초안으로 남는다. 다음 저장은 새 버전으로 20을 보낸다.
   *   왜: 기준을 옛 값(20)에 두면 「편집 시작 값과 같음 = 바뀐 것 없음」으로 보여 나중 입력이 화면에서 사라진다(재리뷰 c7f1bdb P2).
   */
  const settle = (source: F, result: D) => {
    setDraft((current) => {
      if (current === null || same(current.form, source)) return null;
      return { form: current.form, baseData: result };
    });
  };
  const { save, busy, conflictModal } = useSave<D, SavePayload<D, F>>({
    target: `${label} 저장`,
    mine: options.describe && dirty ? options.describe(draft.form) : `${label} 변경`,
    // 지적 1(리뷰 624c334): 버전은 지금 화면이 읽은 최신이 아니라 **편집을 시작한 값**의 것이다.
    // 그 사이 다른 곳에서 저장했으면 서버가 409로 알려 충돌 창이 뜬다(조용히 덮어쓰지 않는다).
    request: () => {
      const d = dirty ? draft : { form: base as F, baseData: query.data as D };
      return { form: d.form, updatedAt: d.baseData.updatedAt, data: d.baseData, source: d.form };
    },
    run: ({ payload }) => send(payload.form, payload.updatedAt, payload.data),
    onSuccess: (result, payload) => {
      apply(result);
      settle(payload.source, result);
      void options.afterSave?.();
    },
    successNotice: options.successNotice ?? '설정을 저장했습니다.',
    onConflictReload: async ({ signal }) => {
      const latest = await load(signal);
      if (signal.aborted) return;
      apply(latest);
      setDraft(null);
    },
    // 지적 2: 다시 적용은 공통 useSave의 reapplyRequest로 보낸다(M3-04 0dcb8db).
    // 최신을 읽어 내가 바꾼 칸만 얹은 요청을 만들고, 응답을 잃으면 같은 내용·같은 키로만 다시 보낸다.
    reapplyRequest: async () => {
      const latest = await load();
      const d = dirty ? draft : { form: base as F, baseData: latest };
      const merged = mergeChanges(toForm(d.baseData), d.form, toForm(latest));
      return { form: merged, updatedAt: latest.updatedAt, data: latest, source: d.form };
    },
  });

  // 편집 시작 값도 함께 보관한다. 복원한 초안을 저장할 때도 그 버전으로 보내 충돌을 알아챈다.
  const { restoreOffer } = useSessionDraft<Draft<D, F>>({
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
    edit: (change) => {
      setCheckError(null);
      setDraft((current) => {
        const live = current !== null && !same(current.form, toForm(current.baseData));
        if (live) return { ...current, form: change(current.form) };
        if (query.data === undefined || base === undefined) return current;
        return { form: change(base), baseData: query.data };
      });
    },
    footer,
    restoreOffer,
    checkError,
    busy,
    apply,
  };
}
