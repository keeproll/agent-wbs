/**
 * 편집 보호 — 저장하지 않은 입력이 있을 때 다른 화면·Task·탭으로 가기 전에 묻는다(MOD-08, UAT-STATE-09).
 *
 * - 주소가 바뀌는 이동(메뉴, 다른 Task, 뒤로 가기)은 React Router의 useBlocker로 막고 확인창을 연다.
 * - 주소가 바뀌지 않는 화면 안 이동(탭 전환 등)은 돌려받은 `guard(action)`으로 감싼다.
 * - 새로고침·창 닫기는 브라우저 기본 확인창(beforeunload)을 띄운다.
 * - 「취소」는 입력과 현재 화면을 그대로 둔다. 「저장하지 않고 이동」만 이동한다.
 * 문구는 원본 guard(P L5054) 그대로.
 */
import { createContext, useContext, useEffect } from 'react';
import { flushSync } from 'react-dom';
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

/**
 * 한 화면 안의 편집 보호를 하나로 모으는 자리(M3 통합, 교차 리뷰 지적 1).
 * React Router의 이동 막기(useBlocker)는 한 번에 하나만 동작한다. 화면 안 부품이 저마다 걸면 뒤에 건 보호기가 앞의 것을 가린다.
 * 예: WBS 화면의 「Task 생성」 창 보호기와 Task 상세의 편집 보호기가 겹치면, 입력 없는 상세 쪽이 이겨 생성 창 입력이 뒤로 가기에 사라졌다.
 * 그래서 화면(부모)이 useEditGuard를 하나만 걸고, 안쪽 부품은 이 자리로 「입력 중」만 알린다.
 */
export const EditGuardHost = createContext<((dirty: boolean) => void) | null>(null);

/**
 * 부모 화면의 편집 보호에 「입력 중」을 알리는 편집 보호. 화면 안 이동(탭 전환 등)을 감싸는 guard는 그대로 준다.
 * 주소 이동 막기와 새로고침 경고는 부모의 useEditGuard가 한다. 부모(EditGuardHost)가 없으면 그 두 가지가 없으니 부모 안에서만 쓴다.
 */
export function useHostedEditGuard(dirty: boolean): { guard: (action: () => void) => Promise<void> } {
  const report = useContext(EditGuardHost);
  const confirm = useConfirm();
  useEffect(() => { report?.(dirty); }, [report, dirty]);
  // 부품이 사라지면(다른 Task로 옮김 등) 부모에게 「입력 없음」을 알린다.
  useEffect(() => () => { report?.(false); }, [report]);
  const guard = useStableCallback(async (action: () => void) => {
    if (dirty && !await confirm(DISCARD_CONFIRM)) return;
    // 버리기로 했으면 부모 보호기를 먼저(동기로) 풀어, 이어지는 주소 변경(탭 ?tab= 등)이 다시 막히지 않게 한다.
    if (dirty) flushSync(() => { report?.(false); });
    action();
  });
  return { guard };
}
