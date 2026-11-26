/**
 * 화면 공통 알림 장치 — 앱 틀(Shell)이 한 번 깔아 두고, 각 화면은 hook으로 쓴다.
 *
 * | hook | 보이는 것 | 원본 |
 * |---|---|---|
 * | useTopBar(active) | 헤더 아래 3px 진행 막대 | .topbar(P L593) |
 * | useDim(label) | 본문 흐림 + 오른쪽 위 안내 칩, 클릭 막음 | .main.dim/.dimchip(P L596–597) |
 * | useErrorBar() | 저장 오류 막대 | .errbar(SYS-02) |
 * | useNotice() | 오른쪽 아래 안내(3.6초 뒤 사라짐) | .notice(SYS-03, P L5033) |
 * | useConfirm() | 공용 확인창 | MOD-08 |
 */
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ConfirmModal, type ConfirmOptions } from './ConfirmModal.tsx';
import { ErrorBar, type ErrorBarState } from './ErrorBar.tsx';
import { ICON, Icon } from './Icon.tsx';
import { useDelayedFlag } from './loading.tsx';

export const NOTICE_MS = 3_600;

interface FeedbackValue {
  addTopBar: (delta: 1 | -1) => void;
  setDim: (id: symbol, label: string | null) => void;
  showError: (state: ErrorBarState | null) => void;
  clearError: (owner?: symbol) => void;
  notify: (text: string) => void;
  confirm: (options: ConfirmOptions) => Promise<boolean>;
}

const FeedbackContext = createContext<FeedbackValue | null>(null);
const useFeedback = (): FeedbackValue => {
  const value = use(FeedbackContext);
  if (!value) throw new Error('FeedbackProvider 안에서만 쓸 수 있습니다.');
  return value;
};

interface FeedbackState {
  topBars: number;
  dims: Map<symbol, string>;
  error: ErrorBarState | null;
  notice: { text: string; key: number } | null;
  confirm: { options: ConfirmOptions; resolve: (ok: boolean) => void } | null;
}

export function FeedbackProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<FeedbackState>({ topBars: 0, dims: new Map(), error: null, notice: null, confirm: null });
  const value = useMemo<FeedbackValue>(() => ({
    addTopBar: (delta) => { setState((s) => ({ ...s, topBars: Math.max(0, s.topBars + delta) })); },
    setDim: (id, label) => {
      setState((s) => {
        const dims = new Map(s.dims);
        if (label === null) dims.delete(id); else dims.set(id, label);
        return { ...s, dims };
      });
    },
    showError: (error) => { setState((s) => ({ ...s, error })); },
    clearError: (owner) => { setState((s) => (owner === undefined || s.error?.owner === owner ? { ...s, error: null } : s)); },
    notify: (text) => { setState((s) => ({ ...s, notice: { text, key: (s.notice?.key ?? 0) + 1 } })); },
    confirm: (options) => new Promise<boolean>((resolve) => { setState((s) => ({ ...s, confirm: { options, resolve } })); }),
  }), []);

  useEffect(() => {
    if (!state.notice) return;
    const timer = setTimeout(() => { setState((s) => ({ ...s, notice: null })); }, NOTICE_MS);
    return () => { clearTimeout(timer); };
  }, [state.notice]);

  return (
    <FeedbackContext value={value}>
      <FeedbackStateContext value={state}>{children}</FeedbackStateContext>
      {state.notice && (
        <div className="notice" role="status" key={state.notice.key}>
          <Icon d={ICON.check} small />
          {state.notice.text}
        </div>
      )}
      {state.confirm && (
        <ConfirmModal
          options={state.confirm.options}
          onAnswer={(ok) => {
            state.confirm?.resolve(ok);
            setState((s) => ({ ...s, confirm: null }));
          }}
        />
      )}
    </FeedbackContext>
  );
}

const FeedbackStateContext = createContext<FeedbackState | null>(null);

/** 본문(main) 위쪽에 진행 막대·흐림 칩·오류 막대를 그린다. Shell이 쓴다. */
export function MainFeedback() {
  const state = use(FeedbackStateContext);
  const { clearError } = useFeedback();
  const bar = useDelayedFlag((state?.topBars ?? 0) > 0);
  const dim = state ? [...state.dims.values()][0] : undefined;
  return (
    <>
      {bar && <div className="topbar" role="progressbar" aria-label="불러오는 중"><span /></div>}
      {dim && <div className="dimchip" role="status"><span className="bspin" aria-hidden="true" />{dim}</div>}
      {state?.error && <ErrorBar state={state.error} onClose={() => { state.error?.onClose?.(); clearError(); }} />}
    </>
  );
}

/** 본문을 흐리게 할지(재계산 중). Shell이 `.main.dim` 클래스에 쓴다. */
export function useMainDimmed(): boolean {
  return (use(FeedbackStateContext)?.dims.size ?? 0) > 0;
}

/** 이전 화면을 유지한 채 새 데이터를 기다리는 동안 상단 진행 막대를 켠다. 0.2초 안에 끝나면 보이지 않는다. */
export function useTopBar(active: boolean): void {
  const { addTopBar } = useFeedback();
  useEffect(() => {
    if (!active) return;
    addTopBar(1);
    return () => { addTopBar(-1); };
  }, [active, addTopBar]);
}

/** 일정 재계산처럼 화면 전체 값이 바뀌는 동안 흐리게 하고 클릭을 막는다. label이 null이면 끈다. */
export function useDim(label: string | null): void {
  const { setDim } = useFeedback();
  const [id] = useState(() => Symbol('dim'));
  useEffect(() => {
    setDim(id, label);
    return () => { setDim(id, null); };
  }, [id, label, setDim]);
}

/**
 * 오류 막대를 띄우고 닫는다. owner를 주면 clear(owner)가 자기가 띄운 막대만 닫는다.
 * 왜: 한 화면에서 저장 실패와 자동 갱신 실패가 겹칠 때 서로의 막대를 지우지 않게 한다.
 */
export function useErrorBar(): { show: (state: Omit<ErrorBarState, 'at'> & { at?: number }) => void; clear: (owner?: symbol) => void } {
  const { showError, clearError } = useFeedback();
  return useMemo(() => ({
    show: (state) => { showError({ ...state, at: state.at ?? Date.now() }); },
    clear: (owner) => { clearError(owner); },
  }), [showError, clearError]);
}

export function useNotice(): (text: string) => void {
  return useFeedback().notify;
}

/** 공용 확인창을 열고 사용자의 답(true=확인)을 기다린다. */
export function useConfirm(): (options: ConfirmOptions) => Promise<boolean> {
  return useFeedback().confirm;
}

export const useStableCallback = <A extends unknown[], R>(fn: (...args: A) => R): ((...args: A) => R) => {
  const ref = useRef(fn);
  useEffect(() => { ref.current = fn; });
  return useCallback((...args: A) => ref.current(...args), []);
};
