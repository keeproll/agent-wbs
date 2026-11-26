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
}

export const EditSlotContext = createContext<EditSlot>({ current: null, dirty: false, open: () => undefined, close: () => undefined, setDirty: () => undefined });
export const useEditSlot = () => useContext(EditSlotContext);
