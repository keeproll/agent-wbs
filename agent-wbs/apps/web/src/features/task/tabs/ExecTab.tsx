/**
 * 실행 탭(UI-03-06) — 실행 시도(Attempt) 기록, 원본 P L1303–1324.
 * 실행 요청·중단·재개는 [작업 실행](M3-06)에서 한다. 여기서는 기록만 읽는다.
 * CI 참조(「Task 검사 … · CI-xxxx」, P L1310): 그 시도의 가장 최근 ① Task 검사 실행. 누르면 빌드·통합 실행 상세(M7-05, UAT-TASK-10-CI).
 * 지정 · 실제 하위 Agent 태그(P L1310, UAT-TASK-10): 계약 Attempt.subagents. 문구 규칙은 shared/subagents.ts.
 */
import { Link } from 'react-router';
import type { UseQueryResult } from '@tanstack/react-query';
import type { ApiError } from '../../../shared/api/client.ts';
import type { ResponseOf } from '../../../shared/api/contract.ts';
import { formatDateTime } from '../../../shared/format.ts';
import { AreaLoading } from '../../../shared/ui/loading.tsx';
import { ListError } from '../parts.tsx';
import { EFF, useGradeSettings } from './OverviewTab.tsx';
import { agCls, agInit, ATTEMPT_KIND, ATTEMPT_STATUS, FLOW_ORDER, type TaskDetailData } from '../labels.ts';
import { LINK } from '../../../shared/links.ts';
import { useAllPages } from '../../../shared/api/allPages.ts';
import { useApiQuery } from '../../../shared/api/queries.ts';
import { attemptCiRef } from '../../ci/model.ts';
import { SubagentTags } from '../../../shared/ui/SubagentTags.tsx';

type Attempts = UseQueryResult<ResponseOf<'getTaskAttempts'>, ApiError>;
type Attempt = ResponseOf<'getTaskAttempts'>['items'][number];

/** 실행 흐름 단계(P L5942–5947). 지금 단계는 Task 상태로 정한다. */
function flowSteps(t: TaskDetailData, atts: Attempt[]) {
  const s = String(t.lifecycleStatus);
  const stageOf: Record<string, string> = { running: 'dev', qa: 'qa', rework: 'rework', verifying: 'reverify', gate: 'gate', done: 'done' };
  const stage = stageOf[s] ?? (atts.length ? 'dev' : '');
  const idx = FLOW_ORDER.indexOf(stage as (typeof FLOW_ORDER)[number]);
  const hadRework = atts.some((a) => String(a.kind) === 'rework');
  const firstFail = atts.some((a) => String(a.kind) === 'qa' && String(a.status) === 'failed');
  const ag = t.assigneeAgent === null ? '' : String(t.assigneeAgent);
  const vf = t.verifierAgent === null ? '' : String(t.verifierAgent);
  const SL: Record<string, string> = { dev: `${ag} 개발`, qa: `${vf} QA`, rework: `${ag} 재작업`, reverify: `${vf} 재검증`, gate: 'Completion Gate', done: 'Task 완료' };
  return FLOW_ORDER.map((k, i) => ({
    n: String(i + 1), l: SL[k] ?? k,
    cls: i === idx ? (k === 'done' ? 'done' : 'cur') : i < idx ? ((k === 'rework' || k === 'reverify') && !hadRework ? 'skip' : k === 'qa' && firstFail ? 'fail' : 'done') : '',
  }));
}

export function ExecTab({ task: t, attempts }: { task: TaskDetailData; attempts: Attempts }) {
  const atts = attempts.data?.items ?? [];
  const { models } = useGradeSettings();
  // 이 Task의 CI 실행(모든 쪽). 프로젝트 id는 앱 틀이 이미 읽은 getProject 캐시에서 얻는다.
  const project = useApiQuery('getProject', {}, { topics: ['project', 'planning', 'design', 'task'] });
  const projectId = project.data && 'id' in project.data ? String(project.data.id) : '';
  const ciRuns = useAllPages('listCiRuns', { params: { projectId }, query: { taskKey: t.taskKey } }, { topics: ['ci'], enabled: projectId !== '' });
  /** 원본 gradeL(「Opus 5.5 · 높음」). 설정의 모델 이름을 못 읽으면 id 그대로 */
  const gradeL = (m: string, e: string | null) => `${models.data?.models.find((x) => x.id === m)?.label ?? m} · ${EFF[e ?? '']?.l ?? e ?? ''}`;
  /** 같은 날 끝났으면 끝 시각만(원본 「15:10 – 17:48」) */
  const endL = (a: Attempt) => {
    if (!a.endedAt) return '진행 중';
    const s = formatDateTime(a.startedAt), e = formatDateTime(a.endedAt);
    return s.slice(0, 10) === e.slice(0, 10) ? e.slice(11) : e;
  };
  return (
    <div className="pane">
      <div className="pane-h"><div className="pane-hl"><h3>실행</h3><span className="muted">Execution Attempt — 실행 단위 기록 (재작업은 새 시도로 누적)</span></div><Link className="btn primary sm" to={`${LINK.exec(t.taskKey)}`}>작업 실행 화면에서 진행</Link></div>
      <ol className="flow" style={{ margin: '0 0 14px' }}>{flowSteps(t, atts).map((st) => <li key={st.n} className={st.cls}><span className="st-n">{st.n}</span>{st.l}</li>)}</ol>
      {attempts.data === undefined && (attempts.isError ? <ListError label="실행 기록" error={attempts.error} retrying={attempts.isFetching} onRetry={() => { void attempts.refetch(); }} /> : <AreaLoading label="실행 기록 불러오는 중" />)}
      {attempts.data !== undefined && !atts.length && <p className="empty">실행 기록이 없습니다.</p>}
      {atts.map((a) => {
        const st = ATTEMPT_STATUS[String(a.status)] ?? { l: String(a.status), c: 's-plan' };
        const ag = String(a.agent);
        const ci = attemptCiRef(ciRuns.data?.items ?? [], a.id);
        return (
          <div className="att" key={a.id} role="article" aria-label={`실행 ${a.attemptKey}`}>
            <div className="att-h">
              <span className="att-n mono">{a.attemptKey}</span><span className="wt">{ATTEMPT_KIND[String(a.kind)] ?? String(a.kind)}</span>
              <span className="agent"><span className={`ag-mk ${agCls(ag)}`} aria-hidden="true">{agInit(ag)}</span>{ag}</span>
              <span className="tag">{a.modelId ? gradeL(a.modelId, a.effort) : '등급 미기록'}</span>
              {ci && <Link className={ci.c} to={LINK.ci(ci.id)} title="Runner가 실행한 Task 검사 — 클릭하면 빌드 · 통합">{ci.l}</Link>}
              <SubagentTags subagents={a.subagents} running={String(a.status) === 'running'} />
              {a.gradeAdjust && <span className={a.gradeAdjust.kind === 'down' ? 'sc sc-none' : 'sc sc-warn'}>{a.gradeAdjust.reason}</span>}
              <span className={`st ${st.c}`}><span className="st-d" aria-hidden="true" />{st.l}</span>
              <span className="mono muted">{formatDateTime(a.startedAt)} – {endL(a)}</span>
            </div>
            {a.summary && <p>{a.summary}</p>}
            {a.failure && <div className="banner danger" style={{ marginTop: 6 }}><div className="banner-b"><b>실패 사유</b> — {a.failure}</div></div>}
            {a.changedFiles.length > 0 && <div className="ev"><span className="ev-l">변경 파일</span><ul className="lst mono-list" style={{ margin: 0 }}>{a.changedFiles.map((f) => <li key={f}>{f}</li>)}</ul></div>}
          </div>
        );
      })}
    </div>
  );
}
