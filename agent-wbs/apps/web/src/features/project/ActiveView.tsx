/**
 * UI-02 프로젝트(진행 중, P L1993–2087) 중 M3-04 범위: 입력 자료·저장소(UI-02E), 프로젝트 기본 정보, 초기화(MOD-05 진입).
 * Agent 참여·계획 변경·WBS 구조 카드(UAT-PROJECT-11)는 M3-07 범위라 여기서 만들지 않는다.
 *
 * 입력 변경 흐름(G§4.2 ②): Runner가 감지한 커밋(changeCommits.state=pending)을 팀장이 확인하고
 * 「이 버전으로 분석」(POST /api/project/inputs) 또는 「분석 안 함」(POST /api/project/inputs/skip)을 고른다.
 * - 분석은 입력 사슬 끝(inputHead)을 새 입력 버전으로 고정한다. 이미 분석한 커밋이면 409 INPUT_UNCHANGED.
 * - 「분석 안 함」은 확인 기록(skipped)만 남기고, 다음 분석 때 그 변경도 함께 비교한다.
 * 입력 이력 재작성 경고(alerts key=input_history_rewritten)가 열려 있으면 「복구 확인 · 입력 확인 다시 시도」(POST /inputs/recheck, 조정자 결정 2026-11-26)를 보인다.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import type { ResponseOf } from '../../shared/api/contract.ts';
import { invalidateTopics, useApiQuery } from '../../shared/api/queries.ts';
import { formatDateTime } from '../../shared/format.ts';
import { useDocumentTitle } from '../../shared/layout/Page.tsx';
import { useEditGuard } from '../../shared/state/useEditGuard.ts';
import { useSave } from '../../shared/state/useSave.tsx';
import { useSessionDraft } from '../../shared/state/useSessionDraft.tsx';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { useNotice } from '../../shared/ui/feedback.tsx';
import { CHANGE_CHIP, INPUT_STEPS, STEP_CHIP, inputArea, shortSha, type ProjectState, type StepStatus } from './labels.ts';
import { useGithubSettings } from './github.ts';
import { RepoLayout } from './RegisterView.tsx';
import { ResetModal } from './ResetModal.tsx';

type Active = Extract<ProjectState, { approvedAt: unknown }>;
type ChangeCommit = Active['changeCommits'][number];

/** 대기 커밋들의 파일을 경로 하나로 합친다(P inputVM files). 같은 경로는 마지막 변경 종류를 쓰고 줄 수는 더한다. */
export function mergeFiles(commits: readonly ChangeCommit[]) {
  const files = new Map<string, { path: string; change: string; added: number; deleted: number }>();
  for (const c of commits) {
    for (const f of c.files) {
      const prev = files.get(f.path);
      files.set(f.path, { path: f.path, change: String(f.change), added: (prev?.added ?? 0) + f.added, deleted: (prev?.deleted ?? 0) + f.deleted });
    }
  }
  return [...files.values()].map((f) => ({ ...f, area: inputArea(f.path) }));
}

const lines = (a: number, d: number) => [a ? `+${String(a)}` : '', d ? `−${String(d)}` : ''].filter(Boolean).join(' ');

export function ActiveView({ project }: { project: Active }) {
  useDocumentTitle('프로젝트');
  const [resetOpen, setResetOpen] = useState(false);
  return (
    <div className="page scroll">
      <div className="page-h"><div><h1>프로젝트</h1><p className="page-sub">프로젝트 정보 · 입력 자료 · 상태 · WBS 구조 · Agent 참여 현황 — 프로젝트는 하나만 등록되며, 처음부터 다시 시작하려면 「프로젝트 초기화」</p></div></div>
      <InputsCard project={project} />
      <section className="card" aria-labelledby="pj-info-h">
        <div className="dp-h"><h2 id="pj-info-h">프로젝트 정보</h2></div>
        <div className="kv" style={{ gridTemplateColumns: '110px minmax(0,1fr)' }}>
          <span className="kv-l">프로젝트 ID</span><span className="kv-v mono">{project.id}</span>
          <span className="kv-l">이름</span><span className="kv-v">{project.name}</span>
          <span className="kv-l">상태</span><span className="kv-v"><span className="tag">진행 중</span></span>
          <span className="kv-l">목표일</span><span className="kv-v mono">{project.targetDate ?? '—'}</span>
          <span className="kv-l">초기 WBS 승인</span><span className="kv-v">{formatDateTime(project.approvedAt)} · Task {project.approvedTaskCount}건 · 기준 일정 v1</span>
        </div>
      </section>
      <section className="card danger-zone" aria-labelledby="pj-reset-h">
        <div className="dp-h"><h2 id="pj-reset-h">프로젝트 초기화</h2><button type="button" className="btn danger" onClick={() => { setResetOpen(true); }}>프로젝트 초기화…</button></div>
        <p className="fhint" style={{ margin: 0 }}>진행 중인 모든 작업을 중지하고, 지금까지의 기록 · 결과 · 산출물을 <b>모두 삭제</b>합니다. Agent WBS와 Runner는 프로젝트 등록 전 상태로 돌아가고, 작업 저장소는 등록 시점 기준 커밋으로 되돌아갑니다. 삭제된 내용은 복구할 수 없습니다. 입력 자료(prototype/ (uiux · docs))와 등록 이전부터 저장소에 있던 코드는 삭제하지 않습니다.</p>
      </section>
      {resetOpen && <ResetModal project={project} onClose={() => { setResetOpen(false); }} />}
    </div>
  );
}

function InputsCard({ project }: { project: Active }) {
  const { client } = useApi();
  const queryClient = useQueryClient();
  const notify = useNotice();
  const github = useGithubSettings();
  const alerts = useApiQuery('listAlerts', {}, { topics: ['alert'] });
  const rewritten = alerts.data?.items.find((a) => a.key === 'input_history_rewritten');
  const gh = github.data;
  const ghBad = !!gh && ((gh.mode === 'gh' ? !gh.account : !gh.tokenSet) || (gh.scopes ? Object.values(gh.scopes).includes('missing') : false));

  const pend = project.changeCommits.filter((c) => c.state === 'pending');
  const skipped = project.changeCommits.filter((c) => c.state === 'skipped');
  const files = mergeFiles(pend);
  const last = project.inputs.at(-1);
  const job = project.inputJob;
  const jobRunning = !!job && (job.status === 'queued' || job.status === 'running');

  const [instr, setInstr] = useState('');
  const dirty = instr.trim() !== '';
  useEditGuard(dirty);
  const { restoreOffer } = useSessionDraft<{ instr: string }>({
    id: `project:inputs:${project.inputHead}`, label: '입력 변경 분석 지시', value: dirty ? { instr } : null,
    onRestore: (data) => { setInstr(data.instr); },
  });
  const refresh = () => { void invalidateTopics(queryClient, ['project', 'alert']); };
  const latest = async () => {
    const p = await client.call('getProject', {});
    if (!('changeCommits' in p)) throw new Error('등록된 프로젝트가 없습니다.');
    return p;
  };

  interface AnalyzeBody { updatedAt: string; commit: string; commits: string[]; instr?: string }
  const analyzeBody = (p: Pick<Active, 'updatedAt' | 'inputHead' | 'changeCommits'>): AnalyzeBody => ({
    updatedAt: p.updatedAt, commit: p.inputHead, commits: p.changeCommits.filter((c) => c.state === 'pending').map((c) => c.sha),
    ...(instr.trim() ? { instr: instr.trim() } : {}),
  });
  const analyze = useSave<ResponseOf<'analyzeInputs'>, AnalyzeBody>({
    target: '이 버전으로 분석',
    failTitle: '분석을 시작하지 못했습니다',
    mine: `입력 변경 커밋 ${String(pend.length)}개 분석`,
    request: () => analyzeBody(project),
    run: ({ payload, idempotencyKey }) => client.call('analyzeInputs', { body: payload, idempotencyKey }),
    onSuccess: (_, payload) => { setInstr((cur) => (cur.trim() === (payload.instr ?? '') ? '' : cur)); refresh(); },
    successNotice: `입력 자료 v${String((last?.v ?? 0) + 1)} (main @ ${shortSha(project.inputHead)})으로 고정했습니다. Planning이 v${String(last?.v ?? 0)}과의 차이를 분석합니다.`,
    onRejected: refresh,
    onConflictReload: refresh,
    onConflictReapply: async () => { const p = await latest(); await client.call('analyzeInputs', { body: analyzeBody(p) }); setInstr(''); refresh(); },
  });
  interface SkipBody { updatedAt: string; commits: string[] }
  const skip = useSave<unknown, SkipBody>({
    target: '분석 안 함',
    failTitle: '기록하지 못했습니다',
    mine: `입력 변경 커밋 ${String(pend.length)}개 「분석 안 함」`,
    request: () => ({ updatedAt: project.updatedAt, commits: pend.map((c) => c.sha) }),
    run: ({ payload, idempotencyKey }) => client.call('skipInputs', { body: payload, idempotencyKey }),
    onSuccess: refresh,
    successNotice: '변경 커밋을 「확인함 · 분석 안 함」으로 남겼습니다. 다음 분석 때 이 변경도 함께 비교됩니다.',
    onRejected: refresh,
    onConflictReload: refresh,
    onConflictReapply: async () => {
      const p = await latest();
      await client.call('skipInputs', { body: { updatedAt: p.updatedAt, commits: p.changeCommits.filter((c) => c.state === 'pending').map((c) => c.sha) } });
      refresh();
    },
  });
  const retry = useSave<unknown, { updatedAt: string; version: number }>({
    target: '차이 분석 다시 시도',
    failTitle: '다시 시도를 요청하지 못했습니다',
    request: () => ({ updatedAt: project.updatedAt, version: job?.version ?? 0 }),
    run: ({ payload, idempotencyKey }) => client.call('retryInputs', { body: payload, idempotencyKey }),
    onSuccess: refresh,
    successNotice: '차이 분석을 실패한 단계부터 다시 시도합니다.',
    onRejected: refresh,
    onConflictReload: refresh,
    onConflictReapply: async () => { const p = await latest(); await client.call('retryInputs', { body: { updatedAt: p.updatedAt, version: p.inputJob?.version ?? 0 } }); refresh(); },
  });
  const recheck = useSave<ResponseOf<'recheckInputs'>, { updatedAt: string }>({
    target: '입력 이력 복구 확인',
    failTitle: '입력 확인을 다시 요청하지 못했습니다',
    request: () => ({ updatedAt: project.updatedAt }),
    run: ({ payload, idempotencyKey }) => client.call('recheckInputs', { body: payload, idempotencyKey }),
    onSuccess: (res) => { notify(`입력 확인을 다시 요청했습니다 (${String(res.inputRecheck)}번째). Runner가 main 이력을 다시 확인해 연결이 맞으면 경고가 풀립니다.`); refresh(); },
    onRejected: refresh,
    onConflictReload: refresh,
    onConflictReapply: async () => { const p = await latest(); await client.call('recheckInputs', { body: { updatedAt: p.updatedAt } }); refresh(); },
  });
  const busyAny = analyze.busy || skip.busy;

  const cols = '50px 148px 84px minmax(200px,1.4fr) minmax(160px,1fr) minmax(150px,1fr) 84px';
  return (
    <section className="card" aria-labelledby="in-h">
      <div className="dp-h"><h2 id="in-h">입력 자료 · 저장소 <span className="tag">GitHub</span></h2></div>
      {ghBad && <div className="banner danger"><div className="banner-b">GitHub 인증 실패 — 입력 변경 확인이 멈춰 있습니다. 설정 → Runner · 실행 환경 → GitHub 연결을 확인하세요.</div></div>}
      {rewritten && (
        <div className="banner danger" data-testid="rewrite-alert">
          <div className="banner-b">
            <b>입력 이력 재작성 감지</b> — {rewritten.text}
            <div style={{ marginTop: 4 }}>강제 push 등으로 바뀐 이력은 자동으로 받지 않고, 옛 입력 버전도 지우지 않습니다. owner가 정상 merge · 복원 커밋으로 마지막 입력 커밋을 새 main의 조상으로 되돌린 뒤 아래 버튼을 누르세요. Runner가 다시 확인해 연결이 맞으면 경고가 풀립니다.</div>
            <div className="msg-acts" style={{ marginTop: 6 }}><BusyButton small busy={recheck.busy} busyLabel="요청 중…" onClick={() => { void recheck.save(); }}>복구 확인 · 입력 확인 다시 시도</BusyButton></div>
          </div>
          {recheck.conflictModal}
        </div>
      )}
      <div className="kv" style={{ gridTemplateColumns: '130px minmax(0,1fr)', margin: '0 0 10px' }}>
        <span className="kv-l">저장소</span><span className="kv-v mono">{project.repo.url}</span>
        <span className="kv-l">브랜치 · 기준</span><span className="kv-v mono">{project.repo.owner}/{project.repo.name} · {project.repo.branch} · 초기화 기준 커밋 {shortSha(project.repo.baseCommit)}</span>
        <span className="kv-l">현재 입력</span><span className="kv-v"><span className="mono">v{last?.v ?? '—'} · main @ {shortSha(last?.commit)}</span> <span className="muted">· {(last?.mdList ?? []).join(' · ')}</span></span>
        <span className="kv-l">등록</span><span className="kv-v">{formatDateTime(project.registeredAt)} · 팀장 · <span className="mono">초기화 번호 {project.epoch}</span></span>
        <span className="kv-l">등록 시 팀장 지시</span><span className="kv-v" style={{ whiteSpace: 'pre-wrap' }}>{project.instruction || '—'}</span>
      </div>
      {pend.length > 0 ? (
        <div className="in-pend" data-testid="input-pending">
          {restoreOffer}
          <div className="dec-h"><b>입력 자료 변경 감지</b><span className="sc sc-warn">팀장 확인 대기</span><span className="sp" /><span className="muted" style={{ fontSize: 12 }}>Runner가 main을 주기적으로 확인 (src/ 등 입력 외 경로 변경은 무시)</span></div>
          <p className="dec-p">분석하지 않은 입력 변경 커밋 {pend.length}개 — 파일 {files.length}개 (프로토타입 {files.filter((f) => f.area === '프로토타입').length} · 설계 문서 {files.filter((f) => f.area === '설계 문서').length})</p>
          <div className="gtb" style={{ margin: '8px 0' }} role="table" aria-label="변경 커밋">{pend.map((c) => <div key={c.sha} className="gtr" role="row" style={{ gridTemplateColumns: '80px 148px minmax(200px,1fr) 150px', minWidth: 0 }}><span className="gc mono" role="cell"><b>{shortSha(c.sha)}</b></span><span className="gc mono" role="cell">{formatDateTime(c.at)}</span><span className="gc" role="cell">{c.message}</span><span className="gc muted" role="cell">{c.author} · 파일 {c.files.length}</span></div>)}</div>
          <div className="gtb" style={{ margin: '0 0 8px' }} role="table" aria-label="변경 파일">{files.map((f) => { const [c, l] = CHANGE_CHIP[f.change] ?? ['sc sc-none', f.change]; return <div key={f.path} className="gtr" role="row" style={{ gridTemplateColumns: '90px minmax(220px,1fr) 60px 90px', minWidth: 0 }}><span className="gc" role="cell">{f.area}</span><span className="gc mono" role="cell">{f.path}</span><span className="gc" role="cell"><span className={c}>{l}</span></span><span className="gc mono muted" role="cell">{lines(f.added, f.deleted)}</span></div>; })}</div>
          <div className="frow"><label className="flabel" htmlFor="in-instr">팀장 지시</label><div className="fctl"><textarea id="in-instr" className="inp" rows={2} placeholder="선택 — 예: 이미 완료된 화면은 재작업보다 수정 Task로 분리해줘" value={instr} onChange={(e) => { setInstr(e.target.value); }} /></div></div>
          <div className="form-acts"><span className="muted" style={{ marginRight: 'auto' }}>{jobRunning ? '진행 중인 차이 분석이 있습니다. 끝난 뒤 분석할 수 있습니다.' : '분석하면 최신 커밋을 새 입력 버전으로 고정하고, Planning이 이전 버전과의 차이로 Task 추가 · 수정 · 재작업 · 취소를 Change Proposal로 올립니다.'}</span>
            <BusyButton variant="default" busy={skip.busy} busyLabel="기록 중…" disabled={busyAny} onClick={() => { void skip.save(); }}>분석 안 함</BusyButton>
            <BusyButton busy={analyze.busy} busyLabel="고정 · 분석 시작 중…" disabled={busyAny || jobRunning} onClick={() => { void analyze.save(); }}>이 버전으로 분석</BusyButton>
          </div>
        </div>
      ) : (
        <p className="fhint" style={{ margin: '0 0 10px' }} data-testid="input-none">새 입력 변경 없음 — Runner가 main을 주기적으로 확인합니다 (src/ 등 입력 외 경로 변경은 무시). prototype/uiux/ 또는 prototype/docs/ 를 바꿔 main에 push하면 여기에 나타나고, 팀장이 확인한 뒤 분석합니다.{skipped.length > 0 && ` 확인함 · 분석 안 함 ${String(skipped.length)}개 — 다음 분석 때 함께 비교.`}</p>
      )}
      <div className="gtb" style={{ margin: 0 }} role="table" aria-label="입력 자료 버전">
        <div className="gtr h" role="row" style={{ gridTemplateColumns: cols, minWidth: 0 }}><span className="gc" role="columnheader">버전</span><span className="gc" role="columnheader">고정</span><span className="gc" role="columnheader">커밋</span><span className="gc" role="columnheader">변경 파일</span><span className="gc" role="columnheader">팀장 지시</span><span className="gc" role="columnheader">분석 결과</span><span className="gc" role="columnheader">출처 Task</span></div>
        {[...project.inputs].reverse().map((x) => (
          <div key={x.v} className="gtr" role="row" style={{ gridTemplateColumns: cols, minWidth: 0 }}>
            <span className="gc" role="cell"><b>v{x.v}</b></span><span className="gc mono" role="cell">{formatDateTime(x.at)}</span><span className="gc mono" role="cell">{shortSha(x.commit)}</span>
            <span className="gc" role="cell"><span>{x.changes.length ? `변경 ${String(x.changes.length)}개 — ${x.changes.map((f) => f.path).slice(0, 3).join(', ')}${x.changes.length > 3 ? ' 외' : ''}` : '최초 — prototype/'}</span><br /><span className="muted">md {x.mdList.length}개</span></span>
            <span className="gc" role="cell">{x.instruction || '—'}</span><span className="gc" role="cell">{x.result ?? '—'}</span>
            {/* 출처 Task 수: 누르면 그 입력 버전으로 거른 현재 WBS(UAT-PROJECT-09 b). 필터 적용은 WBS 화면(M3-02)이 srcV로 한다. */}
            <span className="gc mono" role="cell"><Link className="tlink" to={`/wbs?srcV=${String(x.v)}`} aria-label={`v${String(x.v)} 출처 Task ${String(x.taskCount)}건 WBS에서 보기`}>{x.taskCount}건</Link></span>
          </div>
        ))}
      </div>
      {job && (
        <div className="bsteps" style={{ marginTop: 10 }} data-testid="input-job"><b>입력 자료 v{job.version} 차이 분석</b>
          {job.steps.map((s, i) => { const [c, sl] = STEP_CHIP[s.status as StepStatus]; const key = String(s.key); return <div key={key} className="bs-row" data-step={key}><span className="bs-n">{i + 1}</span><span>{INPUT_STEPS[key]?.[0] ?? key}</span><span className={c}>{sl}</span>{s.note && <span className="muted">{s.note}</span>}</div>; })}
          {job.proposalId && <Link className="btn ghost sm" to={`/change?cp=${job.proposalId}`}>Change Proposal 보기</Link>}
          {job.fail && <div className="banner danger" style={{ margin: '6px 0 0' }}><div className="banner-b">{(INPUT_STEPS[String(job.steps.find((s) => s.status === 'fail')?.key ?? '')]?.[0] ?? '차이 분석')} 실패 — {job.fail.reason} {job.fail.fix} <BusyButton small busy={retry.busy} busyLabel="요청 중…" onClick={() => { void retry.save(); }}>다시 시도</BusyButton></div></div>}
        </div>
      )}
      <RepoLayout cols="140px minmax(200px,1.4fr) minmax(160px,1fr)" margin="10px 0 0" />
      {analyze.conflictModal}{skip.conflictModal}{retry.conflictModal}
    </section>
  );
}
