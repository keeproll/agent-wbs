/**
 * UI-02A 프로젝트 등록(P L703–748). 등록 전(state=none)에 프로젝트 메뉴가 이 화면이다.
 *
 * 흐름: 입력 → 「저장소 접근 확인」(POST repo-checks → Runner 결과를 GET으로 기다림) → 「등록 · 초기 분석 시작」(POST /api/project).
 * - 기술 제약 행은 배열 위치가 아니라 행마다 만든 안정 키(key)로 고치고 지운다. 왜: 중간 행을 지우면 위치가 밀려 다른 행을 고치게 된다.
 * - 저장소 확인은 그 주소에 대해서만 유효하다. 주소를 바꾸면 확인 결과를 버린다(원본 setReg와 같다).
 * - 등록 요청은 useSave(멱등 키·성공 비교), 입력은 편집 보호·세션 초안으로 지킨다.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import type { ApiError } from '../../shared/api/client.ts';
import type { ResponseOf } from '../../shared/api/contract.ts';
import { apiKey, invalidateTopics, useApiQuery } from '../../shared/api/queries.ts';
import { useDocumentTitle } from '../../shared/layout/Page.tsx';
import { useEditGuard } from '../../shared/state/useEditGuard.ts';
import { useSave } from '../../shared/state/useSave.tsx';
import { useSessionDraft } from '../../shared/state/useSessionDraft.tsx';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { formatDateTime } from '../../shared/format.ts';
import { CleanupBanner, ResetHistory } from './ResetHistory.tsx';
import { useGithubSettings, type GithubSettingsView } from './github.ts';
import { LEVELS, REPO_LAYOUT, SAMPLE, shortSha, type Level, type ProjectState } from './labels.ts';

interface TechRow { key: string; name: string; level: Level; cond: string }
export interface RegisterForm { name: string; url: string; target: string; instr: string; tech: TechRow[] }

const EMPTY: RegisterForm = { name: '', url: '', target: '', instr: '', tech: [] };
const newKey = () => crypto.randomUUID();
type RepoCheck = ResponseOf<'getRepoCheck'>;
const FINISHED = ['done', 'failed'];

/** 서버보다 먼저 알려 줄 수 있는 주소 문제(P checkGh L3746–3749 문구). 나머지 형식 검사는 서버 400이 한다. */
export function urlProblem(raw: string): string {
  const u = raw.trim();
  if (!u) return 'GitHub 저장소 주소를 입력하세요 — 예: https://github.com/owner/repo';
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+\/.+/.test(u.replace(/\/$/, ''))) {
    return '저장소 주소까지만 입력하세요 — 브랜치 · 폴더 · 파일 주소(/tree/…, /blob/…)는 받지 않습니다. 예: https://github.com/owner/repo';
  }
  return '';
}

/** 필수 구조 표(P checkGh st). 개수는 Runner 보고 값을 그대로 쓴다(MM-27: 고정 숫자 없음). */
export function structureRows(check: RepoCheck): { p: string; c: string; l: string; t: string }[] {
  const s = check.structure;
  if (!s) return [];
  const md = s.docs.filter((p) => p.startsWith('prototype/docs/') && p.toLowerCase().endsWith('.md'));
  const uiuxOk = s.uiux && s.uiuxFiles > 0;
  const opt = (has: boolean, p: string, missing: string) => ({ p, c: has ? 'sc sc-ok' : 'sc sc-none', l: has ? '확인' : '없음', t: has ? '있음' : missing });
  return [
    { p: 'prototype/uiux/', c: uiuxOk ? 'sc sc-ok' : 'sc sc-bad', l: uiuxOk ? '확인' : '없음', t: uiuxOk ? `파일 ${String(s.uiuxFiles)}개` : '프로토타입 폴더가 없습니다 — 압축 해제 상태로 prototype/uiux/ 에 두고 push하세요 (zip 불가)' },
    { p: 'prototype/docs/', c: md.length ? 'sc sc-ok' : 'sc sc-bad', l: md.length ? '확인' : '없음', t: md.length ? `md ${String(md.length)}개` : 'md 파일이 없습니다 — prototype/docs/ 에 설계 의도 · 구현 가이드 md를 1개 이상 두세요' },
    opt(s.src, 'src/', '첫 커밋에서 생성합니다'),
    opt(s.contracts, 'contracts/', '계약 설계 Task가 생성합니다'),
    opt(s.agentwbs, '.agentwbs/', '첫 커밋에서 생성합니다 (pipeline.yaml)'),
  ];
}

/** GitHub 인증 한 줄(P setupVM ghL). 권한 하나라도 missing이면 정상으로 보이지 않는다(MM-12). */
function githubLine(gh: GithubSettingsView | undefined, failed: boolean): { ok: boolean; text: string; missing: string[] } {
  if (!gh) return { ok: false, text: failed ? 'GitHub 연결 상태를 확인하지 못했습니다 — 설정에서 확인하세요' : 'GitHub 연결 상태 확인 중…', missing: [] };
  const missing = gh.scopes ? Object.entries(gh.scopes).filter(([, v]) => v === 'missing').map(([k]) => k) : [];
  const connected = gh.mode === 'gh' ? !!gh.account : gh.tokenSet;
  if (!connected) return { ok: false, text: 'GitHub 인증 없음 — 설정에서 연결하세요', missing };
  const who = gh.mode === 'gh' ? `gh 로그인 · ${gh.account ?? ''}` : `토큰${gh.expiresAt ? ` · 만료 ${formatDateTime(gh.expiresAt).slice(0, 10)}` : ''}`;
  if (missing.length) return { ok: false, text: `GitHub 인증: ${who} — 권한 부족: ${missing.join(', ')}`, missing };
  return { ok: true, text: `GitHub 인증: ${who}${gh.warning ? ` — ${gh.warning}` : ''}`, missing };
}

export function RegisterView({ project }: { project: ProjectState }) {
  useDocumentTitle('프로젝트 등록');
  const { client } = useApi();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<RegisterForm>(EMPTY);
  const [checkId, setCheckId] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [urlErr, setUrlErr] = useState('');
  const runner = useApiQuery('getRunnerState', {}, { topics: ['runner'] });
  const github = useGithubSettings();
  const gh = githubLine(github.data, github.isError);

  const check = useQuery<RepoCheck, ApiError>({
    queryKey: apiKey('getRepoCheck', { params: { id: checkId ?? '' } }),
    queryFn: ({ signal }) => client.call('getRepoCheck', { params: { id: checkId ?? '' }, signal }),
    enabled: checkId !== null,
    // Runner 결과가 올 때까지 1.5초마다 다시 읽는다. 끝나면(done·failed) 멈춘다.
    refetchInterval: (q) => (q.state.data && FINISHED.includes(q.state.data.status) ? false : 1_500),
  });
  const result = checkId !== null ? check.data : undefined;
  const finished = !!result && FINISHED.includes(result.status);
  const waiting = checkId !== null && !finished;

  const dirty = JSON.stringify(form) !== JSON.stringify(EMPTY);
  useEditGuard(dirty);
  const { restoreOffer } = useSessionDraft<RegisterForm>({
    id: 'project:register', label: '프로젝트 등록 입력', value: dirty ? form : null,
    onRestore: (data) => { setForm(data); setCheckId(null); },
  });

  const patch = (p: Partial<RegisterForm>) => {
    setForm((f) => ({ ...f, ...p }));
    setErr('');
    if ('url' in p) { setCheckId(null); setUrlErr(''); }
  };
  const patchTech = (key: string, p: Partial<TechRow>) => { setForm((f) => ({ ...f, tech: f.tech.map((t) => (t.key === key ? { ...t, ...p } : t)) })); setErr(''); };
  const delTech = (key: string) => { setForm((f) => ({ ...f, tech: f.tech.filter((t) => t.key !== key) })); };
  const addTech = () => { setForm((f) => ({ ...f, tech: [...f.tech, { key: newKey(), name: '', level: 'must', cond: '' }] })); };
  const sample = () => {
    setForm({ name: SAMPLE.name, url: SAMPLE.url, target: SAMPLE.target, instr: SAMPLE.instr, tech: SAMPLE.tech.map((t) => ({ ...t, key: newKey() })) });
    setCheckId(null); setErr(''); setUrlErr('');
  };

  const online = runner.data?.connection.online;
  const blocked = project.cleanup !== 'none';

  const repoCheck = useSave<ResponseOf<'createRepoCheck'>, { url: string }>({
    target: '저장소 접근 확인',
    failTitle: '저장소 확인을 요청하지 못했습니다',
    request: () => ({ url: form.url.trim() }),
    run: ({ payload, idempotencyKey }) => client.call('createRepoCheck', { body: payload, idempotencyKey }),
    onSuccess: (res, payload) => { if (form.url.trim() === payload.url) setCheckId(res.id); },
    onFieldErrors: (errors) => { setUrlErr(errors.map((e) => e.message).join(' · ')); },
  });
  const startCheck = () => {
    const problem = urlProblem(form.url);
    if (problem) { setUrlErr(problem); return; }
    if (blocked) { setErr('이전 초기화의 Runner 정리가 끝나야 저장소를 확인할 수 있습니다 — Runner를 연결하세요.'); return; }
    if (online === false) { setErr('Runner가 연결되어 있지 않아 저장소를 확인할 수 없습니다. Runner를 연결하세요.'); return; }
    setErr(''); setUrlErr('');
    void repoCheck.save();
  };

  type CreateBody = Parameters<typeof client.call<'createProject'>>[1]['body'];
  const register = useSave<ResponseOf<'createProject'>, CreateBody>({
    target: '프로젝트 등록',
    failTitle: '등록하지 못했습니다',
    request: () => ({
      name: form.name.trim(),
      url: form.url.trim(),
      ...(form.target ? { targetDate: form.target } : {}),
      instruction: form.instr.trim(),
      repoCheckId: checkId ?? '',
      constraints: form.tech.filter((t) => t.name.trim()).map((t) => (t.level === 'cond'
        ? { name: t.name.trim(), level: 'cond' as const, condition: t.cond.trim() }
        : { name: t.name.trim(), level: t.level })),
    }),
    run: ({ payload, idempotencyKey }) => client.call('createProject', { body: payload, idempotencyKey }),
    onSuccess: () => {
      setForm(EMPTY);
      void invalidateTopics(queryClient, ['project']);
    },
    successNotice: '프로젝트를 등록했습니다. Runner가 초기 분석을 시작합니다.',
    onRejected: () => { void invalidateTopics(queryClient, ['project']); },
  });
  const submit = () => {
    const name = form.name.trim();
    const condMissing = form.tech.some((t) => t.name.trim() && t.level === 'cond' && !t.cond.trim());
    const e = !name ? '프로젝트 이름을 입력하세요.'
      : checkId === null ? '먼저 「저장소 접근 확인」을 실행하세요.'
        : !finished ? '저장소 접근 확인이 아직 끝나지 않았습니다. Runner 결과를 기다리세요.'
          : result.status !== 'done' ? `저장소 확인에 실패했습니다 — ${result.error ?? ''}`
            : gh.missing.length ? `필수 GitHub 권한이 없어 등록할 수 없습니다 — ${gh.missing.join(', ')}`
              : form.target && !/^\d{4}-\d{2}-\d{2}$/.test(form.target) ? '목표일은 YYYY-MM-DD 형식입니다.'
                : condMissing ? '조건부 선호에는 조건 문장을 함께 적어야 합니다.' : '';
    if (e) { setErr(e); return; }
    void register.save();
  };

  const rows = result && finished ? structureRows(result) : [];
  const md = result?.structure?.docs.filter((p) => p.startsWith('prototype/docs/')) ?? [];

  return (
    <div className="page scroll">
      <CleanupBanner project={project} />
      <div className="page-h"><div><h1>프로젝트 등록</h1><p className="page-sub">등록된 프로젝트가 없습니다. 프로젝트는 하나만 등록되며, 등록하면 Runner가 입력 자료를 분석해 초기 WBS 초안을 만듭니다 — 팀장이 한 번 승인하면 시작합니다.</p></div></div>
      {restoreOffer}
      <div className="cmp" style={{ gridTemplateColumns: 'minmax(0,1.5fr) minmax(0,1fr)' }}>
        <section className="card" aria-labelledby="reg-h">
          <div className="dp-h"><h2 id="reg-h">등록 정보</h2><button type="button" className="reflink" onClick={sample}>예시 값 채우기</button></div>
          <div className="form">
            <div className="frow"><label className="flabel" htmlFor="reg-name">프로젝트 이름 <span className="req">*</span></label><div className="fctl"><input id="reg-name" className="inp" value={form.name} onChange={(e) => { patch({ name: e.target.value }); }} placeholder="예: Verum-SDN Agent WBS — Self Development" /></div></div>
            <div className="frow"><label className="flabel" htmlFor="reg-url">GitHub 저장소 <span className="req">*</span></label><div className="fctl">
              <input id="reg-url" className="inp mono-in" value={form.url} onChange={(e) => { patch({ url: e.target.value }); }} placeholder="https://github.com/owner/repo" aria-invalid={urlErr ? true : undefined} aria-describedby={urlErr ? 'reg-url-err' : undefined} />
              {urlErr && <span id="reg-url-err" className="ferr">{urlErr}</span>}
              <span className="ckl" data-testid="gh-line"><span className={gh.ok ? 'sc sc-ok' : 'sc sc-bad'}>인증</span> {gh.text} <Link className="reflink" to="/settings/runner">GitHub 연결 설정</Link></span>
              {checkId !== null && (
                <span className="ckl" data-testid="check-line">
                  {result && finished
                    ? <><span className={result.status === 'done' ? 'sc sc-ok' : 'sc sc-bad'}>{result.status === 'done' ? '접근 확인' : '실패'}</span> {result.status === 'done' ? `${result.private ? 'private' : 'public'} · main @ ${shortSha(result.commit)}` : result.error}</>
                    : <><span className="sc sc-warn">확인 중</span> {online === false ? 'Runner 연결 대기 — Runner가 연결되면 확인합니다' : 'Runner가 저장소를 확인하고 있습니다'}</>}
                </span>
              )}
              {rows.length > 0 && (
                <div className="gtb" style={{ margin: '4px 0 0' }} role="table" aria-label="필수 구조">
                  {rows.map((x) => <div key={x.p} className="gtr" role="row" style={{ gridTemplateColumns: '120px 52px minmax(0,1fr)', minWidth: 0 }}><span className="gc mono" role="cell"><b>{x.p}</b></span><span className="gc" role="cell"><span className={x.c}>{x.l}</span></span><span className="gc" role="cell">{x.t}</span></div>)}
                </div>
              )}
              {finished && md.length > 0 && <span className="fhint">설계 문서: {md.map((m) => <span key={m} className="mono">{m} </span>)}</span>}
              <span className="fhint">저장소 주소까지만 입력합니다(브랜치 · 폴더 주소 불가). 기준 브랜치는 <b>main</b>. Runner가 접근 권한과 필수 구조를 확인하고, 등록 시점 main 커밋을 입력 v1로 고정합니다.</span>
              <RepoLayout cols="148px minmax(160px,1.4fr) minmax(140px,1fr)" margin="2px 0 0" />
            </div></div>
            <div className="frow"><label className="flabel" htmlFor="reg-target">목표일</label><div className="fctl"><input id="reg-target" className="inp" type="date" value={form.target} onChange={(e) => { patch({ target: e.target.value }); }} style={{ width: 170 }} /></div></div>
            <div className="frow"><span className="flabel">기술 제약</span><div className="fctl" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
              {form.tech.map((t) => (
                <div key={t.key} className="tech-row" data-testid="tech-row">
                  <input className="inp" value={t.name} onChange={(e) => { patchTech(t.key, { name: e.target.value }); }} placeholder="예: PostgreSQL 16" aria-label="기술" />
                  <div className="seg" role="group" aria-label="수준">{LEVELS.map(([lv, l]) => <button key={lv} type="button" aria-pressed={t.level === lv} onClick={() => { patchTech(t.key, { level: lv }); }}>{l}</button>)}</div>
                  <span className="tr-c">{t.level === 'cond' && <input className="inp" value={t.cond} onChange={(e) => { patchTech(t.key, { cond: e.target.value }); }} placeholder="조건 — 예: 시계열 데이터가 있으면" aria-label="조건" title={t.cond} />}</span>
                  <button type="button" className="btn ghost sm" onClick={() => { delTech(t.key); }} aria-label={`${t.name || '기술 제약'} 삭제`}>삭제</button>
                </div>
              ))}
              <div><button type="button" className="btn sm" onClick={addTech}>+ 기술 제약 추가</button></div>
              <span className="fhint">이미 정한 것만 적습니다 — <b>필수</b>(무조건 사용) · <b>조건부 선호</b>(조건이 맞으면 반드시 이것) · <b>금지</b>. 적지 않은 것(저장소 추가 · 통신 방식 · 메시지 형식 등)은 Planning Agent가 프로토타입을 분석해 근거와 대안을 붙여 제안하고, 초기 분석의 「기술 결정 확정」 단계에서 팀장이 따로 승인합니다.</span>
            </div></div>
            <div className="frow"><label className="flabel" htmlFor="reg-instr">팀장 지시</label><div className="fctl"><textarea id="reg-instr" className="inp" rows={3} value={form.instr} onChange={(e) => { patch({ instr: e.target.value }); }} placeholder="예: prototype/uiux/ 와 prototype/docs/ 설계 문서를 분석하고 Task 식별을 시작하자. 보고서 화면은 나중에." /><span className="fhint">자유 문장으로 씁니다. 저장소는 위 칸에서 확인된 값을 쓰고, 이 문장은 분석 범위 · 우선순위 같은 지시로 Planning Agent에게 전달됩니다.</span></div></div>
            {err && <div className="banner danger" data-testid="reg-err"><div className="banner-b">{err}</div></div>}
            <div className="form-acts">
              <span className="muted" style={{ marginRight: 'auto' }}>{result && finished ? `Runner 확인 ${formatDateTime(check.dataUpdatedAt)}` : ''}</span>
              <BusyButton variant="default" busy={repoCheck.busy || waiting} busyLabel="Runner 확인 중…" disabled={register.busy} onClick={startCheck}>저장소 접근 확인</BusyButton>
              <BusyButton busy={register.busy} busyLabel="등록 중…" disabled={repoCheck.busy} onClick={submit}>등록 · 초기 분석 시작</BusyButton>
            </div>
          </div>
        </section>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <section className="card" style={{ margin: 0 }}>
            <div className="dp-h"><h2>등록 후 진행</h2></div>
            <ol className="lst" style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
              <li>Runner가 GitHub 접근 확인 · main 커밋 고정 → prototype/ (uiux · docs) checkout(읽기 전용) → 작업 준비</li>
              <li>Codex · Claude 독립 분석 → 교차 검토 · 이견 조정</li>
              <li>WBS 초안 (Phase · Work Package · Task 명세 · 작업량 · 실행 등급)</li>
              <li><b>팀장 승인 1회</b> → 기준 일정 v1 → 선행 조건 없는 Task부터 실행</li>
            </ol>
            <p className="fhint" style={{ margin: '8px 0 0' }}>프로토타입 · 설계 문서가 바뀌면 GitHub main에 push합니다. Runner가 변경 커밋을 감지해 알리고, 팀장이 확인한 뒤 「이 버전으로 분석」하면 차이만 분석해 Change Proposal로 반영합니다.</p>
          </section>
          <ResetHistory />
        </div>
      </div>
    </div>
  );
}

/** 「저장소 디렉토리 규칙」 접이식 표(P L719·L2027) */
export function RepoLayout({ cols, margin }: { cols: string; margin: string }) {
  return (
    <details className="rp-sent" style={{ margin }}>
      <summary>저장소 디렉토리 규칙</summary>
      <div className="gtb" style={{ margin: '6px 0 0' }}>
        {REPO_LAYOUT.map(([p, d, r]) => <div key={p} className="gtr" style={{ gridTemplateColumns: cols, minWidth: 0 }}><span className="gc mono"><b>{p}</b></span><span className="gc">{d}</span><span className="gc muted">{r}</span></div>)}
      </div>
    </details>
  );
}
