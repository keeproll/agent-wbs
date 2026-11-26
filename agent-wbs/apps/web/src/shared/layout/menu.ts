/**
 * 왼쪽 메뉴 12개 — 원본 NAV(P L3063–3076)의 순서·이름·아이콘 그대로.
 * 주소(path)는 제품이 정했다(G§4.3 `/wbs/TASK-0007`, §4.9 `/settings/report`).
 */
export const MENU = [
  { key: 'dashboard', label: '대시보드', icon: 'M4 4h7v7H4zM13 4h7v4h-7zM13 10h7v10h-7zM4 13h7v7H4z' },
  { key: 'project', label: '프로젝트', icon: 'M3 7h6l2 2h10v10H3z' },
  { key: 'wbs', label: 'WBS', icon: 'M4 5h5M4 5v14M4 12h5M4 19h5M12 5h8M12 12h8M12 19h8' },
  { key: 'design', label: '설계', icon: 'M4 6h16M4 6v12h16V6M9 6v12M4 12h5' },
  { key: 'planning', label: 'Planning', icon: 'M4 4h7v16H4zM13 4h7v16h-7zM6.5 8h2M15.5 8h2M6.5 12h2M15.5 12h2' },
  { key: 'exec', label: '작업 실행', icon: 'M8 5l11 7-11 7z' },
  { key: 'verify', label: '검증', icon: 'M12 3l8 3v6c0 4-3.5 7.5-8 9-4.5-1.5-8-5-8-9V6zM8.5 12l2.5 2.5 4.5-5' },
  { key: 'ci', label: '빌드 · 통합', icon: 'M4 7h16M4 12h10M4 17h7M17 14l3 3-3 3' },
  { key: 'change', label: '변경 제안', icon: 'M4 8h13l-3-3M20 16H7l3 3' },
  { key: 'history', label: '이력', icon: 'M12 8v4l3 2M4.6 9A8 8 0 1 1 4 12M4 4v5h5' },
  { key: 'report', label: '보고서', icon: 'M6 3h9l4 4v14H6zM14 3v5h5M9 12h7M9 16h7M9 8h3' },
  {
    key: 'settings',
    label: '설정',
    icon: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2',
  },
] as const;

export type MenuKey = (typeof MENU)[number]['key'];
export const menuLabel = (key: MenuKey): string => MENU.find((m) => m.key === key)?.label ?? key;

/**
 * 등록·초기 WBS 승인 전에도 열리는 메뉴(G§0.3 「메뉴 잠금」, P L6874–6879, MM-22).
 * 왜 설정도 여나: 실행 PC·동시 실행·정책은 등록 전에 미리 정해 둘 수 있어야 한다.
 */
export const OPEN_BEFORE_ACTIVE: readonly MenuKey[] = ['project', 'settings'];
