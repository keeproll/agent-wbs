import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

interface ProtoGrade { model: string; effort: string }
export interface ProtoSel {
  floorN(d: unknown, t: unknown, role: string): { n: number };
  escalate(d: unknown, ag: string, r: ProtoGrade): ProtoGrade & { top: boolean };
  lower(d: unknown, t: unknown, role: string, ag: string, r: ProtoGrade): ProtoGrade | null;
  recCap(d: unknown): { total: number; heavy: number; Claude: number; Codex: number; warn: string[] };
  subHold(d: unknown, a: unknown): number;
  conc(d: unknown): { lim: number; width: number; factor: string };
}

/** 프로토타입 `Sel`의 동시 실행·등급 부분을 원본 그대로 실행한다. */
export function loadPrototype(): ProtoSel {
  const src = readFileSync(
    new URL('../../../../../prototype/uiux/Main.dc.html', import.meta.url),
    'utf8',
  );
  const eff = /^const EFF = .*$/m.exec(src)?.[0];
  const from = src.indexOf('  HOST_BASE_GB:3,');
  const to = src.indexOf('  /* 가용 용량:', from);
  if (!eff || from < 0 || to < 0) throw new Error('프로토타입 원본에서 Sel을 찾지 못했습니다.');
  return runInNewContext(
    `${eff}\nconst Sel = {\n${src.slice(from, to)}\nisBlocked: () => false };\nSel`,
  ) as ProtoSel;
}
