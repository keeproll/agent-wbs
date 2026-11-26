import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';

/** Evaluate only the prototype's data/selector declarations, never its UI or browser code. */
export function prototypeFixture(html: string): unknown {
  const start = html.indexOf('const LBL =');
  const api = html.indexOf('const Api =');
  const baseline = html.indexOf('/* 기준 v1:', api);
  const project = html.indexOf('/* 프로젝트 등록 정보', baseline);
  const reports = html.indexOf('/* 정기 보고서 Mock', project);
  const functions = html.indexOf('function nowStr()', reports);
  const component = html.indexOf('class Component extends', functions);
  assert(
    start > 0 &&
      api > start &&
      baseline > api &&
      project > baseline &&
      reports > project &&
      functions > reports &&
      component > functions,
  );
  const code =
    html.slice(start, api) +
    html.slice(api, baseline) +
    html.slice(project, reports) +
    'return d; }};\n' +
    html.slice(functions, component) +
    '\nconst loaded=Api.loadProject(); ({mock:Object.fromEntries(["project","phases","tasks","deps","attempts","verifs","msgs","plannings","proposals","hist"].map(key=>[key,loaded[key]])),sub:{defs:SUB_MOCK.defs},sched:SCHED_MOCK});';
  return runInNewContext(code, {}, { timeout: 5000 }) as unknown;
}
