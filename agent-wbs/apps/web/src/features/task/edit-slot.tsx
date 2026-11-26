/**
 * 편집 자리 — Task 상세에서 한 번에 한 곳만 편집한다(원본 canEdit = !specEdit && !ov && !ed, P L5229).
 *
 * - open(id): 그 영역을 편집 상태로 연다. 다른 곳이 이미 편집 중이면 열지 않는다.
 * - setDirty(true): 저장하지 않은 입력이 생겼다. 이때 탭·Task·메뉴 이동은 확인창을 띄운다(useEditGuard).
 * - close(): 저장 성공·취소 뒤 편집을 닫는다.
 * 왜 한 곳만: 여러 곳을 동시에 열면 저장 순서에 따라 버전 충돌이 나고, 무엇이 저장됐는지 헷갈린다.
 */
import { createContext, useContext } from 'react';

export interface EditSlot {
  current: string | null;
  dirty: boolean;
  open: (id: string) => void;
  close: () => void;
  setDirty: (dirty: boolean) => void;
  /**
   * 편집기가 지금 초안을 알린다. 로그인이 끊기면(401) 이 초안을 탭 안에 보관했다가 다시 로그인하면 복원을 제안한다
   * (M3-01 useSessionDraft). 편집기는 입력이 바뀔 때마다 부른다.
   */
  report: (draft: unknown) => void;
  /** 복원한 초안. 편집기는 처음 열 때 이 값이 있으면 그것으로 시작한다. */
  restored: unknown;
}

export const EditSlotContext = createContext<EditSlot>({
  current: null, dirty: false, open: () => undefined, close: () => undefined, setDirty: () => undefined, report: () => undefined, restored: null,
});
export const useEditSlot = () => useContext(EditSlotContext);
