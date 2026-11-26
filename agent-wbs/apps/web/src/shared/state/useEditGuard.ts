/**
 * 편집 보호 — 저장하지 않은 입력이 있을 때 다른 화면·Task·탭으로 가기 전에 묻는다(MOD-08, UAT-STATE-09).
 *
 * - 주소가 바뀌는 이동(메뉴, 다른 Task, 뒤로 가기)은 React Router의 useBlocker로 막고 확인창을 연다.
 * - 주소가 바뀌지 않는 화면 안 이동(탭 전환 등)은 돌려받은 `guard(action)`으로 감싼다.
 * - 새로고침·창 닫기는 브라우저 기본 확인창(beforeunload)을 띄운다.
 * - 「취소」는 입력과 현재 화면을 그대로 둔다. 「저장하지 않고 이동」만 이동한다.
 * 문구는 원본 guard(P L5054) 그대로.
 */
import { useEffect } from 'react';
import { useBlocker } from 'react-router';
import { useConfirm, useStableCallback } from '../ui/feedback.tsx';

export const DISCARD_CONFIRM = {
  title: '편집 내용 버리기',
  body: '저장하지 않은 편집 내용이 있습니다. 저장하지 않고 이동할까요?',
  ok: '저장하지 않고 이동',
  danger: true,
} as const;

export function useEditGuard(dirty: boolean): { guard: (action: () => void) => Promise<void> } {
  const confirm = useConfirm();
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    dirty && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search));

  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    void confirm(DISCARD_CONFIRM).then((ok) => { if (ok) blocker.proceed(); else blocker.reset(); });
  }, [blocker, confirm]);

  useEffect(() => {
    if (!dirty) return;
    const onUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    addEventListener('beforeunload', onUnload);
    return () => { removeEventListener('beforeunload', onUnload); };
  }, [dirty]);

  const guard = useStableCallback(async (action: () => void) => {
    if (!dirty || await confirm(DISCARD_CONFIRM)) action();
  });
  return { guard };
}
