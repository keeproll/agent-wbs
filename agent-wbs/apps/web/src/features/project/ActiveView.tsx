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
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import type { ResponseOf } from '../../shared/api/contract.ts';
import { apiKey, invalidateTopics, useApiQuery } from '../../shared/api/queries.ts';
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
import { useProjectReload } from './reload.ts';
import { ResetModal } from './ResetModal.tsx';
import { LINK } from '../../shared/links.ts';

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
  // 한 화면에 편집 보호(useBlocker)는 하나만 둘 수 있다. 두 카드의 「입력 중」을 합쳐 한 번만 건다(M3-04 b7d57fa와 같은 규칙).
  const [inputsDirty, setInputsDirty] = useState(false);
  const [infoDirty, setInfoDirty] = useState(false);
  useEditGuard(inputsDirty || infoDirty);
  return (
    <div className="page scroll">
      <div className="page-h"><div><h1>프로젝트</h1><p className="page-sub">프로젝트 정보 · 입력 자료 · 상태 · WBS 구조 · Agent 참여 현황 — 프로젝트는 하나만 등록되며, 처음부터 다시 시작하려면 「프로젝트 초기화」</p></div></div>
      <InputsCard project={project} onDirty={setInputsDirty} />
      <ProjectInfoCard project={project} onDirty={setInfoDirty} />
      <section className="card danger-zone" aria-labelledby="pj-reset-h">
        <div className="dp-h"><h2 id="pj-reset-h">프로젝트 초기화</h2><button type="button" className="btn danger" onClick={() => { setResetOpen(true); }}>프로젝트 초기화…</button></div>
        <p className="fhint" style={{ margin: 0 }}>진행 중인 모든 작업을 중지하고, 지금까지의 기록 · 결과 · 산출물을 <b>모두 삭제</b>합니다. Agent WBS와 Runner는 프로젝트 등록 전 상태로 돌아가고, 작업 저장소는 등록 시점 기준 커밋으로 되돌아갑니다. 삭제된 내용은 복구할 수 없습니다. 입력 자료(prototype/ (uiux · docs))와 등록 이전부터 저장소에 있던 코드는 삭제하지 않습니다.</p>
      </section>
      {resetOpen && <ResetModal project={project} onClose={() => { setResetOpen(false); }} />}
    </div>
  );
}

/** 날짜 칸 형식(원본 P pj.dateErr: YYYY-MM-DD) */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
interface InfoForm { name: string; description: string; startDate: string; targetDate: string }
const infoOf = (p: Active): InfoForm => ({ name: p.name, description: p.description, startDate: p.startDate, targetDate: p.targetDate ?? '' });
/** 저장 전 검사(원본 P L2056 문구). 이름·시작일 필수, 날짜는 YYYY-MM-DD. */
export function infoProblem(f: InfoForm): string | null {
  if (!f.name.trim()) return '이름을 입력하세요.';
  if (!DATE_RE.test(f.startDate.trim()) || (f.targetDate.trim() !== '' && !DATE_RE.test(f.targetDate.trim()))) {
    return '시작일은 필수이며, 날짜는 YYYY-MM-DD 형식이어야 합니다. 시작일을 바꾸면 전체 계획 일정이 다시 계산됩니다.';
  }
  return null;
}

/**
 * 프로젝트 정보 읽기·편집(UI-02, 원본 P L2030–2058, UAT-PROJECT-10). 서버 후속 2차의 PATCH /api/project(updateProject)에 연결했다(M3 통합).
 * - 저장은 공통 useSave: 버튼 「저장 중…」, 실패 시 입력 유지·오류 막대, 400은 칸 아래, 409는 충돌 창.
 * - 날짜를 바꾸면 서버가 같은 트랜잭션에서 일정을 다시 계산하고, 정책 임계를 넘으면 새 기준을 추가한다(원래 v1은 보존). 화면은 응답으로 다시 그린다.
 * - 상태(원본의 상태 버튼)는 편집하지 않는다. 계약 본문에 없고, 상태는 등록·승인·초기화 흐름이 정한다.
 */
function ProjectInfoCard({ project, onDirty }: { project: Active; onDirty: (dirty: boolean) => void }) {
  const { client } = useApi();
  const queryClient = useQueryClient();
  const reloadProject = useProjectReload();
  const [form, setForm] = useState<InfoForm | null>(null);
  const [show, setShow] = useState(false);
  const editing = form !== null;
  const dirty = editing && JSON.stringify(form) !== JSON.stringify(infoOf(project));
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  const { restoreOffer } = useSessionDraft<InfoForm>({
    id: 'project:info', label: '프로젝트 정보 편집', value: dirty ? form : null,
    onRestore: (data) => { setForm(data); },
  });
  const problem = form ? infoProblem(form) : null;
  interface InfoBody { updatedAt: string; name: string; description: string; startDate: string; targetDate: string | null }
  const bodyOf = (updatedAt: string, f: InfoForm): InfoBody => ({
    updatedAt, name: f.name.trim(), description: f.description.trim(), startDate: f.startDate.trim(), targetDate: f.targetDate.trim() || null,
  });
  const save = useSave<ProjectState, InfoBody>({
    target: '프로젝트 정보 저장',
    failTitle: '저장하지 못했습니다',
    mine: '프로젝트 정보 편집',
    request: () => bodyOf(project.updatedAt, form ?? infoOf(project)),
    run: ({ payload, idempotencyKey }) => client.call('updateProject', { body: payload, idempotencyKey }),
    onSuccess: (result, payload) => {
      queryClient.setQueryData(apiKey('getProject', {}), result);
      void invalidateTopics(queryClient, ['project', 'schedule']);
      // 저장한 내용과 지금 입력이 같을 때만 편집을 닫는다(그 사이 더 고쳤으면 이어서 편집).
      setForm((cur) => (cur && JSON.stringify(bodyOf(payload.updatedAt, cur)) === JSON.stringify(payload) ? null : cur));
      setShow(false);
    },
    successNotice: '프로젝트 정보를 저장했습니다.',
    onConflictReload: async ({ signal }) => { await reloadProject(signal); setForm(null); },
    // 다시 적용: 최신 버전 위에 내 입력을 그대로 보낸다(공통 reapplyRequest).
    reapplyRequest: async ({ signal }) => {
      const latest = await reloadProject(signal);
      if (!('updatedAt' in latest)) throw new Error('등록된 프로젝트가 없습니다.');
      return bodyOf(latest.updatedAt, form ?? infoOf(project));
    },
  });
  const submit = () => {
    setShow(true);
    if (problem) return;
    void save.save();
  };
  return (
    <section className="card" aria-labelledby="pj-info-h">
      {restoreOffer}
      <div className="dp-h"><h2 id="pj-info-h">프로젝트 정보</h2>{!editing && <button type="button" className="btn sm" onClick={() => { setForm(infoOf(project)); setShow(false); }}>편집</button>}</div>
      {!editing ? (
        <>
          <div className="kv" style={{ gridTemplateColumns: '110px minmax(0,1fr)' }}>
            <span className="kv-l">프로젝트 ID</span><span className="kv-v mono">{project.id}</span>
            <span className="kv-l">이름</span><span className="kv-v">{project.name}</span>
            <span className="kv-l">상태</span><span className="kv-v"><span className="tag">진행 중</span></span>
            <span className="kv-l">기간</span><span className="kv-v mono">{project.startDate} ~ {project.targetDate ?? '—'}</span>
            <span className="kv-l">초기 WBS 승인</span><span className="kv-v">{formatDateTime(project.approvedAt)} · Task {project.approvedTaskCount}건 · 기준 일정 v1</span>
          </div>
          {project.description && <p style={{ margin: 0, color: '#3E4651' }} data-testid="pj-desc">{project.description}</p>}
        </>
      ) : (
        <div className="form">
          <div className="frow"><label className="flabel" htmlFor="pj-n">이름<span className="req">필수</span></label><div className="fctl"><input id="pj-n" className="inp" value={form.name} onChange={(e) => { setForm({ ...form, name: e.target.value }); }} /></div></div>
          <div className="frow"><label className="flabel" htmlFor="pj-s">시작일<span className="req">필수</span></label><div className="fctl"><input id="pj-s" className="inp mono-in" style={{ maxWidth: 200 }} placeholder="YYYY-MM-DD" value={form.startDate} onChange={(e) => { setForm({ ...form, startDate: e.target.value }); }} /></div></div>
          <div className="frow"><label className="flabel" htmlFor="pj-t">목표일<span className="opt">선택</span></label><div className="fctl"><input id="pj-t" className="inp mono-in" style={{ maxWidth: 200 }} placeholder="YYYY-MM-DD" value={form.targetDate} onChange={(e) => { setForm({ ...form, targetDate: e.target.value }); }} /></div></div>
          {show && problem && <div className="frow"><span /><span className="ferr" role="alert">{problem}</span></div>}
          <div className="frow"><label className="flabel" htmlFor="pj-d">설명<span className="opt">선택</span></label><div className="fctl"><textarea id="pj-d" rows={3} className="inp" value={form.description} onChange={(e) => { setForm({ ...form, description: e.target.value }); }} /></div></div>
          <div className="form-acts">
            <button type="button" className="btn" disabled={save.busy} onClick={() => { setForm(null); setShow(false); }}>취소</button>
            <BusyButton busy={save.busy} busyLabel="저장 중…" disabled={show && !!problem} onClick={submit}>저장</BusyButton>
          </div>
        </div>
      )}
      {save.conflictModal}
    </section>
  );
}

function InputsCard({ project, onDirty }: { project: Active; onDirty: (dirty: boolean) => void }) {
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
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  const { restoreOffer } = useSessionDraft<{ instr: string }>({
    id: `project:inputs:${project.inputHead}`, label: '입력 변경 분석 지시', value: dirty ? { instr } : null,
    onRestore: (data) => { setInstr(data.instr); },
  });
  const refresh = () => { void invalidateTopics(queryClient, ['project', 'alert']); };
  const reloadProject = useProjectReload();
  /** 최신 프로젝트를 서버에서 읽는다(실패는 그대로 던진다). 충돌 창 「다시 적용」의 요청 내용을 만들 때 쓴다. */
  const latest = async (signal: AbortSignal) => {
    const p = await reloadProject(signal);
    if (!('changeCommits' in p)) throw new Error('등록된 프로젝트가 없습니다.');
    return p;
  };
  /** 충돌 창 「최신 내용 불러오기」: 실제로 읽혀야 성공이다. */
  const reload = async ({ signal }: { signal: AbortSignal }) => { await reloadProject(signal); };
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
    onConflictReload: reload,
    // 다시 적용도 공통 useSave가 같은 run·결과 미확인 보관함으로 보낸다(재리뷰 P2-1).
    reapplyRequest: async ({ signal }) => analyzeBody(await latest(signal)),
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
    onConflictReload: reload,
    reapplyRequest: async ({ signal }) => {
      const p = await latest(signal);
      return { updatedAt: p.updatedAt, commits: p.changeCommits.filter((c) => c.state === 'pending').map((c) => c.sha) };
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
    onConflictReload: reload,
    reapplyRequest: async ({ signal }) => { const p = await latest(signal); return { updatedAt: p.updatedAt, version: p.inputJob?.version ?? 0 }; },
  });
  const recheck = useSave<ResponseOf<'recheckInputs'>, { updatedAt: string }>({
    target: '입력 이력 복구 확인',
    failTitle: '입력 확인을 다시 요청하지 못했습니다',
    request: () => ({ updatedAt: project.updatedAt }),
    run: ({ payload, idempotencyKey }) => client.call('recheckInputs', { body: payload, idempotencyKey }),
    onSuccess: (res) => { notify(`입력 확인을 다시 요청했습니다 (${String(res.inputRecheck)}번째). Runner가 main 이력을 다시 확인해 연결이 맞으면 경고가 풀립니다.`); refresh(); },
    onRejected: refresh,
    onConflictReload: reload,
    reapplyRequest: async ({ signal }) => ({ updatedAt: (await latest(signal)).updatedAt }),
  });
  // 「지금 확인」(원본 P L1997 inp.fetch, UAT-PROJECT-09 b): 서버 후속 2차의 POST /api/project/inputs/check(checkInputs)에 연결(M3 통합).
  // 서버는 요청 번호만 올리고(202), 실제 확인 시각(inputCheckedAt)은 Runner가 main을 관측해 보고할 때 바뀐다. 그래서 요청 직후 시각을 꾸며 내지 않는다.
  const check = useSave<ResponseOf<'checkInputs'>, { updatedAt: string }>({
    target: '입력 자료 지금 확인',
    failTitle: '확인을 요청하지 못했습니다',
    request: () => ({ updatedAt: project.updatedAt }),
    run: ({ payload, idempotencyKey }) => client.call('checkInputs', { body: payload, idempotencyKey }),
    onSuccess: () => { notify('main 확인을 요청했습니다 — Runner가 확인해 보고하면 확인 시각과 변경 목록이 바뀝니다.'); refresh(); },
    onRejected: refresh,
    onConflictReload: reload,
    reapplyRequest: async ({ signal }) => ({ updatedAt: (await latest(signal)).updatedAt }),
  });
  const busyAny = analyze.busy || skip.busy;

  const cols = '50px 148px 84px minmax(200px,1.4fr) minmax(160px,1fr) minmax(150px,1fr) 84px';
  return (
    <section className="card" aria-labelledby="in-h">
      <div className="dp-h"><h2 id="in-h">입력 자료 · 저장소 <span className="tag">GitHub</span></h2>
        <BusyButton small variant="default" busy={check.busy} busyLabel="main 확인 중…" disabled={ghBad} title={ghBad ? 'GitHub 인증이 없어 확인할 수 없습니다 — 설정 → GitHub 연결을 확인하세요.' : undefined} onClick={() => { void check.save(); }}>지금 확인</BusyButton>
      </div>
      {github.isError && !gh && <div className="banner warn" data-testid="gh-unknown"><div className="banner-b">GitHub 연결 상태를 확인하지 못했습니다 — 입력 변경 확인이 멈췄는지 알 수 없습니다. 설정 → Runner · 실행 환경 → GitHub 연결을 확인하세요.</div></div>}
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
          <div className="dec-h"><b>입력 자료 변경 감지</b><span className="sc sc-warn">팀장 확인 대기</span><span className="sp" /><span className="muted" style={{ fontSize: 12 }}><DetectCheckedAt at={project.inputCheckedAt} /> · Runner가 main을 주기적으로 확인 (src/ 등 입력 외 경로 변경은 무시)</span></div>
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
        <p className="fhint" style={{ margin: '0 0 10px' }} data-testid="input-none">새 입력 변경 없음 — <DetectCheckedAt at={project.inputCheckedAt} /> · Runner가 main을 주기적으로 확인합니다 (src/ 등 입력 외 경로 변경은 무시). prototype/uiux/ 또는 prototype/docs/ 를 바꿔 main에 push하면 여기에 나타나고, 팀장이 확인한 뒤 분석합니다.{skipped.length > 0 && ` 확인함 · 분석 안 함 ${String(skipped.length)}개 — 다음 분석 때 함께 비교.`}</p>
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
          {job.proposalId && <Link className="btn ghost sm" to={LINK.change(job.proposalId)}>Change Proposal 보기</Link>}
          {job.fail && <div className="banner danger" style={{ margin: '6px 0 0' }}><div className="banner-b">{(INPUT_STEPS[String(job.steps.find((s) => s.status === 'fail')?.key ?? '')]?.[0] ?? '차이 분석')} 실패 — {job.fail.reason} {job.fail.fix} <BusyButton small busy={retry.busy} busyLabel="요청 중…" onClick={() => { void retry.save(); }}>다시 시도</BusyButton></div></div>}
        </div>
      )}
      <RepoLayout cols="140px minmax(200px,1.4fr) minmax(160px,1fr)" margin="10px 0 0" />
      {analyze.conflictModal}{skip.conflictModal}{retry.conflictModal}{check.conflictModal}
    </section>
  );
}

/**
 * 감지 확인 시각(UAT-PROJECT-09 b, 원본 P L6952 「Runner 확인 …」). 서버 후속 2차의 inputCheckedAt(Runner가 main을 마지막으로 관측한 시각)을 보인다.
 * 아직 관측 보고가 없으면 다른 시각으로 대신하지 않고 「확인 기록 없음」을 보인다.
 */
function DetectCheckedAt({ at }: { at: string | null }) {
  return <span data-testid="input-checked-at">{at ? `Runner 확인 ${formatDateTime(at)}` : 'Runner 확인 기록 없음'}</span>;
}
