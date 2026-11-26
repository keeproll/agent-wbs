/**
 * 저장(변경 요청) 흐름 하나를 처리하는 hook. 모든 M3 화면의 저장 버튼은 이것을 쓴다.
 *
 * 하는 일(G§0.3 오류 처리 규칙):
 * - 처리 중에는 busy=true. BusyButton과 함께 쓰면 「…중」 문구·비활성으로 두 번 누르기를 막는다(UAT-STATE-05).
 * - 처리 중 다시 눌러도 요청을 또 보내지 않는다.
 * - 실패해도 입력은 그대로 둔다(이 hook은 입력을 건드리지 않는다). 성공했을 때만 onSuccess에서 편집을 닫는다.
 * - 500·네트워크·응답 없음·503 → 오류 막대 + 「다시 시도」.
 *   다시 시도는 **처음 보낸 요청 내용(request)과 같은 Idempotency-Key**로 보낸다.
 *   왜: 서버가 첫 요청을 처리하고 응답만 잃었을 수 있다. 같은 키에 다른 내용을 보내면 서버가 IDEMPOTENCY_CONFLICT로 거부한다.
 * - 결과를 모르는 요청이 남아 있는 동안 입력을 바꿔 다시 저장하면 보내지 않고 먼저 해결하라고 안내한다.
 *   「다시 시도」(또는 같은 내용으로 다시 저장)로 끝낸 뒤 새로 저장한다. 오류 막대 「닫기」는 안내만 닫고 이전 요청을 잊지 않는다.
 *   왜: 서버가 이미 처리하고 응답만 잃었을 수 있다. 새 키로 보내면 중복 생성된다.
 * - 성공 콜백은 성공한 요청 내용(payload)을 함께 받는다. 그 사이 고친 초안을 지우지 않게 비교해서 닫는다.
 * - 400 → 오류 막대(다시 시도 없음) + onFieldErrors로 고칠 항목 전달(UAT-STATE-07).
 * - 409 VERSION_CONFLICT → 충돌 창(MOD-01). 다시 적용이 실패하면 창을 닫지 않고 창 안에 이유를 보인다.
 * - 그 밖의 409 → 오류 막대(다시 시도 없음) + onRejected로 최신 다시 읽기.
 * - 성공하면 오류 막대를 닫고 successNotice를 안내(SYS-03)한다.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api/client.ts';
import { ConflictModal } from '../ui/ConflictModal.tsx';
import { canRetry } from '../ui/errors.ts';
import { useErrorBar, useNotice, useStableCallback } from '../ui/feedback.tsx';

export interface SaveContext<P> {
  /** POST 요청에 넘긴다(`client.call(id, { …, idempotencyKey })`). */
  idempotencyKey: string;
  /** 저장 버튼을 누른 순간 request()로 찍어 둔 요청 내용. 재시도 때도 같은 값이다. */
  payload: P;
}

export interface SaveOptions<T, P = undefined> {
  /** 오류 막대의 「대상」. 예: 「Task 제목 저장」 */
  target: string;
  /**
   * 저장 버튼을 누른 순간의 요청 내용을 만든다(입력 상태를 복사). run은 이 값만 써서 요청을 보낸다.
   * 재시도가 화면의 최신 입력이 아니라 처음 요청을 그대로 보내게 하려면 꼭 쓴다.
   */
  request?: () => P;
  /** 요청을 보낸다. ctx.payload와 ctx.idempotencyKey만 쓴다(화면 상태를 직접 읽지 않는다). */
  run: (ctx: SaveContext<P>) => Promise<T>;
  /**
   * 성공했을 때. payload는 이번에 성공한 요청 내용이다.
   * 편집 닫기는 **현재 초안이 payload와 같을 때만** 한다. 다르면(재시도 사이에 사용자가 더 고쳤으면) 서버 값만 갱신하고 초안은 둔다.
   */
  onSuccess?: (result: T, payload: P) => void;
  successNotice?: string;
  /** 오류 막대 제목 앞부분. 기본 「저장하지 못했습니다」 */
  failTitle?: string;
  /** 충돌 창의 「내 변경」 설명 */
  mine?: string;
  /**
   * 충돌 창 「최신 내용 불러오기(내 변경 버림)」: 편집을 버리고 서버 최신을 다시 읽는다.
   * Promise를 돌려주면 끝날 때까지 기다린다. 성공해야 창을 닫고 「불러왔습니다」를 안내한다.
   * 실패하면(ApiError를 던지면) 창을 열어 둔 채 이유를 보인다(M3-02 7cddacd: 조회 실패를 성공으로 숨기지 않기).
   */
  onConflictReload?: () => void | Promise<void>;
  /**
   * 충돌 창 「최신 내용에 내 변경 다시 적용」: 최신 버전을 읽은 뒤 내 변경으로 다시 저장한다.
   * 실패하면 ApiError를 그대로 던진다(삼키지 않는다). 던지면 창이 열린 채 이유를 보이고, 끝까지 성공해야 창이 닫힌다.
   */
  onConflictReapply?: () => Promise<void>;
  onFieldErrors?: (errors: ApiError['fieldErrors']) => void;
  onRejected?: (error: ApiError) => void;
}

export interface SaveHandle {
  save: () => Promise<boolean>;
  busy: boolean;
  /** 충돌 창. 화면 어디든 렌더하면 된다(overlay라 위치 무관). */
  conflictModal: ReactNode;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const UNRESOLVED_MESSAGE = '이전 요청의 결과를 아직 모릅니다. 「다시 시도」로 이전 요청을 먼저 끝낸 뒤 바꾼 내용을 저장하세요.';

export function useSave<T, P = undefined>(options: SaveOptions<T, P>): SaveHandle {
  const errorBar = useErrorBar();
  const notify = useNotice();
  const [owner] = useState(() => Symbol('save'));
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<{ error: ApiError; at: number; failure: ApiError | null; failedAction?: 'reload' | 'reapply' } | null>(null);
  const [reapplying, setReapplying] = useState(false);
  const inFlight = useRef(false);
  /** 결과를 모르는 요청(재시도 가능한 실패). 다시 시도는 이 내용과 키로 보낸다. */
  const unresolved = useRef<{ key: string; payload: P; error: ApiError } | null>(null);
  /** 오류 막대의 「다시 시도」가 attempt를 부르기 위한 참조(선언 순서 때문에 ref로 잇는다) */
  const retryRef = useRef<((key: string, payload: P) => Promise<boolean>) | null>(null);

  const showFailure = useStableCallback((error: ApiError, key: string, payload: P, extra?: string) => {
    const retryable = canRetry(error);
    unresolved.current = retryable ? { key, payload, error } : null;
    errorBar.show({
      owner,
      error,
      target: options.target,
      ...(options.failTitle ? { failTitle: options.failTitle } : {}),
      ...(extra ? { extra } : {}),
      ...(retryable ? { retry: () => { void retryRef.current?.(key, payload); } } : {}),
      // 「닫기」는 안내만 닫는다. 서버가 이미 처리했을 수 있으므로 결과 모르는 요청(키)은 지우지 않는다(재리뷰 c16d765 #2).
    });
  });

  const attempt = useStableCallback(async (key: string, payload: P): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await options.run({ idempotencyKey: key, payload });
      unresolved.current = null;
      errorBar.clear(owner);
      options.onFieldErrors?.([]);
      options.onSuccess?.(result, payload);
      if (options.successNotice) notify(options.successNotice);
      return true;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.kind === 'unauthorized') return false; // 로그인 화면으로 이동한다(ApiProvider).
      if (error.kind === 'conflict') {
        unresolved.current = null;
        errorBar.clear(owner);
        setConflict({ error, at: Date.now(), failure: null });
        return false;
      }
      if (error.kind === 'validation') options.onFieldErrors?.(error.fieldErrors);
      if (error.kind === 'rejected') options.onRejected?.(error);
      showFailure(error, key, payload);
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  });

  useEffect(() => { retryRef.current = attempt; });

  const save = useStableCallback(async () => {
    const payload = (options.request ? options.request() : undefined) as P;
    const pending = unresolved.current;
    if (pending) {
      // 같은 내용이면 이전 요청의 재시도다. 다른 내용이면 이전 결과를 먼저 해결해야 한다.
      if (same(pending.payload, payload)) return attempt(pending.key, pending.payload);
      showFailure(pending.error, pending.key, pending.payload, UNRESOLVED_MESSAGE);
      return false;
    }
    return attempt(crypto.randomUUID(), payload);
  });

  const conflictModal = conflict ? (
    <ConflictModal
      error={conflict.error}
      at={conflict.at}
      failure={conflict.failure}
      failureTitle={conflict.failedAction === 'reload' ? '최신 내용을 불러오지 못했습니다' : '다시 적용하지 못했습니다'}
      mine={options.mine ?? options.target}
      busy={reapplying}
      onClose={() => { setConflict(null); }}
      onReload={() => {
        setReapplying(true);
        void Promise.resolve()
          .then(() => options.onConflictReload?.())
          .then(
            () => {
              setConflict(null);
              notify('최신 내용을 불러왔습니다. 내 변경은 적용되지 않았습니다.');
            },
            (error: unknown) => {
              if (!(error instanceof ApiError)) throw error;
              if (error.kind === 'unauthorized') { setConflict(null); return; }
              setConflict((c) => c && { ...c, failure: error, failedAction: 'reload' });
            },
          )
          .finally(() => { setReapplying(false); });
      }}
      onReapply={() => {
        setReapplying(true);
        void Promise.resolve()
          .then(() => options.onConflictReapply?.())
          .then(
            () => { setConflict(null); },
            (error: unknown) => {
              if (!(error instanceof ApiError)) throw error;
              if (error.kind === 'unauthorized') { setConflict(null); return; }
              // 또 충돌하면 새 충돌 내용으로 바꾸고, 그 밖의 실패는 창 안에 이유를 보인다.
              setConflict((c) => (error.kind === 'conflict' ? { error, at: Date.now(), failure: null } : c && { ...c, failure: error, failedAction: 'reapply' }));
            },
          )
          .finally(() => { setReapplying(false); });
      }}
    />
  ) : null;

  return { save, busy: busy || reapplying, conflictModal };
}
