// 원본 로직의 메모리 모델만 조사한다. DOM/브라우저 렌더 검증은 수행하지 않는다.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.resolve(here, '../../prototype/uiux/Main.dc.html'), 'utf8');
const code = source.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
const timers = [];
class DCLogic {
  constructor(props) { this.props = props; }
  setState(patch) { Object.assign(this.state, typeof patch === 'function' ? patch(this.state) : patch); }
}
const sandbox = { DCLogic, setTimeout: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, clearTimeout() {} };
vm.createContext(sandbox);
vm.runInContext(code + '\nthis.inspection = {Component, Api, Sel, LBL, COLS, COLSETS, DESIGN, SPEC_GROUPS, SPEC_TBL, NAV, STAGE_PCT, EFF, CPST, CP_OPS, TG_EV, TG_RULES0, TG_BLANK, TG_ERR, RUN_ROLE, GH_SCOPES, REPO_LAYOUT, SPLIT_RULES, SKELETON, IMPL, integrity};', sandbox);
const x = sandbox.inspection;
const app = new x.Component({});
const data = app.state.data;
assert.equal(x.NAV.length, 12);
assert.equal(Object.keys(data.tasks).length, 12);
assert.equal(x.Sel.gate(data, data.tasks['TASK-0001']).length, 5);
assert.equal(app.tgChatOk('+821012345678'), false);
assert.equal(app.tgChatOk('@teamlead'), false);
assert.equal(app.tgChatOk('-1001234567890'), true);
assert.equal(x.Sel.checkGh('https://github.com/a/b/tree/main', data.github).ok, false);
assert.equal(x.Sel.checkGh('https://github.com/a/repo-noproto', data.github).ok, false);
assert.equal(x.Sel.checkGh('https://github.com/a/repo', data.github).ok, true);

function schema(value, key = '', out = new Map()) {
  if (value === null) return out;
  const type = Array.isArray(value) ? 'array' : typeof value;
  if (!out.has(key)) out.set(key, { types: new Set(), examples: new Set() });
  const row = out.get(key);
  row.types.add(type);
  if (type !== 'object' && type !== 'array' && row.examples.size < 3) row.examples.add(value);
  if (Array.isArray(value)) value.forEach(v => schema(v, key+'[]', out));
  else if (type === 'object') Object.entries(value).forEach(([k,v]) => schema(v, key + (key?'.':'') + (/^TASK-\d+$/.test(k) ? 'TASK-*' : k), out));
  return out;
}
const schemaRows = [...schema(data)].map(([key,v])=>({path:key, types:[...v.types], examples:[...v.examples]}));
const constants = Object.fromEntries(Object.entries(x).filter(([key])=>!['Component','Api','Sel','integrity'].includes(key)));
const logicProbes = [];
function probe(name, fn) { const result = fn(); logicProbes.push({name,result}); return result; }
probe('메뉴 목록', () => x.NAV.map(n=>n.l));
probe('SS는 취소/실패/중단도 시작으로 간주', () => {
  const copy = JSON.parse(JSON.stringify(data));
  return ['planning','ready','failed','cancelled','paused'].map(status=>{copy.tasks['TASK-0001'].status=status; return {status, met:x.Sel.depMet(copy,{pred:'TASK-0001',type:'SS'})};});
});
probe('설계 코드 수정 요청의 실제 메시지 증가', () => {const before=app.state.data.msgs.length; app.dsDrift('DR-01','code'); return {before, after:app.state.data.msgs.length, resolution:app.state.data.design.drifts.find(d=>d.id==='DR-01').res};});
probe('실행 결과 음수 토큰 검증', () => app.exErrs({kind:'dev', f:{summary:'valid',ok:true,fail:'',tok:'-10'}}));
probe('실제 상태 미리보기 개수', () => {app.setVM(); return {normal:app._pv.length, errors:app._pvE.length};});
probe('Telegram 저장 실패 때 초안 유지 여부', () => {
  const a = new x.Component({});
  a.tgEdit({target:'저장 실패 시 유지해야 하는 이름'});
  a.state.fault='e500';
  a._uiSnap=a.pickUi(a.state);
  a.tgSave();
  return {savedName:a.state.data.tg.conf.target, draftAfterSave:a.state.tgF, error:a.state.err?.kind};
});
probe('승인 전 WBS 작성모달 WP 선택값', () => {
  app.preview('fresh');
  return app.state.data.phases.map(p=>({phase:p.id,wps:p.wps.map(w=>w.id)}));
});
const report = {
  note: 'Node vm + synchronous setState stub; timers queued but not run; DOM/browser unverified. Runtime-dependent timestamps are deliberately omitted from saved fixture.',
  sampleCounts: Object.fromEntries(['phases','tasks','deps','attempts','verifs','msgs','plannings','proposals','reports'].map(k=>[k,Array.isArray(data[k])?data[k].length:Object.keys(data[k]).length])),
  schema: schemaRows,
  constants,
  logicProbes,
  integrity: x.integrity(data)
};
fs.mkdirSync(path.join(here,'evidence'),{recursive:true});
fs.writeFileSync(path.join(here,'evidence','data-model.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({sampleCounts:report.sampleCounts, schemaPaths:schemaRows.length, probes:logicProbes, integrityFailures:report.integrity.filter(i=>!i.ok)},null,2));
