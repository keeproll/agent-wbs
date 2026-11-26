/**
 * 메뉴별 skeleton 모양 — 원본 SKELETON(P L3451–3471)을 그대로 옮겼다.
 * 행(row) = CSS grid, 칸(cell) = 세로로 쌓인 회색 블록. 실제 화면 배치와 같은 모양이라 데이터가 와도 화면이 튀지 않는다.
 */
import type { CSSProperties } from 'react';
import type { MenuKey } from '../layout/menu.ts';

export interface SkBlock { style: CSSProperties }
export interface SkCell { card: boolean; blocks: SkBlock[] }
export interface SkRow { columns: string; cells: SkCell[] }

const B = (width: string, height: number, extra: CSSProperties = {}): SkBlock => ({ style: { width, height: `${String(height)}px`, ...extra } });
const C = (blocks: SkBlock[], card = false): SkCell => ({ card, blocks });
const R = (columns: string, cells: SkCell[]): SkRow => ({ columns, cells });
const times = <T,>(n: number, f: (i: number) => T) => Array.from({ length: n }, (_, i) => f(i));

const HEAD = R('1fr', [C([B('220px', 26), B('min(520px,80%)', 13)])]);
const LIST = (n: number) => C(times(n, () => B('100%', 46)));
const DOC = () => C([B('45%', 22), B('30%', 13), B('100%', 70), B('100%', 130), B('100%', 96), B('80%', 13)], true);
const TABLE = (rows: number, h = 30) => C([B('100%', 34), ...times(rows, () => B('100%', h))]);

export const SKELETON: Record<MenuKey, SkRow[]> = {
  wbs: [
    HEAD,
    R('1fr', [C([B('100%', 40)])]),
    R('minmax(0,1fr) min(520px,38%)', [
      C([B('100%', 34), ...times(11, (i) => B(`${String(96 - (i % 3) * 5)}%`, 30, { marginLeft: `${String((i % 3) * 18)}px` }))]),
      C([B('70%', 22), B('40%', 13), B('100%', 36), B('100%', 120), B('100%', 90), B('100%', 90)], true),
    ]),
  ],
  dashboard: [
    HEAD,
    R('repeat(4,minmax(0,1fr))', times(4, () => C([B('45%', 12), B('65%', 26), B('85%', 12)], true))),
    R('repeat(3,minmax(0,1fr))', times(6, () => C([B('40%', 14), B('100%', 12), B('100%', 12), B('90%', 12), B('70%', 12)], true))),
    R('1fr', [C([B('25%', 14), B('100%', 150)], true)]),
  ],
  planning: [HEAD, R('1fr', [C([B('260px', 32)])]), R('300px minmax(0,1fr)', [LIST(6), DOC()])],
  change: [HEAD, R('300px minmax(0,1fr)', [LIST(7), DOC()])],
  ci: [HEAD, R('1fr', [TABLE(10)])],
  design: [HEAD, R('1fr', [C([B('520px', 32)])]), R('1fr', [TABLE(10)])],
  verify: [HEAD, R('1fr', [C([B('360px', 32)])]), R('minmax(0,1fr) 420px', [TABLE(8), DOC()])],
  exec: [
    HEAD,
    R('280px minmax(0,1fr) 340px', [LIST(7), DOC(), C([B('50%', 16), B('100%', 60), B('100%', 60), B('100%', 60), B('100%', 60)], true)]),
  ],
  history: [HEAD, R('1fr', [C([B('100%', 40)])]), R('1fr', [C([B('100%', 32), ...times(12, () => B('100%', 28))])])],
  report: [
    HEAD,
    R('1fr', [C([B('100%', 52)], true)]),
    R('340px minmax(0,1fr)', [
      C([B('100%', 34), ...times(7, () => B('100%', 52))]),
      C([B('20%', 12), B('55%', 26), B('45%', 12), B('100%', 72), B('25%', 16), B('100%', 14), B('100%', 14), B('92%', 14), B('100%', 14), B('80%', 14)], true),
    ]),
  ],
  project: [
    HEAD,
    R('1fr', [C([B('25%', 16), B('100%', 28), B('100%', 28), B('100%', 60)], true)]),
    R('minmax(0,1.3fr) minmax(0,1fr)', [
      C([B('30%', 16), B('100%', 24), B('100%', 24), B('100%', 24), B('100%', 24)], true),
      C([B('40%', 16), B('100%', 90), B('100%', 50)], true),
    ]),
  ],
  settings: [
    HEAD,
    ...times(3, () => R('minmax(0,1fr) minmax(0,1fr)', [
      C([B('35%', 16), B('100%', 30), B('100%', 30), B('100%', 30), B('70%', 30)], true),
      C([B('35%', 16), B('100%', 30), B('100%', 30), B('100%', 60)], true),
    ])),
  ],
};
