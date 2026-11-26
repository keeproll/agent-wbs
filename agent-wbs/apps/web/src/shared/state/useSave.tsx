/**
 * 저장(변경 요청) 흐름 하나를 처리하는 hook. 모든 M3 화면의 저장 버튼은 이것을 쓴다.
 *
 * 하는 일(G§0.3 오류 처리 규칙):
 * - 처리 중에는 busy=true. BusyButton과 함께 쓰면 「…중」 문구·비활성으로 두 번 누르기를 막는다(UAT-STATE-05).
 * - 처리 중 다시 눌러도 요청을 또 보내지 않는다.
 * - 실패해도 입력은 그대로 둔다(이 hook은 입력을 건드리지 않는다). 성공했을 때만 onSuccess에서 편집을 닫는다.
 * - 500·네트워크·응답 없음·503 → 오류 막대 + 「다시 시도」. 다시 시도는 같은 Idempotency-Key로 보낸다.
 * - 400 → 오류 막대(다시 시도 없음) + onFieldErrors로 고칠 항목 전달(UAT-STATE-07).
 * - 409 VERSION_CONFLICT → 충돌 창(MOD-01). 그 밖의 409 → 오류 막대(다시 시도 없음) + onRejected로 최신 다시 읽기.
 * - 성공하면 오류 막대를 닫고 successNotice를 안내(SYS-03)한다.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api/client.ts';
import { ConflictModal } from '../ui/ConflictModal.tsx';
import { canRetry } from '../ui/errors.ts';
import { useErrorBar, useNotice, useStableCallback } from '../ui/feedback.tsx';

export interface SaveOptions<T> {
  /** 오류 막대의 「대상」. 예: 「Task 제목 저장」 */
  target: string;
  /** 요청을 보낸다. 받은 idempotencyKey를 POST 요청에 넘기면 재시도가 중복 처리되지 않는다. */
  run: (ctx: { idempotencyKey: string }) => Promise<T>;
  onSuccess?: (result: T) => void;
  successNotice?: string;
  /** 오류 막대 제목 앞부분. 기본 「저장하지 못했습니다」 */
  failTitle?: string;
  /** 충돌 창의 「내 변경」 설명 */
  mine?: string;
  /** 충돌 창 「최신 내용 불러오기(내 변경 버림)」: 편집을 버리고 서버 최신을 다시 읽는다. */
  onConflictReload?: () => void;
  /** 충돌 창 「최신 내용에 내 변경 다시 적용」: 최신 버전을 읽은 뒤 내 변경으로 다시 저장한다. */
  onConflictReapply?: () => Promise<void> | void;
  onFieldErrors?: (errors: ApiError['fieldErrors']) => void;
  onRejected?: (error: ApiError) => void;
}

export interface SaveHandle {
  save: () => Promise<boolean>;
  busy: boolean;
  /** 충돌 창. 화면 어디든 렌더하면 된다(overlay라 위치 무관). */
  conflictModal: ReactNode;
}

export function useSave<T>(options: SaveOptions<T>): SaveHandle {
  const errorBar = useErrorBar();
  const notify = useNotice();
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<{ error: ApiError; at: number } | null>(null);
  const [reapplying, setReapplying] = useState(false);
  const inFlight = useRef(false);
  /** 오류 막대의 「다시 시도」가 같은 키로 attempt를 다시 부르기 위한 자기 참조 */
  const self = useRef<((key: string) => Promise<boolean>) | null>(null);

  const attempt = useStableCallback(async (key: string): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await options.run({ idempotencyKey: key });
      errorBar.clear();
      options.onFieldErrors?.([]);
      options.onSuccess?.(result);
      if (options.successNotice) notify(options.successNotice);
      return true;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      if (error.kind === 'unauthorized') return false; // 로그인 화면으로 이동한다(ApiProvider).
      if (error.kind === 'conflict') {
        errorBar.clear();
        setConflict({ error, at: Date.now() });
        return false;
      }
      if (error.kind === 'validation') options.onFieldErrors?.(error.fieldErrors);
      if (error.kind === 'rejected') options.onRejected?.(error);
      errorBar.show({
        error,
        target: options.target,
        ...(options.failTitle ? { failTitle: options.failTitle } : {}),
        ...(canRetry(error) ? { retry: () => { void self.current?.(key); } } : {}),
      });
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  });

  useEffect(() => { self.current = attempt; });
  const save = useStableCallback(() => attempt(crypto.randomUUID()));

  const conflictModal = conflict ? (
    <ConflictModal
      error={conflict.error}
      at={conflict.at}
      mine={options.mine ?? options.target}
      busy={reapplying}
      onClose={() => { setConflict(null); }}
      onReload={() => {
        setConflict(null);
        options.onConflictReload?.();
        notify('최신 내용을 불러왔습니다. 내 변경은 적용되지 않았습니다.');
      }}
      onReapply={() => {
        setReapplying(true);
        void Promise.resolve(options.onConflictReapply?.()).finally(() => {
          setReapplying(false);
          setConflict(null);
        });
      }}
    />
  ) : null;

  return { save, busy: busy || reapplying, conflictModal };
}
