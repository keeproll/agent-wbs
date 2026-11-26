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
interface SavePayload<D, F> { form: F; updatedAt: string | null; data: D; source: Draft<D, F> }

/**
 * 초안. 규칙은 하나다: **내가 편집한 칸(edited)은 서버 이벤트·자동 갱신·저장 응답이 덮어쓰지 않는다.**
 * - values: 내가 고친 값을 담은 폼 전체. 화면은 서버 최신 값 위에 edited 칸만 values로 덮어 보인다.
 * - edited: 「편집됨」 칸의 경로(키 배열, 예: `['lowPct']`, `['allowed', 'Codex:gpt-6.1-sol']`). 값을 원래대로 되돌려도 편집됨으로 남는다.
 * - baseData: 저장 때 보낼 기준(버전). 서버가 내가 편집한 칸을 건드리지 않고 바뀌면 기준만 새 값으로 옮긴다.
 *   서버가 편집한 칸을 바꿨으면(다른 탭) 기준을 옮기지 않아 저장 때 409 충돌 창으로 알린다.
 */
/**
 * 칸의 경로. 문자열을 점으로 잇지 않고 **키 배열**로 둔다.
 * 왜: 모델 ID(`Codex:gpt-6.1-sol`)처럼 키 안에 점·슬래시·공백이 들어갈 수 있다. 점으로 나누면 한 칸이 여러 칸으로 쪼개져 편집이 반영되지 않는다(재리뷰 8fa1953).
 * JSON으로 그대로 저장·복원되므로 세션 초안에도 안전하다.
 */
export type FieldPath = readonly string[];

interface Draft<D, F> { values: F; edited: FieldPath[]; baseData: D }

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 두 값이 다른 칸의 경로. 객체는 칸마다 내려가고, 목록·글자·숫자는 한 칸으로 본다. */
export function changedPaths(a: unknown, b: unknown, prefix: FieldPath = []): FieldPath[] {
  if (isPlainObject(a) && isPlainObject(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].flatMap((key) => changedPaths(a[key], b[key], [...prefix, key]));
  }
  return same(a, b) ? [] : [prefix];
}

const getPath = (value: unknown, path: FieldPath): unknown =>
  path.reduce<unknown>((v, key) => (isPlainObject(v) && Object.hasOwn(v, key) ? v[key] : undefined), value);

function setPath<T>(target: T, path: FieldPath, leaf: unknown): T {
  if (path.length === 0) return leaf as T;
  const [head, ...rest] = path as [string, ...string[]];
  const obj: Record<string, unknown> = isPlainObject(target) ? target : {};
  return { ...obj, [head]: setPath(obj[head], rest, leaf) } as T;
}

/** 서버 값(server) 위에 편집된 칸만 내 값(values)으로 덮는다. */
export function overlay<F>(server: F, values: F, edited: readonly FieldPath[]): F {
  return edited.reduce((acc, path) => setPath(acc, path, getPath(values, path)), server);
}

/** 한 경로가 다른 경로의 앞부분(같은 칸이거나 상위 칸)인가. 키 단위로 비교한다. */
const isPrefix = (a: FieldPath, b: FieldPath) => a.length <= b.length && a.every((key, i) => key === b[i]);
/** 경로가 겹치는가(같거나 한쪽이 다른 쪽의 상위 칸) */
const overlaps = (a: readonly FieldPath[], b: readonly FieldPath[]) => a.some((x) => b.some((y) => isPrefix(x, y) || isPrefix(y, x)));
/** 같은 경로를 한 번만 남긴다. */
const uniquePaths = (paths: readonly FieldPath[]): FieldPath[] => {
  const seen = new Map<string, FieldPath>();
  for (const path of paths) seen.set(JSON.stringify(path), path);
  return [...seen.values()];
};

/**
 * 「최신 위에 다시 적용」용 합치기. 편집 시작 값(base)과 비교해 **내가 바꾼 칸만** 최신 값(latest)에 얹는다.
 * 객체는 칸마다 따로 보고, 목록(배열)·글자·숫자는 한 덩어리로 본다. 같은 칸을 둘 다 바꿨으면 내 값이 남는다.
 */
export function mergeChanges<T>(base: T, mine: T, latest: T): T {
  return overlay(latest, mine, changedPaths(base, mine));
}

export function useSettingForm<D extends { updatedAt: string | null }, F>(options: SettingFormOptions<D, F>): SettingForm<F, D> {
  const { id, label, query, queryKey, load, toForm, send } = options;
  const queryClient = useQueryClient();
  const [stored, setDraft] = useState<Draft<D, F> | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const base = query.data === undefined ? undefined : toForm(query.data);
  const latestData = query.data;
  /**
   * 서버 값이 새로 읽혔을 때: 내가 편집한 칸을 건드리지 않은 변경이면 기준(버전)만 최신으로 옮긴다.
   * 편집한 칸을 바꾼 변경이면(다른 탭) 옛 기준을 지켜 저장 때 409로 알린다. 매 렌더에 계산한다(따로 상태를 바꾸지 않음).
   */
  const rebase = (d: Draft<D, F>): Draft<D, F> => {
    if (latestData === undefined || d.baseData.updatedAt === latestData.updatedAt) return d;
    return overlaps(changedPaths(toForm(d.baseData), toForm(latestData)), d.edited) ? d : { ...d, baseData: latestData };
  };
  const draft = stored === null ? null : rebase(stored);
  // 화면 값 = 서버 최신 값 위에 「편집됨」 칸만 내 값. 편집하지 않은 칸은 다른 탭·Runner 변경을 그대로 따라간다.
  const form = draft !== null && base !== undefined ? overlay(base, draft.values, draft.edited) : base;
  // 저장할 것이 있는가 = 화면 값이 기준 값과 다르다.
  const dirty = draft !== null && form !== undefined && !same(form, toForm(draft.baseData));

  const report = useContext(DirtyContext);
  useEffect(() => { report(id, dirty); }, [report, id, dirty]);
  useEffect(() => () => { report(id, false); }, [report, id]);

  const apply = (data: D) => { queryClient.setQueryData(queryKey, data); };
  /**
   * 저장이 성공했을 때 초안 정리.
   * - 보낸 뒤 아무것도 더 고치지 않았으면 초안을 닫는다.
   * - 저장을 기다리는 동안 더 고쳤으면(되돌림 포함) 그 「편집됨」 칸은 그대로 두고 기준만 성공 결과로 옮긴다.
   *   예: 20→30 저장 중에 다시 20을 고르면, 서버는 30이 되고 20은 미저장 초안으로 남는다(재리뷰 c7f1bdb·48a7f7a).
   */
  const settle = (source: Draft<D, F>, result: D) => {
    setDraft((current) => {
      if (current === null) return null;
      if (same(current.values, source.values) && same(current.edited, source.edited)) return null;
      return { ...current, baseData: result };
    });
  };
  const { save, busy, conflictModal } = useSave<D, SavePayload<D, F>>({
    target: `${label} 저장`,
    mine: options.describe && draft !== null && form !== undefined ? options.describe(form) : `${label} 변경`,
    // 버전은 기준(baseData)의 것이다. 서버가 내가 편집한 칸을 바꿨으면 기준이 옛 버전이라 409 충돌 창이 뜬다(지적 1).
    request: () => {
      const d = draft ?? { values: base as F, edited: [], baseData: query.data as D };
      const sendForm = overlay(toForm(d.baseData), d.values, d.edited);
      return { form: sendForm, updatedAt: d.baseData.updatedAt, data: d.baseData, source: d };
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
    // 다시 적용은 공통 useSave의 reapplyRequest로 보낸다(M3-04 0dcb8db). 최신 값 위에 「편집됨」 칸만 얹는다(지적 2).
    reapplyRequest: async ({ signal }) => {
      const latest = await load(signal);
      const d = draft ?? { values: base as F, edited: [], baseData: latest };
      return { form: overlay(toForm(latest), d.values, d.edited), updatedAt: latest.updatedAt, data: latest, source: d };
    },
  });

  // 기준 값·편집됨 칸도 함께 보관한다. 복원한 초안을 저장할 때도 그 기준으로 보내 충돌을 알아챈다.
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
        if (query.data === undefined || base === undefined) return current;
        const live = current === null ? null : rebase(current);
        const from = live === null ? base : overlay(base, live.values, live.edited);
        const next = change(from);
        const touched = changedPaths(from, next);
        if (touched.length === 0) return current;
        const edited = uniquePaths([...(live?.edited ?? []), ...touched]);
        return { values: next, edited, baseData: live?.baseData ?? query.data };
      });
    },
    footer,
    restoreOffer,
    checkError,
    busy,
    apply,
  };
}
