/**
 * 설정 → Agent 탭(UI-12-02, P L2396–2450).
 *
 * - 기본 개발·검증 Agent는 새 Task에만 적용한다(기존 Task는 각 Task 개요에서 바꾼다, UAT-POLICY-01 a).
 * - 허용 모델: 마지막 허용 모델은 해제할 수 없다(화면에서 먼저 막고, 서버도 거부한다).
 * - 모델 순서는 설정값이다(owner 2026-11-26 아이템 8). 「위로 / 아래로」로 바꾼다. 초기값은 system seed가 넣는다.
 * - 편집 대상은 배열 위치가 아니라 안정 키로 정한다: 모델은 `Agent:모델ID`, 하위 Agent는 정의 ID.
 */
import { useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import type { ResponseOf } from '../../shared/api/contract.ts';
import { useApiQuery } from '../../shared/api/queries.ts';
import { formatDateTime } from '../../shared/format.ts';
import { TableScroll } from '../../shared/ui/TableScroll.tsx';
import { agentMark, EFFORT_LABEL, OPTIONS, withValue } from './labels.ts';
import { CardHead, QueryGate, Row, Seg, useSettingQuery } from './ui.tsx';
import { useSettingForm } from './useSettingForm.tsx';
import { LINK } from '../../shared/links.ts';
import { AlertAck } from '../../shared/ui/AlertAck.tsx';

/**
 * 팀장 고정 Task·모델별 사용 Task·하위 Agent 사용 현황(서버 후속 3차 GET /api/settings/agent-usage, M3 통합).
 * 원본 P L6761–6776(ex)·L6710–6716(sa) 계산을 서버가 한다. 화면은 받은 값만 보인다.
 * - 실제 사용은 Runner가 관측한 기록만 센다(설치만으로는 사용이 아님). 재작업률은 첫 QA의 PASS·FAIL만 센다.
 */
const useAgentUsage = () => useSettingQuery('getAgentUsage', '모델 · 하위 Agent 사용 현황', ['settings', 'task', 'attempt', 'verification']);

const AGENTS = ['Claude', 'Codex'] as const;
type AgentName = (typeof AGENTS)[number];

export function AgentTab() {
  return (
    <>
      <WorkflowCard />
      <ExecPolicyCard />
      <SubagentCard />
    </>
  );
}

/* ---------------- Agent 역할 · 기본 Workflow(UI-12-02, P L2397–2406) ---------------- */

function WorkflowCard() {
  const { client } = useApi();
  const q = useSettingQuery('getWorkflowSettings', 'Agent 역할');
  const wf = useSettingForm({
    id: 'workflow-roles',
    label: 'Agent 역할',
    ...q,
    toForm: (d) => ({ devAgent: String(d.devAgent) as AgentName, qaAgent: String(d.qaAgent) as AgentName }),
    send: (form, updatedAt, d) => {
      return client.call('putWorkflowSettings', {
        body: { updatedAt, devAgent: form.devAgent, qaAgent: form.qaAgent, liveInject: d.liveInject, heartbeatSeconds: d.heartbeatSeconds, missedHeartbeats: d.missedHeartbeats },
      });
    },
    successNotice: '기본 Agent를 저장했습니다 — 새 Task부터 적용됩니다.',
    describe: (f) => `기본 개발 ${f.devAgent} · 기본 검증 ${f.qaAgent}`,
  });
  const f = wf.form;
  const flow = f ? [`${f.devAgent} 개발`, `${f.qaAgent} QA`, `${f.devAgent} 재작업`, `${f.qaAgent} 재검증`, 'Completion Gate', 'Task 완료'] : [];
  return (
    <section className="card" aria-labelledby="set-wf">
      <CardHead id="set-wf" title="Agent 역할 · 기본 Workflow" />
      {wf.restoreOffer}
      <QueryGate query={q.query} label="Agent 역할" />
      {f && (
        <>
          <div className="form">
            <Row label="기본 개발 Agent">
              <Seg label="기본 개발 Agent" value={f.devAgent} onPick={(v) => { wf.edit((x) => ({ ...x, devAgent: v })); }} options={AGENTS.map((a) => ({ value: a, label: a }))} />
            </Row>
            <Row label="기본 검증 Agent">
              <Seg label="기본 검증 Agent" value={f.qaAgent} onPick={(v) => { wf.edit((x) => ({ ...x, qaAgent: v })); }} options={['Codex', 'Claude'].map((a) => ({ value: a as AgentName, label: a }))} />
              <span className="fhint">새 Task 생성 Wizard의 기본값입니다. 기존 Task는 각 Task 개요에서 바꿉니다.</span>
              {f.devAgent === f.qaAgent && <span className="ferr" role="alert">개발 Agent와 검증 Agent가 같습니다 — 교차 검증 원칙에 맞지 않습니다.</span>}
            </Row>
          </div>
          {wf.footer}
          <h3 className="h4" style={{ marginTop: 14 }}>Development Workflow</h3>
          <ol className="flow" style={{ marginTop: 4 }}>
            {flow.map((label, i) => <li key={label}><span className="st-n">{i + 1}</span>{label}</li>)}
          </ol>
          <p className="fhint">재작업은 기존 검증 결과를 덮어쓰지 않고 새 실행 시도로 기록됩니다. 완료는 Completion Gate 5개 조건이 모두 PASS일 때만 가능합니다.</p>
        </>
      )}
    </section>
  );
}

/* ---------------- 실행 정책 — 모델 · Effort(UI-12-02A, P L2407–2433) ---------------- */

type ModelData = ResponseOf<'getModelSettings'>;
const modelKey = (agent: string, id: string) => `${agent}:${id}`;

interface ModelForm { allowed: Record<string, boolean>; rankOrder: Record<AgentName, string[]> }

function modelForm(d: ModelData): ModelForm {
  return {
    allowed: Object.fromEntries(d.models.map((m) => [modelKey(String(m.agent), m.id), m.allowed])),
    rankOrder: { Claude: [...d.rankOrder.Claude], Codex: [...d.rankOrder.Codex] },
  };
}

/**
 * 화면 순서: 위 등급부터. 기준은 설정값인 순서 목록(rankOrder, 아래부터)이다(owner 2026-11-26 아이템 8).
 * - Runner가 아직 보고하지 않은 모델도 순서 목록에 있으면 보인다(「보고 전」). 새 설치에서도 초기 순서를 보고 바꿀 수 있어야 한다(리뷰 624c334 지적 4).
 * - 보고됐지만 순서 목록에 없는 모델은 서버 rank 순으로 아래에 둔다(「순서 없음」).
 * - 보고 전 모델은 허용을 바꿀 수 없다. 순서만 바꾸고 허용 모델을 임의로 늘리지 않는다.
 */
function orderedModels(d: ModelData, form: ModelForm, agent: AgentName) {
  const order = form.rankOrder[agent];
  const own = d.models.filter((m) => m.agent === agent);
  const listed = [...order].reverse().map((id, i) => {
    const reported = own.find((m) => m.id === id);
    return { id, label: reported?.label ?? id, rank: order.length - i, listed: true, reported: reported ?? null };
  });
  const unlisted = own.filter((m) => !order.includes(m.id)).sort((a, b) => b.rank - a.rank)
    .map((m) => ({ id: m.id, label: m.label, rank: m.rank, listed: false, reported: m }));
  return [...listed, ...unlisted];
}

function ExecPolicyCard() {
  const { client } = useApi();
  const mq = useSettingQuery('getModelSettings', '허용 모델');
  const usage = useAgentUsage();
  const models = useSettingForm({
    id: 'models',
    label: '허용 모델 · 모델 순서',
    ...mq,
    toForm: modelForm,
    check: (form) => {
      const d = mq.query.data;
      if (!d) return null;
      for (const agent of AGENTS) {
        const own = d.models.filter((m) => m.agent === agent);
        if (own.length > 0 && !own.some((m) => form.allowed[modelKey(agent, m.id)])) return `${agent}의 마지막 허용 모델은 해제할 수 없습니다 — 최소 1개는 허용해야 합니다.`;
      }
      return null;
    },
    send: (form, updatedAt, d) => {
      const rankChanged = JSON.stringify(form.rankOrder) !== JSON.stringify({ Claude: d.rankOrder.Claude, Codex: d.rankOrder.Codex });
      return client.call('putModelSettings', {
        body: {
          updatedAt,
          models: d.models.map((m) => ({ agent: m.agent, id: m.id, allowed: form.allowed[modelKey(String(m.agent), m.id)] ?? m.allowed })),
          ...(rankChanged ? { rankOrder: form.rankOrder } : {}),
        },
      });
    },
    successNotice: '허용 모델을 저장했습니다 — Planning Agent가 아직 시작하지 않은 Task의 등급을 다시 판단합니다.',
    describe: (form) => `허용: ${Object.entries(form.allowed).filter(([, on]) => on).map(([k]) => k).join(', ')}`,
  });
  const pq = useSettingQuery('getExecPolicy', '실행 정책');
  const policy = useSettingForm({
    id: 'exec-policy',
    label: '실행 정책',
    ...pq,
    toForm: (d) => ({
      onUsage: String(d.onUsage) as 'wait' | 'down', lowPct: d.lowPct, onRework: String(d.onRework) as 'same' | 'up1' | 'top', notifyAt: d.notifyAt,
      floors: { ...d.floors }, autoRetryLimit: d.autoRetryLimit, autoReworkLimit: d.autoReworkLimit,
    }),
    send: (form, updatedAt) => client.call('putExecPolicy', { body: { updatedAt, ...form } }),
    describe: (f) => `사용량 부족 시 ${f.onUsage === 'wait' ? '리셋까지 대기' : `낮춰서 진행(${String(f.lowPct)}%)`} · 재작업 시 ${f.onRework}`,
  });
  const alerts = useApiQuery('listAlerts', {}, { topics: ['alert'] });
  const escalations = (alerts.data?.items ?? []).filter((a) => a.key.startsWith('rework-limit:') || a.key.startsWith('retry:'));
  const d = mq.query.data;
  const p = policy.form;

  return (
    <section className="card" aria-labelledby="set-ex">
      <CardHead id="set-ex" title="Agent 실행 정책 — 모델 · Effort"><span className="fhint">Task별 모델 · Effort는 Planning Agent가 판단하고 근거를 남깁니다 · 팀장은 허용 모델 · 상향 한계 · 최저선만 정합니다</span></CardHead>
      {models.restoreOffer}{policy.restoreOffer}
      <div className="cmp">
        <div>
          <h3 className="h4" style={{ marginTop: 0 }}>허용 모델 · 순서</h3>
          <QueryGate query={mq.query} label="허용 모델" />
          {d && models.form && AGENTS.map((agent) => {
            const rows = orderedModels(d, models.form as ModelForm, agent);
            const mark = agentMark(agent);
            const efforts = rows.find((m) => m.reported?.efforts)?.reported?.efforts ?? null;
            return (
              <div key={agent} className="agbox">
                <div className="dp-h" style={{ margin: '0 0 6px' }}>
                  <span className="agent"><span className={`ag-mk ${mark.cls}`} aria-hidden="true">{mark.init}</span><b>{agent}</b></span>
                  <span className="muted" style={{ fontSize: 12 }}>Effort {efforts ? efforts.map((e) => `${EFFORT_LABEL[e.key] ?? e.key} (${e.key})`).join(' · ') : '미확인'}</span>
                </div>
                <TableScroll minWidth={640} label={`${agent} 모델 표`}>
                  <div className="gtb" style={{ margin: 0 }}>
                    <div className="gtr h" style={{ gridTemplateColumns: 'minmax(110px,1fr) 96px 148px 124px 84px', minWidth: 0 }}><span className="gc">모델</span><span className="gc">순위</span><span className="gc">상태</span><span className="gc">사용</span><span className="gc" /></div>
                    {rows.length === 0 && <div className="gtr"><span className="gc muted">설정된 모델 순서도, Runner가 보고한 모델도 없습니다. Runner가 연결되면 사용 가능한 모델을 보고합니다.</span></div>}
                    {rows.map((m) => {
                      const key = modelKey(agent, m.id);
                      const allowed = m.reported ? (models.form?.allowed[key] ?? m.reported.allowed) : false;
                      const st = !m.reported ? { l: '보고 전', c: 'sc sc-none' }
                        : allowed ? { l: '허용', c: 'sc sc-ok' } : m.reported.isNew ? { l: '신규 보고 — 미허용', c: 'sc sc-warn' } : { l: '미허용', c: 'sc sc-none' };
                      const order = models.form?.rankOrder[agent] ?? [];
                      const pos = order.indexOf(m.id);
                      const move = (delta: number) => {
                        models.edit((f) => {
                          const list = [...f.rankOrder[agent]];
                          const from = list.indexOf(m.id);
                          const to = from + delta;
                          if (from < 0 || to < 0 || to >= list.length) return f;
                          [list[from], list[to]] = [list[to] as string, list[from] as string];
                          return { ...f, rankOrder: { ...f.rankOrder, [agent]: list } };
                        });
                      };
                      return (
                        <div key={key} className="gtr" style={{ gridTemplateColumns: 'minmax(110px,1fr) 96px 148px 124px 84px', minWidth: 0 }}>
                          <span className="gc"><b>{m.label}</b> <span className="mono muted" style={{ fontSize: 11, whiteSpace: 'nowrap' }}>{m.id}</span></span>
                          <span className="gc mono">
                            {m.listed ? `순위 ${String(m.rank)}` : '순서 없음'}
                            {m.listed && (
                              <span className="rank-btns">
                                <button type="button" className="btn ghost sm" aria-label={`${m.id} 순위 올리기`} disabled={pos >= order.length - 1} onClick={() => { move(1); }}>▲</button>
                                <button type="button" className="btn ghost sm" aria-label={`${m.id} 순위 내리기`} disabled={pos <= 0} onClick={() => { move(-1); }}>▼</button>
                              </span>
                            )}
                          </span>
                          <span className="gc"><span className={st.c}>{st.l}</span></span>
                          {/* 원본 m.used(P L6764): 허용 모델만 「사용 중 Task n건」(완료·취소 제외, 서버 집계) */}
                          <span className="gc muted">{allowed && usage.query.data ? `사용 중 Task ${String(usage.query.data.models.find((u) => String(u.agent) === agent && u.modelId === m.id)?.taskKeys.length ?? 0)}건` : '—'}</span>
                          <span className="gc">
                            {m.reported && <button type="button" className="btn ghost sm" onClick={() => { models.edit((f) => ({ ...f, allowed: { ...f.allowed, [key]: !allowed } })); }}>{allowed ? '허용 해제' : '허용'}</button>}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </TableScroll>
              </div>
            );
          })}
          <p className="fhint" style={{ margin: 0 }}>새 모델이 보고되면 「신규 보고 — 미허용」으로 표시됩니다. 허용하면 Planning Agent가 아직 시작하지 않은 Task의 등급을 다시 판단합니다. 허용을 해제하면 그 모델을 쓰던 Task가 다른 허용 모델로 바뀝니다. 순위는 클수록 위 등급이며, 재작업 상향은 이 순서를 따릅니다.</p>
          {models.footer}
        </div>
        <div>
          <QueryGate query={pq.query} label="실행 정책" />
          {p && (
            <div className="form">
              <Row label="사용량 부족 시">
                <Seg label="사용량 부족 시" value={p.onUsage} onPick={(v) => { policy.edit((x) => ({ ...x, onUsage: v })); }} options={[{ value: 'wait', label: '리셋까지 대기' }, { value: 'down', label: '낮춰서 진행' }]} />
                <span className="fhint">리셋까지 대기: 등급을 바꾸지 않고, 사용량이 0%가 되면 리셋까지 기다립니다 — 대기 시간은 일정에 자동 반영. 낮춰서 진행: 남은 사용량이 기준 미만이면 Runner가 Effort를 한 단계 낮춰 실행합니다 (최저선 · 팀장 고정 Task는 제외, 재작업 상향이 우선, 0%면 대기).</span>
              </Row>
              {p.onUsage === 'down' && (
                <Row label="낮춤 기준">
                  <Seg label="낮춤 기준" value={p.lowPct} onPick={(v) => { policy.edit((x) => ({ ...x, lowPct: v })); }} options={withValue(OPTIONS.lowPct, p.lowPct).map((n) => ({ value: n, label: `${String(n)}%` }))} />
                  <span className="fhint">Agent가 보고한 남은 사용량이 이 값 미만일 때 적용합니다. 기본값 20%.</span>
                </Row>
              )}
              <Row label="재작업 시">
                <Seg label="재작업 시" value={p.onRework} onPick={(v) => { policy.edit((x) => ({ ...x, onRework: v })); }} options={[{ value: 'same', label: '같은 등급 유지' }, { value: 'up1', label: '한 단계 상향' }, { value: 'top', label: '최상위로 상향' }]} />
                <span className="fhint">직전 개발 시도 등급 기준. 한 단계 상향: Effort 한 단계, Effort가 최상위면 허용 모델 중 한 단계 위. 최상위로 상향: 허용 범위의 최상위 모델 · Effort로 바로 실행. 어느 경우든 사유를 실행 기록에 남기고, 중단 후 재개는 같은 등급을 유지합니다.</span>
              </Row>
              {p.onRework === 'same' && <div className="banner warn" role="note"><div className="banner-b">같은 등급 유지 — 재작업이 반복되어도 등급이 오르지 않습니다. 아래 알림 횟수는 같은 등급 반복에도 적용되지 않으니 대시보드의 등급별 재작업률을 확인하세요.</div></div>}
              <Row label="최상위 등급 재작업 알림">
                <Seg label="최상위 등급 재작업 알림" value={p.notifyAt} onPick={(v) => { policy.edit((x) => ({ ...x, notifyAt: v })); }} options={OPTIONS.notifyAt.map(([value, label]) => ({ value, label }))} />
                <span className="fhint">더 올릴 등급이 없는데 재작업이 반복되면 같은 등급으로 계속 시도하고, 이 횟수부터 팀장에게 알립니다.</span>
              </Row>
              {([['verifyGeDev', '검증 Effort ≥ 개발 Effort', '검증 Agent가 개발보다 얕게 보지 않도록 — 공통 단계 기준'], ['dbHigh', 'DB · Migration 작업 Effort 높음 이상', '되돌리기 어려운 변경']] as const).map(([key, label, desc]) => (
                <Row key={key} label="최저선">
                  <span><b>{label}</b></span>
                  <Seg label={`최저선: ${label}`} value={p.floors[key]} onPick={(v) => { policy.edit((x) => ({ ...x, floors: { ...x.floors, [key]: v } })); }} options={[{ value: true, label: '적용' }, { value: false, label: '해제' }]} />
                  <span className="fhint">{desc}</span>
                </Row>
              ))}
              {/* 원본 P L2430: 팀장 고정 Task. 개발·검증이 모두 고정이면 서버는 두 행을 주므로 Task로 묶는다. */}
              <Row label="팀장 고정 Task">
                {usage.query.data === undefined ? <QueryGate query={usage.query} label="팀장 고정 Task" /> : (() => {
                  const locked = [...new Map(usage.query.data.lockedTasks.map((t) => [t.taskKey, t])).values()];
                  return locked.length === 0
                    ? <span className="muted">없음 — 모든 Task가 Planning Agent 판단을 따릅니다.</span>
                    : <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{locked.map((t) => <Link key={t.taskKey} className="reflink" to={LINK.task(t.taskKey, 'overview')}>{t.taskKey} {t.title}</Link>)}</span>;
                })()}
              </Row>
              {escalations.length > 0 && (
                <div className="banner warn" role="note">
                  <div className="banner-b">
                    <b>팀장 확인 필요</b>
                    {escalations.map((a) => (
                      <div key={a.id} className="al-row">
                        <span className="mono muted">{formatDateTime(a.at)}</span>
                        <span className="al-t">{a.taskKey ? `${a.taskKey} — ` : ''}{a.text}</span>
                        {/* 원본 al.open = goExec(작업 실행). 통합 전에는 WBS 상세로 갔다(공통 주소 LINK.exec로 바로잡음) */}
                        {a.taskKey && <Link className="btn ghost sm" to={LINK.exec(a.taskKey)}>실행 보기</Link>}
                        <AlertAck id={a.id} label={a.text} />
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
          {policy.footer}
        </div>
      </div>
    </section>
  );
}

/* ---------------- 하위 Agent(UI-12-02B, P L2435–2450) ---------------- */

function SubagentCard() {
  const { client } = useApi();
  const q = useSettingQuery('getSubagentSettings', '하위 Agent', ['settings', 'planning']);
  const sa = useSettingForm({
    id: 'subagents',
    label: '하위 Agent',
    ...q,
    toForm: (d) => ({ enabled: d.enabled, allowed: Object.fromEntries(d.defs.map((x) => [x.id, x.allowed])) as Record<string, boolean> }),
    send: (form, updatedAt) => client.call('putSubagentSettings', {
      body: { updatedAt, enabled: form.enabled, allowed: Object.entries(form.allowed).map(([id, allowed]) => ({ id, allowed })) },
    }),
    successNotice: '하위 Agent 설정을 저장했습니다 — 허용을 바꾼 정의가 지정된 Task는 Planning Agent가 다시 판단합니다.',
    describe: (f) => `사용 ${f.enabled ? '함' : '안 함'} · 허용 ${String(Object.values(f.allowed).filter(Boolean).length)}개`,
  });
  const [open, setOpen] = useState<string | null>(null);
  const d = q.query.data;
  const f = sa.form;
  // 원본 P L2442 열 그대로: 지정 Task·마지막 사용·재작업률은 서버 사용 현황(getAgentUsage)
  const cols = 'minmax(170px,1.1fr) 90px 100px minmax(150px,1fr) 100px 80px 120px 110px 150px';
  const usage = useAgentUsage();
  return (
    <section className="card" aria-labelledby="set-sa">
      <CardHead id="set-sa" title="하위 Agent">
        {d && <span className="fhint">{`${String(d.defs.length)}개 정의 · 허용 ${String(d.defs.filter((x) => x.allowed).length)} · Claude ${String(d.defs.filter((x) => x.agent === 'Claude').length)} · Codex ${String(d.defs.filter((x) => x.agent === 'Codex').length)}`}</span>}
      </CardHead>
      {sa.restoreOffer}
      <QueryGate query={q.query} label="하위 Agent" />
      {d && f && (
        <>
          <div className="form" style={{ marginBottom: 8 }}>
            <Row label="사용">
              <Seg label="하위 Agent 사용" value={f.enabled} onPick={(v) => { sa.edit((x) => ({ ...x, enabled: v })); }} options={[{ value: true, label: '사용 (Planning Agent가 Task별 지정)' }, { value: false, label: '사용 안 함 (기본 Agent로 실행)' }]} />
              <span className="fhint">정의는 Agent WBS가 보관하고, Runner가 시도를 시작할 때마다 그 Task에 지정된 것만 해당 worktree의 <span className="mono">.claude/agents/</span> · <span className="mono">.codex/agents/</span>에 자동 설치합니다. 설치에 실패하면 그 시도는 시작하지 않습니다. 모델 · Effort는 정의에 적지 않고 Agent 실행 정책을 따릅니다.</span>
            </Row>
          </div>
          {!f.enabled && <div className="banner warn" role="note"><div className="banner-b">하위 Agent를 쓰지 않습니다 — Task에 지정된 하위 Agent 기록은 그대로 두고, 새 실행은 기본 Agent만으로 합니다. 지정된 하위 Agent는 쓰이지 않습니다.</div></div>}
          <TableScroll minWidth={1100} label="하위 Agent 정의 표">
            <div className="gtb" style={{ margin: 0 }}>
              <div className="gtr h" style={{ gridTemplateColumns: cols, minWidth: 0 }}><span className="gc">하위 Agent</span><span className="gc">역할</span><span className="gc">Agent</span><span className="gc">도구 · 권한</span><span className="gc">버전</span><span className="gc">지정 Task</span><span className="gc">마지막 사용</span><span className="gc">재작업률</span><span className="gc">상태</span></div>
              {d.defs.length === 0 && <div className="gtr"><span className="gc muted">등록된 하위 Agent 정의가 없습니다. 검토를 마친 정의가 system seed로 들어오면 여기에 보입니다.</span></div>}
              {d.defs.map((x) => {
                const allowed = f.allowed[x.id] ?? x.allowed;
                const mark = agentMark(String(x.agent));
                const isOpen = open === x.id;
                return (
                  <div key={x.id} style={{ display: 'contents' }}>
                    <div className="gtr" style={{ gridTemplateColumns: cols, minWidth: 0 }}>
                      <span className="gc"><b className="mono">{x.id}</b><br /><button type="button" className="reflink" aria-expanded={isOpen} onClick={() => { setOpen(isOpen ? null : x.id); }}>{isOpen ? '지시문 닫기' : '지시문 보기'}</button></span>
                      <span className="gc">{x.role}</span>
                      <span className="gc"><span className="agent"><span className={`ag-mk ${mark.cls}`} aria-hidden="true">{mark.init}</span>{x.agent}</span></span>
                      <span className="gc">{x.tools}<br /><span className="muted">{x.sandbox}</span></span>
                      <span className="gc mono">{`v${String(x.version)}`}<br /><span className="muted">{x.hash.slice(0, 12)}</span></span>
                      {(() => {
                        if (!usage.query.data) return <><span className="gc mono muted">—</span><span className="gc mono muted">—</span><span className="gc muted">—</span></>;
                        // 사용 현황에 없는 정의는 지정·사용 기록이 없는 것이다(원본: 0건 · 사용 기록 없음 · 판정 전).
                        const u = usage.query.data.subagents.find((y) => y.id === x.id) ?? { taskKeys: [], lastAttemptKey: null, lastUsedAt: null, decisions: 0, failures: 0 };
                        const rate = u.decisions ? u.failures / u.decisions : null;
                        return (
                          <>
                            <span className="gc mono">{`${String(u.taskKeys.length)}건`}</span>
                            <span className="gc mono"><span className="tcell"><span>{u.lastAttemptKey ?? '사용 기록 없음'}</span>{u.lastUsedAt && <span className="tid">{formatDateTime(u.lastUsedAt).slice(5)}</span>}</span></span>
                            <span className="gc"><span className={rate === null ? 'muted' : rate >= 0.3 ? 'sc sc-bad' : 'sc sc-ok'}>{rate === null ? '판정 전' : `${String(Math.round(rate * 100))}% (${String(u.failures)}/${String(u.decisions)})`}</span></span>
                          </>
                        );
                      })()}
                      <span className="gc"><span className={allowed ? 'sc sc-ok' : 'sc sc-none'}>{allowed ? '허용' : '미허용'}</span> <button type="button" className="btn ghost sm" onClick={() => { sa.edit((y) => ({ ...y, allowed: { ...y.allowed, [x.id]: !allowed } })); }}>{allowed ? '허용 해제' : '허용'}</button></span>
                    </div>
                    {isOpen && <div className="subtext"><pre>{x.text}</pre>{x.ref && <span className="muted">참고: {x.ref}</span>}</div>}
                  </div>
                );
              })}
            </div>
          </TableScroll>
          {sa.footer}
        </>
      )}
    </section>
  );
}
