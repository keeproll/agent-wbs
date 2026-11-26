/**
 * 가운데: 선택 Task의 현재 단계·다음 작업·실행할 수 없는 이유(P L1759–1765),
 * 팀장 확인 필요 알림(GET /api/alerts), Completion Gate(L1811–1818), 재작업 지시(L1801), 선택 시도 기록(L1820–1840).
 * 실행 기록과 메시지는 섞지 않는다(G§4.6). 메시지는 오른쪽 영역에 있다.
 */
import { Link } from 'react-router';
import { apiUrl } from '../../shared/api/client.ts';
import { useApiQuery } from '../../shared/api/queries.ts';
import { formatDateTime } from '../../shared/format.ts';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { useConfirm } from '../../shared/ui/feedback.tsx';
import {
  agentClass, agentInitial, ATTEMPT_STATUS, flowSteps, GATE_LABEL, KIND_LABEL, statusOf, VERDICT_CLASS,
  type ExecAttempt, type ExecVerification, type Flow, type NextStep,
} from './model.ts';
import { AreaError } from './AreaError.tsx';
import { ReworkEditor } from './ReworkEditor.tsx';
import type { ExecData } from './useExecData.ts';
import { useTaskCommand } from './useTaskCommand.tsx';

type TaskRow = NonNullable<ExecData['task']>;

export interface CenterProps {
  projectId: string;
  task: TaskRow;
  flow: Flow;
  next: NextStep;
  attempt: ExecAttempt | null;
  verifications: readonly ExecVerification[];
  evidence: ExecData['evidence'];
  /** 주소의 시도 키가 이 Task에 없으면 그 키 */
  missingAttempt: string | null;
  alerts: readonly { id: string; text: string; at: string }[];
  /** 알림 조회(실패하면 한도 초과 여부를 모른다고 알린다) */
  alertsQuery: ExecData['alerts'];
  reworkOpen: boolean;
  onRework: (open: boolean) => void;
  /** 화면 시계(ms). 실행 시간 계산용 */
  now: number;
}

const hours = (ms: number) => `${(Math.max(0, ms) / 3_600_000).toFixed(1)}h`;
const gradeText = (a: ExecAttempt) => (a.modelId ? `${a.modelId}${a.effort ? ` · ${a.effort}` : ''}` : '등급 미기록');

export function ExecCenter({ projectId, task, flow, next, attempt, missingAttempt, verifications, evidence, alerts, alertsQuery, reworkOpen, onRework, now }: CenterProps) {
  const st = statusOf(task.lifecycleStatus);
  const command = useTaskCommand(projectId, task.taskKey, task.updatedAt);
  const confirm = useConfirm();
  const gate = useApiQuery('getTaskGate', { params: { taskKey: task.taskKey } }, { enabled: flow.stage === 'gate', topics: ['task', 'verification', 'ci'], keepPrevious: false });
  const verification = attempt ? verifications.filter((v) => v.attemptId === attempt.id).at(-1) ?? null : null;

  const act = async () => {
    const a = next.action;
    if (!a) return;
    if (a.op === 'rework') { onRework(true); return; }
    if (a.op === 'stop') {
      const ok = await confirm({
        title: '실행 중단', danger: true, ok: '중단 요청',
        body: `${a.attempt.attemptKey} 실행을 중단합니다. 이 시도는 「중단」으로 보존되고, 재개하면 같은 단계 · 같은 등급의 새 시도로 이어 갑니다.`,
      });
      if (!ok) return;
    }
    command.run(a);
  };

  return (
    <div className="mainc scrollc" aria-label="선택 Task 실행">
      <div className="card">
        <div className="pane-h" style={{ margin: 0 }}>
          <div>
            <span className="mono muted">WBS {task.wbsPath} · {task.taskKey}</span>
            <h2 className="h2">{task.title}</h2>
          </div>
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className={`st ${st.cls}`}><span className="st-d" aria-hidden="true" />{st.label}</span>
            <Link className="btn sm" to={`/wbs/${encodeURIComponent(task.taskKey)}`}>Task 상세 열기</Link>
          </span>
        </div>
        <ol className="flow" aria-label="실행 단계">
          {flowSteps(task, flow).map((s) => (
            <li key={s.n} className={s.cls} aria-current={s.cls === 'cur' ? 'step' : undefined}><span className="st-n">{s.n}</span>{s.label}</li>
          ))}
        </ol>
        <div className="next">
          <b>다음 작업</b><span>{next.text}</span><span className="sp" />
          {next.action && (
            <BusyButton busy={command.busy} busyLabel="요청 중…" variant={next.action.op === 'stop' ? 'default' : 'primary'} disabled={next.disabled || reworkOpen} onClick={() => { void act(); }}>
              {next.action.label}
            </BusyButton>
          )}
        </div>
        {next.reason && <p className="ferr" style={{ margin: '8px 0 0' }}>{next.reason}</p>}
        {task.checklist.total === 0 && (
          <p className="fhint" style={{ margin: '8px 0 0' }}>체크리스트가 없습니다 — Task 상세의 체크리스트 탭에서 항목을 추가합니다. Gate의 「필수 Checklist 완료」는 항목이 있어야 충족됩니다.</p>
        )}
        {alertsQuery.data === undefined && alertsQuery.isError && (
          <AreaError what="팀장 확인 알림을" error={alertsQuery.error} retrying={alertsQuery.isFetching} onRetry={() => { void alertsQuery.refetch(); }} />
        )}
        {alerts.length > 0 && (
          <div className="banner warn" role="note">
            <div className="banner-b">
              <b>팀장 확인 필요</b>
              {alerts.map((al) => (
                <div key={al.id} className="al-row" style={{ gridTemplateColumns: '132px minmax(0,1fr)' }}>
                  <span className="mono muted">{formatDateTime(al.at)}</span><span className="al-t">{al.text}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {command.conflictModal}
      </div>

      {reworkOpen && (
        <ReworkEditor
          projectId={projectId} taskKey={task.taskKey} agent={task.assigneeAgent ?? 'Claude'}
          attemptId={flow.lastV?.attemptId ?? null} updatedAt={task.updatedAt} onClose={() => { onRework(false); }}
        />
      )}

      {flow.stage === 'gate' && (
        <div className="card">
          <h3 className="sh" style={{ marginTop: 0 }}>Completion Gate</h3>
          <div className="gate" style={{ margin: 0 }}>
            {(gate.data?.conditions ?? []).map((g) => (
              <div key={String(g.key)} className="gate-r">
                <span>{GATE_LABEL[g.key] ?? String(g.key)}</span>
                <span className={`vf ${VERDICT_CLASS[g.result] ?? 'v-none'}`}>{String(g.result)}</span>
                <span className="muted">{g.reason}</span>
              </div>
            ))}
            {gate.isError && <div className="gate-r"><span className="ferr">Gate 현황을 불러오지 못했습니다.</span></div>}
            <div className="gate-f">
              <span className="muted">
                {gate.data?.passed
                  ? '모든 조건 충족 — 서버가 통합 확인 · 병합 뒤 자동으로 완료합니다. 「완료 판정 다시 요청」은 같은 판정을 다시 할 뿐 우회하지 않습니다.'
                  : '완료 불가 — 위 조건이 모두 충족되어야 서버가 완료 처리합니다.'}
              </span>
              <BusyButton small busy={command.busy} busyLabel="요청 중…" disabled={!gate.data?.passed} onClick={() => { command.run({ op: 'complete', label: '완료 판정 다시 요청' }); }}>
                완료 판정 다시 요청
              </BusyButton>
            </div>
          </div>
        </div>
      )}

      {missingAttempt && (
        <div className="banner warn" role="note"><div className="banner-b"><b>{missingAttempt} 시도를 찾을 수 없습니다</b> — 이 Task에 그런 실행 시도가 없습니다. 아래는 {attempt ? `${attempt.attemptKey}(실행 중 또는 마지막 시도)` : '시도 없음'}입니다.</div></div>
      )}
      {attempt ? <AttemptCard attempt={attempt} verification={verification} evidence={evidence} now={now} /> : (
        <>
          <p className="empty">이 Task에는 아직 실행 시도가 없습니다.</p>
          <p className="fhint">첫 실행은 위 「다음 작업」의 실행 요청으로 시작합니다. 요청이 받아들여지고 Runner가 가져가면 여기에 실행 기록이 생깁니다.</p>
        </>
      )}
    </div>
  );
}

function AttemptCard({ attempt: a, verification: v, evidence, now }: { attempt: ExecAttempt; verification: ExecVerification | null; evidence: CenterProps['evidence']; now: number }) {
  const as = ATTEMPT_STATUS[String(a.status)] ?? { label: String(a.status), cls: 's-plan' };
  const agent = String(a.agent);
  const end = a.endedAt ? Date.parse(a.endedAt) : now;
  const adj = a.gradeAdjust;
  const files = v ? (evidence.data ?? []).filter((e) => e.verificationId === v.id) : [];
  return (
    <div className="card" aria-label={`${a.attemptKey} 실행 기록`}>
      <div className="att-h">
        <span className="att-n mono">{a.attemptKey}</span>
        <span className="wt">{KIND_LABEL[a.kind] ?? String(a.kind)}</span>
        <span className="agent"><span className={`ag-mk ${agentClass(agent)}`} aria-hidden="true">{agentInitial(agent)}</span>{agent}</span>
        <span className="tag" title="실제 실행 등급(Runner 보고)">{gradeText(a)}</span>
        {adj && (
          <span className={adj.kind === 'down' ? 'sc sc-none' : 'sc sc-warn'} title={adj.reason}>
            {adj.kind === 'up' ? '등급 상향' : adj.kind === 'down' ? '등급 하향' : adj.kind === 'regrade' ? '등급 재판단' : '등급 유지'} {adj.from.model} · {adj.from.effort} → {adj.to.model} · {adj.to.effort} — {adj.reason}
          </span>
        )}
        <span className={`st ${as.cls}`}><span className="st-d" aria-hidden="true" />{as.label}</span>
        <span className="mono muted">
          {formatDateTime(a.startedAt)} – {a.endedAt ? formatDateTime(a.endedAt) : '진행 중'} · 실행 {hours(end - Date.parse(a.startedAt))} · 토큰 {a.tokens === null ? '미보고' : `${String(a.tokens)}K`}
        </span>
      </div>
      {a.summary && <p style={{ margin: '4px 0', color: '#3E4651' }}>{a.summary}</p>}
      {a.resumedFrom && <p className="fhint" style={{ margin: '4px 0' }}>중단된 시도를 이어서 재개한 새 시도입니다(같은 단계 · 같은 등급). 중단은 재시도 · 재작업 횟수에 넣지 않습니다.</p>}
      {a.failure && <div className="banner danger"><div className="banner-b"><b>{a.status === 'interrupted' ? '중단 사유' : '실패 사유'}</b> — {a.failure}</div></div>}
      {a.changedFiles.length > 0 && (
        <div className="ev"><span className="ev-l">변경 파일</span><ul className="lst mono-list" style={{ margin: 0 }}>{a.changedFiles.map((f) => <li key={f}>{f}</li>)}</ul></div>
      )}
      {v && (
        <div className="vbox">
          <div className="att-h">
            <span className="att-n mono">{v.id}</span>
            <span className={`vf ${VERDICT_CLASS[v.result] ?? 'v-none'}`}>{String(v.result)}</span>
            <span className="muted">이 실행에 연결된 검증 결과{v.invalidated ? ' · 코드나 명세가 바뀌어 무효' : ''}</span>
          </div>
          <div className="ev">
            <span className="ev-l">테스트 명령</span><span><code>{v.cmd}</code></span>
            <span className="ev-l">예상 결과</span><span>{v.expected || '—'}</span>
            <span className="ev-l">실제 결과</span><span>{v.actual || '—'}</span>
            <span className="ev-l">Evidence</span>
            {evidence.data === undefined && evidence.isError
              ? <AreaError what="Evidence를" error={evidence.error} retrying={evidence.isFetching} onRetry={() => { void evidence.refetch(); }} />
              : evidence.data === undefined ? <span className="muted">불러오는 중…</span>
              : files.length > 0
              ? <ul className="lst mono-list" style={{ margin: 0 }}>{files.map((e) => <li key={e.id}><a href={apiUrl('getEvidenceContent', { params: { id: e.id } })} download>{e.kind} · {e.sha256.slice(0, 12)}</a></li>)}</ul>
              : <span className="muted">연결된 Evidence 없음</span>}
            {v.defects.length > 0 && (
              <>
                <span className="ev-l">결함</span>
                <ul className="lst" style={{ margin: 0, color: '#8A1C12' }}>
                  {v.defects.map((d) => <li key={d.defKey}>{d.defKey} {d.text}{d.blocking ? ' (차단 결함)' : ''}{d.resolved ? ' · 해결됨' : ''}</li>)}
                </ul>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
