/**
 * 설정 → Runner · 실행 환경 탭(UI-12-01, P L2257–2395).
 *
 * 원본과 다른 점(제품 결정):
 * - 「Mock」 버튼(인증 만료·복구·Codex 로그인 만료·조치 완료·사용량 한도·재부팅·PC 변경·출력 끊김 등)은 없다. 실제 Runner 보고로만 바뀐다(UAT-POLICY-05, D-17·D-23).
 * - Runner 연결 상태는 Runner heartbeat로만 정해져 고를 수 없다. 읽기 전용으로 보인다.
 * - Agent별 「실행 중 / 슬롯」 행은 원본에서도 값이 없던 죽은 행이라 뺐다(MM-24, EV-0314).
 */
import { useContext, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useApi } from '../../shared/api/ApiProvider.tsx';
import type { ResponseOf } from '../../shared/api/contract.ts';
import { useApiQuery } from '../../shared/api/queries.ts';
import { formatDateTime } from '../../shared/format.ts';
import { useRefreshError } from '../../shared/layout/MenuScreen.tsx';
import { useSave } from '../../shared/state/useSave.tsx';
import { BusyButton } from '../../shared/ui/BusyButton.tsx';
import { useNotice } from '../../shared/ui/feedback.tsx';
import { TableScroll } from '../../shared/ui/TableScroll.tsx';
import {
  END_REASON, FACTOR_LABEL, GH_PERMISSION, GH_SCOPES, OBS_GRADE, OPTIONS, READINESS_LABEL, READINESS_STATUS, agentMark, withValue,
} from './labels.ts';
import { githubOk } from './githubOk.ts';
import { CardHead, QueryGate, Row, Seg, useSettingQuery } from './ui.tsx';
import { DirtyContext, useSettingForm } from './useSettingForm.tsx';
import { LINK } from '../../shared/links.ts';

type RunnerState = ResponseOf<'getRunnerState'>;
const at = (value: string | null | undefined) => (value ? formatDateTime(value) : '—');
const pct = (rate: number) => `${String(Math.round(rate * 100))}%`;

/**
 * 빠진 목록을 빈 목록으로 채운다. 계약상 서버는 모두 보내지만, 한 칸이 빠져도 화면 전체가 깨지지 않게 한다
 * (예: 앱 틀 시험의 가짜 API는 connection만 보낸다).
 */
function normalize(data: RunnerState | undefined): RunnerState | undefined {
  if (!data) return undefined;
  const conc = (data as Partial<RunnerState>).concurrency;
  return {
    ...data,
    readiness: data.readiness ?? null,
    host: data.host ?? null,
    hostHistory: data.hostHistory ?? [],
    sessions: data.sessions ?? [],
    unconfirmedHolds: data.unconfirmedHolds ?? [],
    usage: data.usage ?? [],
    gaps: data.gaps ?? [],
    observation: data.observation ?? { budget: { dev: 0, qa: 0 }, profiles: [] },
    concurrency: conc ? { ...conc, conflictWaits: conc.conflictWaits ?? [], adjustments: conc.adjustments ?? [] } : (undefined as unknown as RunnerState['concurrency']),
  };
}

export function RunnerTab({ repoUrl }: { repoUrl: string | null }) {
  const runner = useApiQuery('getRunnerState', {}, { topics: ['runner'] });
  useRefreshError(runner, 'Runner 상태 최신 내용 불러오기');
  const data = normalize(runner.data);
  return (
    <>
      <GithubCard repoUrl={repoUrl} />
      <ConnectionCard runner={data} />
      <ReadinessCard runner={runner} />
      <CapacityCard runner={data} />
      <ConcurrencyCard runner={data} />
    </>
  );
}

/* ---------------- GitHub 연결(UI-12-01A, P L2258–2272) ---------------- */

const TOKEN_RE = /^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/;

function GithubCard({ repoUrl }: { repoUrl: string | null }) {
  const { client } = useApi();
  const notify = useNotice();
  const { query, queryKey, load } = useSettingQuery('getGithubSettings', 'GitHub 연결', ['settings', 'runner']);
  const gh = useSettingForm({
    id: 'github',
    label: 'GitHub 연결',
    query, queryKey, load,
    toForm: (d) => ({ mode: d.mode as 'gh' | 'token' }),
    send: (form, updatedAt) => client.call('putGithubSettings', { body: { updatedAt, mode: form.mode } }),
    describe: (form) => `인증 방식: ${form.mode === 'gh' ? 'Runner PC의 gh 로그인' : '토큰 입력'}`,
  });
  const data = query.data;
  const mode = gh.form?.mode;

  // 새 토큰은 비밀값이라 초안 보관(sessionStorage)에 넣지 않는다. 입력 중이면 편집 보호만 건다.
  const [token, setToken] = useState('');
  const [tokenError, setTokenError] = useState('');
  const report = useContext(DirtyContext);
  useEffect(() => { report('github-token', token !== ''); }, [report, token]);
  useEffect(() => () => { report('github-token', false); }, [report]);
  const saveToken = useSave<ResponseOf<'putGithubSettings'>, { token: string; updatedAt: string | null }>({
    target: 'GitHub 토큰 저장',
    request: () => ({ token: token.trim(), updatedAt: data?.updatedAt ?? null }),
    run: ({ payload }) => client.call('putGithubSettings', { body: { updatedAt: payload.updatedAt, mode: 'token', token: payload.token } }),
    onSuccess: (result, payload) => {
      gh.apply(result);
      setToken((current) => (current.trim() === payload.token ? '' : current));
    },
    successNotice: '토큰을 저장했습니다 — 서버에 암호화해 보관하고 다시 표시하지 않습니다.',
    mine: '새 토큰 저장',
    onConflictReload: async ({ signal }) => {
      const latest = await load(signal);
      if (signal.aborted) return;
      gh.apply(latest);
    },
    // 다시 적용도 공통 useSave 경로(reapplyRequest)로 보낸다. 최신 버전 위에 같은 토큰을 보내고,
    // 응답을 잃으면 같은 내용·같은 키로만 다시 보낸다(리뷰 624c334 지적 2, M3-04 0dcb8db).
    reapplyRequest: async ({ signal }) => {
      const latest = await load(signal);
      return { token: token.trim(), updatedAt: latest.updatedAt };
    },
  });
  const check = useSave<ResponseOf<'checkGithub'>>({
    target: 'GitHub 연결 확인 요청',
    failTitle: '요청하지 못했습니다',
    run: ({ idempotencyKey }) => client.call('checkGithub', { idempotencyKey }),
    onSuccess: () => { notify('연결 확인을 요청했습니다 — Runner가 확인해 보고하면 결과가 바뀝니다.'); },
  });

  const ok = data ? githubOk(data.scopes) : false;
  return (
    <section className="card" aria-labelledby="set-gh">
      <CardHead id="set-gh" title="GitHub 연결">
        {data && (
          <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className={ok ? 'vf v-pass' : 'vf v-fail'}>{ok ? '연결됨' : '실패'}</span>
          </span>
        )}
      </CardHead>
      <p className="fhint" style={{ margin: '0 0 8px' }}>입력 자료(prototype/ (uiux · docs)) 읽기, Task 브랜치 push, PR 생성 · 병합, 검사 결과 보고에 씁니다. 인증 정보는 Runner(팀장 PC)와 서버에만 있고 Agent 세션에는 전달하지 않습니다.</p>
      {gh.restoreOffer}
      <QueryGate query={query} label="GitHub 연결" />
      {data && mode && (
        <>
          <Row label="인증 방식">
            <Seg label="인증 방식" value={mode} onPick={(value) => { gh.edit((f) => ({ ...f, mode: value })); }}
              options={[{ value: 'gh', label: 'Runner PC의 gh 로그인' }, { value: 'token', label: '토큰 입력' }]} />
            <span className="fhint">{mode === 'gh' ? 'Runner PC(WSL)에서 gh auth login 으로 로그인된 계정을 그대로 씁니다. 토큰을 따로 보관하지 않습니다.' : '저장소 한정 fine-grained 토큰을 서버에 암호화 저장합니다.'}</span>
          </Row>
          <div className="kv" style={{ gridTemplateColumns: '130px minmax(0,1fr)', margin: '8px 0' }}>
            <span className="kv-l">계정</span><span className="kv-v mono">{data.account ?? '—'}</span>
            <span className="kv-l">저장소</span><span className="kv-v mono">{repoUrl ? `${repoUrl} (private)` : '프로젝트 등록 전'}</span>
            <span className="kv-l">토큰</span>
            <span className="kv-v">{data.mode === 'gh' ? '사용 안 함 (gh 로그인)' : (data.tokenSet ? `●●●● 저장됨 · 만료 ${data.expiresAt ? at(data.expiresAt) : '—'}` : '없음')}</span>
          </div>
          <TableScroll minWidth={560} label="GitHub 권한 표">
            <div className="gtb" style={{ margin: '0 0 8px' }}>
              <div className="gtr h" style={{ gridTemplateColumns: '140px 90px minmax(160px,1fr) 70px', minWidth: 0 }}><span className="gc">권한</span><span className="gc">수준</span><span className="gc">용도</span><span className="gc">상태</span></div>
              {GH_SCOPES.map((scope) => {
                const state = data.scopes ? GH_PERMISSION[String(data.scopes[scope.key])] : undefined;
                return (
                  <div key={scope.key} className="gtr" style={{ gridTemplateColumns: '140px 90px minmax(160px,1fr) 70px', minWidth: 0 }}>
                    <span className="gc">{scope.label}</span><span className="gc">{scope.level}</span><span className="gc">{scope.use}</span>
                    <span className="gc"><span className={state?.cls ?? 'vf v-none'}>{state?.label ?? '확인 전'}</span></span>
                  </div>
                );
              })}
            </div>
          </TableScroll>
          {data.warning && <div className="banner warn" role="note"><div className="banner-b">{data.warning}</div></div>}
          {!ok && (
            <div className="banner danger" role="note">
              <div className="banner-b">
                {data.scopes === null
                  ? `GitHub 연결을 확인하지 못했습니다${data.status ? ` (${data.status})` : ''} — 입력 변경 확인 · 브랜치 push · PR이 멈춥니다. 인증을 고친 뒤 「연결 확인」을 누르세요.`
                  : '필요한 권한이 없습니다 — 위 표의 「없음」 권한을 토큰(또는 gh 로그인 계정)에 더한 뒤 「연결 확인」을 누르세요. 그때까지 입력 변경 확인 · push · PR은 보류됩니다.'}
              </div>
            </div>
          )}
          {mode === 'token' && (
            <Row label="새 토큰">
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input className="inp mono-in" type="password" autoComplete="new-password" aria-label="새 토큰" placeholder="github_pat_…" style={{ maxWidth: 360 }}
                  value={token} onChange={(e) => { setToken(e.target.value); setTokenError(''); }} />
                <BusyButton small variant="default" busy={saveToken.busy} busyLabel="확인 중…"
                  onClick={() => {
                    if (!TOKEN_RE.test(token.trim())) { setTokenError('토큰 형식이 아닙니다 — github_pat_… (fine-grained) 또는 ghp_… 로 시작합니다.'); return; }
                    void saveToken.save();
                  }}>토큰 저장 · 확인</BusyButton>
              </div>
              {tokenError && <span className="ferr" role="alert">{tokenError}</span>}
              <span className="fhint">fine-grained 토큰 · 이 저장소만 · 위 4개 권한 · 만료일 지정 권장. 서버에 암호화해 저장하고 화면 · 로그 · API 응답에 다시 내보내지 않습니다. 만료 7일 전 알림.</span>
            </Row>
          )}
          {gh.footer}
          {saveToken.conflictModal}
          <div className="msg-acts">
            <BusyButton small variant="default" busy={check.busy} busyLabel="확인 중…" onClick={() => { void check.save(); }}>연결 확인</BusyButton>
            {/* 서버 후속 3차 checkedAt: 요청 접수가 아니라 Runner의 실제 확인 보고를 받은 시각(M3 통합) */}
            <span className="muted" data-testid="gh-checked-at">{data.checkedAt ? `마지막 확인 ${at(data.checkedAt)}` : '아직 Runner 확인 보고 없음'}</span>
          </div>
        </>
      )}
    </section>
  );
}

/* ---------------- Runner 연결(UI-12-01B 위, P L2273–2279) ---------------- */

function ConnectionCard({ runner }: { runner: RunnerState | undefined }) {
  const { client } = useApi();
  const { query, queryKey, load } = useSettingQuery('getWorkflowSettings', 'Runner 연결 설정');
  const wf = useSettingForm({
    id: 'workflow-live',
    label: '실행 중 세션 전달',
    query, queryKey, load,
    toForm: (d) => ({ liveInject: d.liveInject }),
    send: (form, updatedAt, latest) => {
      return client.call('putWorkflowSettings', {
        body: { updatedAt, devAgent: latest.devAgent, qaAgent: latest.qaAgent, liveInject: form.liveInject, heartbeatSeconds: latest.heartbeatSeconds, missedHeartbeats: latest.missedHeartbeats },
      });
    },
    describe: (form) => `실행 중 세션 전달: ${form.liveInject ? '지원' : '미지원'}`,
  });
  const online = runner?.connection.online;
  return (
    <section className="card" aria-labelledby="set-conn">
      <CardHead id="set-conn" title="Runner 연결" />
      {wf.restoreOffer}
      <div className="form">
        <Row label="연결 상태">
          <span style={{ paddingTop: 7 }}>
            {online === undefined ? '—' : <span className={online ? 'sc sc-ok' : 'sc sc-bad'}>{online ? '연결됨' : '연결 끊김'}</span>}
            {runner?.connection.lastHeartbeatAt && <span className="muted"> · 마지막 보고 {at(runner.connection.lastHeartbeatAt)}</span>}
          </span>
          <span className="fhint">헤더의 Runner 표시와 같은 값입니다. 끊기면 새 메시지는 전달 실패로 기록되고 실행 요청이 막힙니다.</span>
        </Row>
        <QueryGate query={query} label="Runner 연결 설정" />
        {wf.form && query.data && (
          <>
            <Row label="실행 중 세션 전달">
              <Seg label="실행 중 세션 전달" value={wf.form.liveInject} onPick={(value) => { wf.edit(() => ({ liveInject: value })); }}
                options={[{ value: false, label: '미지원 — 다음 실행에 전달' }, { value: true, label: '지원 — 실행 중 세션에 즉시 전달' }]} />
              <span className="fhint">실제 Runner 기능에 따라 달라지는 값입니다. 미지원이면 실행 중 Task에 보낸 메시지는 「다음 실행 대기」로 보관됩니다.</span>
            </Row>
            <Row label="Heartbeat 주기">
              <span style={{ paddingTop: 7 }} className="mono">{query.data.heartbeatSeconds}초 — {query.data.missedHeartbeats}회 미수신 시 오프라인 처리</span>
            </Row>
          </>
        )}
      </div>
      {wf.footer}
    </section>
  );
}

/* ---------------- Runner 준비 상태(UI-12-01B, P L2280–2288) ---------------- */

function ReadinessCard({ runner }: { runner: ReturnType<typeof useApiQuery<'getRunnerState'>> }) {
  const { client } = useApi();
  const notify = useNotice();
  // 「다시 점검」(원본 P L2282): 서버 후속 3차 POST /api/settings/readiness/check(checkReadiness, 202)에 연결(M3 통합).
  // 서버는 요청 번호만 올려 Runner에 전한다. 결과·점검 시각은 Runner가 다시 점검해 보고한 뒤에만 바뀐다(거짓 성공 금지).
  const recheck = useSave<ResponseOf<'checkReadiness'>>({
    target: 'Runner 준비 상태 다시 점검',
    failTitle: '다시 점검을 요청하지 못했습니다',
    run: ({ idempotencyKey }) => client.call('checkReadiness', { idempotencyKey }),
    onSuccess: () => { notify('다시 점검을 요청했습니다 — Runner가 점검해 보고하면 결과와 점검 시각이 바뀝니다.'); },
  });
  const readiness = runner.data?.readiness ?? null;
  const items = readiness?.items ?? [];
  const bad = items.filter((x) => x.status === 'fail').length;
  const warn = items.filter((x) => x.status === 'warn').length;
  const sum = bad ? { l: `문제 ${String(bad)}건 — 해당 Agent의 실행이 멈춰 있습니다`, c: 'sc sc-bad' }
    : warn ? { l: `주의 ${String(warn)}건 · 나머지 정상`, c: 'sc sc-warn' } : { l: '모두 정상', c: 'sc sc-ok' };
  return (
    <section className="card" aria-labelledby="set-ready">
      <CardHead id="set-ready" title="Runner 준비 상태">
        <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {readiness && <><span className={sum.c}>{sum.l}</span><span className="muted">점검 {at(readiness.at)}</span></>}
          <BusyButton small variant="default" busy={recheck.busy} busyLabel="요청 중…" onClick={() => { void recheck.save(); }}>다시 점검</BusyButton>
        </span>
      </CardHead>
      <p className="fhint" style={{ margin: '0 0 8px' }}>Runner가 시작할 때와 매일 한 번 실행 환경을 스스로 점검해 보고합니다. 문제가 있는 Agent는 실행을 멈추고 대시보드에 알림을 띄웁니다 — 직접 설치 · 점검 목록을 관리할 필요가 없습니다.</p>
      <QueryGate query={runner} label="Runner 상태" />
      {runner.data && !readiness && <p className="muted" style={{ margin: 0 }}>아직 준비 상태 보고가 없습니다. Runner가 시작하면 스스로 점검해 여기에 보고합니다.</p>}
      {readiness && (
        <TableScroll minWidth={640} label="Runner 준비 상태 표">
          <div className="gtb" style={{ margin: 0 }}>
            <div className="gtr h" style={{ gridTemplateColumns: '180px 70px minmax(160px,1fr) minmax(200px,1.4fr)', minWidth: 0 }}><span className="gc">항목</span><span className="gc">상태</span><span className="gc">결과</span><span className="gc">조치</span></div>
            {items.map((item) => {
              const st = READINESS_STATUS[String(item.status)] ?? { label: String(item.status), cls: 'sc sc-none' };
              return (
                <div key={String(item.key)} className="gtr" style={{ gridTemplateColumns: '180px 70px minmax(160px,1fr) minmax(200px,1.4fr)', minWidth: 0 }}>
                  <span className="gc">{READINESS_LABEL[String(item.key)] ?? String(item.key)}</span>
                  <span className="gc"><span className={st.cls}>{st.label}</span></span>
                  <span className="gc mono">{item.detail}</span>
                  <span className="gc">{item.fix ?? ''}</span>
                </div>
              );
            })}
          </div>
        </TableScroll>
      )}
    </section>
  );
}

/* ---------------- 가용 용량 — 관측값(UI-12-01C, P L2289–2323) ---------------- */

function CapacityCard({ runner }: { runner: RunnerState | undefined }) {
  const schedule = useApiQuery('getSchedule', {}, { topics: ['schedule', 'runner'] });
  const policy = useApiQuery('getScheduleSettings', {}, { topics: ['settings'] });
  useRefreshError(schedule, '가용 용량 최신 내용 불러오기');
  const cap = schedule.data?.capacity;
  const gaps = runner?.gaps ?? [];
  return (
    <section className="card" aria-labelledby="set-cap">
      <CardHead id="set-cap" title="가용 용량 — 관측값"><span className="fhint">Runner heartbeat · Agent 사용량 보고(Agent WBS API)로 수집 · 일정 계산의 근거</span></CardHead>
      <div className="cmp">
        <div>
          <QueryGate query={schedule} label="가용 용량" />
          {cap && (
            <>
              <div className="kv" style={{ gridTemplateColumns: '130px minmax(0,1fr)' }}>
                <span className="kv-l">관측 가동률</span>
                <span className="kv-v"><span className="mono" style={{ fontSize: 16, fontWeight: 700 }}>{pct(cap.rate)}</span><span className="muted">범위 {pct(cap.rateLo)} ~ {pct(cap.rateHi)} · 오늘 지금까지 {pct(cap.todayRate)}</span></span>
                <span className="kv-l">근거</span>
                <span className="kv-v">{cap.enough
                  ? `최근 7일 Runner 가동 기록 (${String(Math.round(cap.loggedHours))}시간 수집)`
                  : `기록 부족 — 정책 가정값 ${policy.data ? pct(policy.data.assumeRate) : '60%'} 사용`}</span>
              </div>
              <div className="cbars" aria-label="최근 7일 가동률">
                {cap.days.map((day) => (
                  <span key={day.date} className="cday" title={`${day.date.slice(5)} 가동 ${pct(day.rate)}`}>
                    <span className="mono cpct">{pct(day.rate)}</span>
                    <span className={day.rate < 0.2 ? 'cbar low' : 'cbar'} style={{ height: Math.max(2, Math.round(day.rate * 64)) }} />
                    <span className="mono muted">{day.date.slice(5)}</span>
                  </span>
                ))}
              </div>
            </>
          )}
          <h3 className="h4" style={{ marginTop: 12 }}>최근 중단 구간</h3>
          <TableScroll minWidth={480} label="최근 중단 구간 표">
            <div className="gtb" style={{ margin: 0 }}>
              <div className="gtr h" style={{ gridTemplateColumns: '148px 148px 70px minmax(100px,1fr)', minWidth: 0 }}><span className="gc">중단</span><span className="gc">재연결</span><span className="gc">길이</span><span className="gc">사유</span></div>
              {runner && gaps.length === 0 && <div className="gtr"><span className="gc muted">최근 7일 중단 기록이 없습니다. Runner가 끊겼다가 다시 연결되면 여기에 남습니다.</span></div>}
              {gaps.map((gap) => (
                <div key={gap.from} className="gtr" style={{ gridTemplateColumns: '148px 148px 70px minmax(100px,1fr)', minWidth: 0 }}>
                  <span className="gc mono">{at(gap.from)}</span>
                  <span className="gc mono">{gap.to ? at(gap.to) : '아직 끊김'}</span>
                  <span className="gc mono">{gap.to ? `${String(Math.round(((Date.parse(gap.to) - Date.parse(gap.from)) / 36e5) * 10) / 10)}h` : '—'}</span>
                  <span className="gc">{END_REASON[String(gap.reason)] ?? String(gap.reason)}</span>
                </div>
              ))}
            </div>
          </TableScroll>
        </div>
        <div>
          <h3 className="h4">Agent별 사용량</h3>
          {(['Claude', 'Codex'] as const).map((agent) => {
            const usage = runner?.usage.find((u) => u.agent === agent);
            const mark = agentMark(agent);
            const remain = usage?.remainPct;
            const st = remain === undefined ? { l: '보고 없음', c: 'sc sc-none' }
              : remain <= 0 ? { l: '한도 — 배정 보류', c: 'sc sc-bad' } : remain < 20 ? { l: '여유 적음', c: 'sc sc-warn' } : { l: '정상', c: 'sc sc-ok' };
            return (
              <div key={agent} className="agbox">
                <div className="dp-h" style={{ margin: '0 0 6px' }}>
                  <span className="agent"><span className={`ag-mk ${mark.cls}`} aria-hidden="true">{mark.init}</span><b>{agent}</b></span>
                  <span className={st.c}>{st.l}</span>
                </div>
                <div className="kv" style={{ gridTemplateColumns: '110px minmax(0,1fr)', margin: 0 }}>
                  <span className="kv-l">남은 사용량</span>
                  <span className="kv-v">
                    <span className="bar" style={{ width: 140 }}><span className="bar-f" style={{ width: `${String(remain ?? 0)}%` }} /></span>
                    <span className="mono">{remain === undefined ? '—' : `${String(remain)}%`}</span><span className="muted">보고 {at(usage?.at)}</span>
                  </span>
                  <span className="kv-l">리셋 예정</span><span className="kv-v mono">{at(usage?.resetAt)}</span>
                </div>
              </div>
            );
          })}
          <div className="agbox">
            <div className="dp-h" style={{ margin: '0 0 6px' }}>
              <b>Runner</b>
              {runner && (runner.connection.online ? <span className="sc sc-ok">가동 중</span> : <span className="sc sc-bad">중지됨</span>)}
            </div>
            <p className="fhint" style={{ margin: '6px 0 0' }}>중지하면 실행 중이던 시도는 「중단 · 재개 대기」로 기록되고, 일정이 기준을 벗어나면 Planning Agent가 자동 재조정합니다.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------------- 동시 실행 — 상한 · Runner 조절(UI-12-01D·E, P L2324–2393) ---------------- */

function ConcurrencyCard({ runner }: { runner: RunnerState | undefined }) {
  const { client } = useApi();
  const concQ = useSettingQuery('getConcurrency', '동시 실행 상한');
  const cc = useSettingForm({
    id: 'concurrency',
    label: '동시 실행 상한',
    ...concQ,
    toForm: (d) => ({ mode: String(d.mode) as 'auto' | 'manual', caps: { ...d.caps }, memReserveGB: d.memReserveGB }),
    send: (form, updatedAt) => client.call('putConcurrency', { body: { updatedAt, ...form } }),
    describe: (form) => `상한: ${form.mode === 'auto' ? '자동' : '직접 지정'} · 전체 ${String(form.caps.total)} · Claude ${String(form.caps.Claude)} · Codex ${String(form.caps.Codex)} · 무거운 작업 ${String(form.caps.heavy)} · 메모리 예비 ${String(form.memReserveGB)}GB`,
  });
  const budgetQ = useSettingQuery('getObsBudget', '하위 Agent 동시 예산');
  const budget = useSettingForm({
    id: 'obs-budget',
    label: '하위 Agent 동시 예산',
    ...budgetQ,
    toForm: (d) => ({ ...d.budget }),
    send: (form, updatedAt) => client.call('putObsBudget', { body: { updatedAt, budget: form } }),
    describe: (form) => `하위 Agent 예산: 개발 ${String(form.dev)} · 검증 ${String(form.qa)}`,
  });

  const host = runner?.host ?? null;
  const conc = runner?.concurrency as RunnerState['concurrency'] | undefined;
  const rec = host?.recommended;
  const form = cc.form;
  const isAuto = form?.mode === 'auto';
  const over = form && rec && !isAuto
    ? (['total', 'heavy', 'Claude', 'Codex'] as const).filter((k) => form.caps[k] > rec[k])
      .map((k) => `${({ total: '전체', heavy: '무거운 작업', Claude: 'Claude', Codex: 'Codex' } as const)[k]} ${String(form.caps[k])} > 권장 ${String(rec[k])}`)
    : [];
  const warns = [...(host?.warnings ?? []), ...(over.length ? [`직접 지정 상한이 이 PC 권장값보다 큼 — ${over.join(', ')}. Runner가 자원 압박을 감지하면 한도를 줄이지만, 상한을 다시 확인하세요.`] : [])];
  const capSeg = (key: 'total' | 'Claude' | 'Codex' | 'heavy', list: readonly number[], label: string) => form && (
    <Seg label={label} disabled={isAuto} value={form.caps[key]} options={withValue(list, form.caps[key]).map((n) => ({ value: n, label: String(n) }))}
      onPick={(n) => { cc.edit((f) => ({ ...f, caps: { ...f.caps, [key]: n } })); }} />
  );
  const unconfirmed = runner?.sessions.filter((s) => s.state === 'unconfirmed') ?? [];

  return (
    <section className="card" aria-labelledby="set-cc">
      <CardHead id="set-cc" title="동시 실행 — 상한 · Runner 조절"><span className="fhint">하위 Agent 포함 카운트 · 상한은 Runner가 보고한 PC 사양으로 자동 계산(또는 팀장 직접 지정) · 실제 동시 실행 수는 Runner가 상한 안에서 늘리고 줄입니다</span></CardHead>
      {cc.restoreOffer}{budget.restoreOffer}
      <div className="cmp">
        <div>
          <div className="form">
            <Row label="실행 PC">
              {host ? (
                <>
                  <span><b>{`${host.hostId} — ${host.cpu} · ${String(host.cores)}코어 · 메모리 ${String(host.memGB)}GB · swap ${String(host.swapGB)}GB · 디스크 여유 ${String(host.diskFreeGB)}GB`}</b></span>
                  <span className="fhint">{host.os} · 보고 {at(host.seenAt)} · {host.perSessionGB === null ? '세션당 평균 관측 전 — 기본값, 실행하면서 보정' : `세션당 평균 ${String(host.perSessionGB)}GB (관측 세션 ${String(host.samples)}개)`} — Runner가 시작할 때 스스로 확인해 보고합니다 (nproc · /proc/meminfo · df · 세션 메모리 관측). 다른 PC에서 연결하면 새 사양으로 다시 보고합니다.</span>
                </>
              ) : <span className="muted" style={{ paddingTop: 7 }}>아직 실행 PC 보고가 없습니다. Runner가 연결되면 사양을 스스로 보고합니다.</span>}
            </Row>
            <QueryGate query={concQ.query} label="동시 실행 상한" />
            {form && (
              <>
                <Row label="상한 결정 방식">
                  <Seg label="상한 결정 방식" value={form.mode} onPick={(mode) => { cc.edit((f) => ({ ...f, mode })); }}
                    options={[{ value: 'auto', label: '자동 — PC 사양 기반 권장값' }, { value: 'manual', label: '직접 지정' }]} />
                  {rec && <span className="fhint"><b>{`권장: 전체 ${String(rec.total)} · Claude ${String(rec.Claude)} · Codex ${String(rec.Codex)} · 무거운 작업 ${String(rec.heavy)}`}</b></span>}
                </Row>
                {warns.length > 0 && <div className="banner warn" role="note"><div className="banner-b">{warns.map((w) => <div key={w}>{w}</div>)}</div></div>}
                <Row label="전체 상한">
                  {capSeg('total', [4, 8, 12, 16, 20, 24, 32], '전체 상한')}
                  {isAuto && <span className="fhint">자동 모드 — 권장값이 적용됩니다. 값을 직접 정하려면 「직접 지정」을 선택하세요.</span>}
                </Row>
                <Row label="Claude 상한">{capSeg('Claude', [4, 8, 12, 16, 24], 'Claude 상한')}</Row>
                <Row label="Codex 상한">
                  {capSeg('Codex', [4, 8, 12, 16, 24], 'Codex 상한')}
                  <span className="fhint">Agent별 상한 합이 전체 상한보다 커도 됩니다 — 한쪽 일이 몰릴 때 나머지 여유를 쓰기 위함.</span>
                </Row>
                <Row label="무거운 작업 상한">
                  {capSeg('heavy', [2, 4, 6, 8, 10], '무거운 작업 상한')}
                  <span className="fhint">빌드 · 전체 테스트 · E2E · pnpm install을 동시에 몇 개까지 돌릴지. 넘치면 Runner가 대기열로 순서대로 실행합니다.</span>
                </Row>
                <Row label="메모리 예비">
                  <Seg label="메모리 예비" value={form.memReserveGB} onPick={(n) => { cc.edit((f) => ({ ...f, memReserveGB: n })); }}
                    options={withValue(OPTIONS.memReserveGB, form.memReserveGB).map((n) => ({ value: n, label: `${String(n)}GB` }))} />
                  <span className="fhint">여유 메모리가 이 값 아래로 내려가거나 swap을 쓰기 시작하면 Runner가 동시 실행 수를 줄이고 새 실행을 보류합니다. 자동 모드에서는 권장 상한 계산에도 쓰입니다.</span>
                </Row>
              </>
            )}
            <Row label="충돌 방지">
              <span><b>충돌 묶음 직렬화</b> <span className="tag">고정 규칙</span></span>
              <span className="fhint">Planning Agent가 Task마다 관련 파일 · 모듈로 충돌 묶음을 지정합니다. 같은 묶음 Task는 git worktree를 따로 써도 동시에 하나만 실행합니다(병합 충돌 · 재작업 방지).</span>
            </Row>
          </div>
          {cc.footer}
        </div>
        <div>
          <h3 className="h4" style={{ marginTop: 0 }}>Runner 현재 상태 {conc?.resources && <span className="muted" style={{ fontWeight: 400 }}>보고 {at(conc.resources.at)}</span>}</h3>
          {conc && (
            <div className="kv" style={{ gridTemplateColumns: '130px minmax(0,1fr)', margin: 0 }}>
              <span className="kv-l">동시 실행</span>
              <span className="kv-v">
                <span className="bar" style={{ width: 140 }}><span className="bar-f" style={{ width: `${String(Math.min(100, Math.round((conc.used.total / Math.max(1, conc.limit ?? conc.caps.total)) * 100)))}%` }} /></span>
                <b className="mono">{conc.used.total} / {conc.limit ?? conc.caps.total}</b>
                <span className="muted">{`세션 ${String(conc.used.total - conc.subagentsHeld)} + 하위 Agent ${String(conc.subagentsHeld)} (관측 ${String(conc.subagentsObserved)} · 보유 계산 ${String(conc.subagentsHeld)})`}</span>
              </span>
              <span className="kv-l">한도</span><span className="kv-v">팀장 상한 {conc.caps.total} · Runner 조절 {conc.limit ?? '—'}</span>
              <span className="kv-l">Agent별</span><span className="kv-v mono">{`Claude ${String(conc.used.Claude)} / ${String(conc.caps.Claude)} · Codex ${String(conc.used.Codex)} / ${String(conc.caps.Codex)}`}</span>
              <span className="kv-l">병렬 가능한 일</span><span className="kv-v">{`실행 중 ${String(runner?.sessions.length ?? 0)} + 바로 시작 가능 ${String(conc.startable)} = ${String(conc.parallelWidth)}개 Task`}</span>
              <span className="kv-l">무거운 작업</span><span className="kv-v mono">{conc.heavyJobs} / {conc.caps.heavy}</span>
              <span className="kv-l">자원</span>
              <span className="kv-v">
                <span className={conc.pressure ? 'sc sc-bad' : 'sc sc-ok'}>{conc.pressure ? '자원 압박' : '여유'}</span>
                {conc.resources && <span className="mono">{`CPU ${String(conc.resources.cpuPct)}% · 메모리 여유 ${conc.resources.memFreeGB.toFixed(1)}${host ? ` / ${String(host.memGB)}` : ''}GB · swap ${String(conc.resources.swapGB)}GB`}</span>}
              </span>
              <span className="kv-l">충돌 대기</span>
              <span className="kv-v">
                {conc.conflictWaits.length === 0 ? <span className="muted">없음</span> : (
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    {conc.conflictWaits.map((w) => (
                      <span key={w.taskKey}><Link className="reflink" to={`/wbs/${w.taskKey}`}>{w.taskKey}</Link> 「{w.conflictGroup}」 — {w.by} 실행 중</span>
                    ))}
                  </span>
                )}
              </span>
            </div>
          )}
          <h3 className="h4" style={{ margin: '14px 0 6px' }}>하위 Agent 관측 <span className="muted" style={{ fontWeight: 400 }}>hook 미사용 · 출력은 관측만 · 슬롯 반환은 프로세스 그룹 종료 시</span></h3>
          {unconfirmed.length > 0 && (
            <div className="banner danger" role="note"><div className="banner-b">{`관측 미확인 세션 ${String(unconfirmed.length)}개 — 하위 Agent 수를 줄이지 않고 보유, 새 실행 보류 중`}</div></div>
          )}
          {(runner?.unconfirmedHolds.length ?? 0) > 0 && (
            <div className="banner danger" role="note"><div className="banner-b">{`프로세스 종료를 확인하지 못한 보유 ${String(runner?.unconfirmedHolds.reduce((n, h) => n + h.slots, 0) ?? 0)}슬롯 — 물리 해제가 확정될 때까지 반환하지 않습니다.`}</div></div>
          )}
          <TableScroll minWidth={640} label="하위 Agent 관측 표">
            <div className="gtb" style={{ margin: '0 0 8px' }}>
              <div className="gtr h orow"><span className="gc">세션</span><span className="gc">CLI 관측</span><span className="gc">관측</span><span className="gc">보유 계산</span><span className="gc">상태</span><span className="gc" /></div>
              {runner && runner.sessions.length === 0 && <div className="gtr"><span className="gc muted">실행 중인 세션이 없습니다. Runner가 Task를 실행하면 세션별 하위 Agent 관측이 여기에 보입니다.</span></div>}
              {runner?.sessions.map((s) => {
                const grade = OBS_GRADE[String(s.grade)] ?? OBS_GRADE.unverified;
                const un = s.state === 'unconfirmed';
                return (
                  <div key={s.attemptId} className="gtr orow">
                    <span className="gc"><span className="tcell"><Link className="reflink mono" to={LINK.exec(s.taskKey)}>{s.taskKey}</Link><span className="tid">{s.agent}</span></span></span>
                    <span className="gc"><span className={grade?.cls}>{grade?.label}</span></span>
                    <span className="gc mono">{s.observed}</span>
                    <span className="gc"><span className="tcell"><b className="mono">{s.reserved}</b><span className="tid">{un ? '미확인 — 마지막 관측 이상 보유' : s.grade === 'verified' ? '관측값' : '보수 계산(예산과 관측 중 큰 값)'}</span></span></span>
                    <span className="gc"><span className={un ? 'vf v-fail' : 'vf v-run'}>{un ? '관측 끊김' : '관측 중'}</span></span>
                    <span className="gc" />
                  </div>
                );
              })}
            </div>
          </TableScroll>
          <QueryGate query={budgetQ.query} label="하위 Agent 동시 예산" />
          {budget.form && (
            <Row label="하위 Agent 동시 예산" style={{ margin: '0 0 8px' }}>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span className="muted">개발 · 재작업 세션</span>
                <Seg label="개발 · 재작업 세션 예산" value={budget.form.dev} onPick={(n) => { budget.edit((f) => ({ ...f, dev: n })); }} options={withValue(OPTIONS.budgetDev, budget.form.dev).map((n) => ({ value: n, label: String(n) }))} />
              </span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span className="muted">검증 세션</span>
                <Seg label="검증 세션 예산" value={budget.form.qa} onPick={(n) => { budget.edit((f) => ({ ...f, qa: n })); }} options={withValue(OPTIONS.budgetQa, budget.form.qa).map((n) => ({ value: n, label: String(n) }))} />
              </span>
              <span className="fhint">Task 지시문에 「동시에 최대 n개」로 적습니다. 세션 안 생성은 막지 않으므로(hook 미사용) 실제 통제는 Runner의 새 세션 시작 조절로 합니다. 검증되지 않은 CLI 세션은 이 예산만큼 보유한 것으로 계산합니다.</span>
            </Row>
          )}
          {budget.footer}
          <TableScroll minWidth={700} label="CLI 관측 등급 표">
            <div className="gtb" style={{ margin: 0 }}>
              <div className="gtr h crow"><span className="gc">CLI</span><span className="gc">설치 버전</span><span className="gc">검증 버전 · 모델</span><span className="gc">관측 등급</span><span className="gc">검증 조건 · 결과</span></div>
              {runner && runner.observation.profiles.length === 0 && <div className="gtr"><span className="gc muted">아직 CLI 관측 보고가 없습니다.</span></div>}
              {runner?.observation.profiles.map((p) => {
                const grade = OBS_GRADE[String(p.grade)] ?? OBS_GRADE.unverified;
                const mismatch = p.verifiedVersion !== null && p.verifiedVersion !== p.version;
                return (
                  <div key={String(p.agent)} className="gtr crow">
                    <span className="gc"><b>{p.agent}</b></span>
                    <span className="gc"><span className="tcell"><span className="mono">{p.version}</span>{mismatch && <span className="sc sc-warn">검증 버전과 다름</span>}</span></span>
                    <span className="gc mono">{p.verifiedVersion ? `${p.verifiedVersion} · ${p.model}` : '—'}</span>
                    <span className="gc"><span className={grade?.cls}>{grade?.label}</span></span>
                    <span className="gc"><span className="tcell"><span>{p.notes}</span><span className="tid">{p.options || '—'} · 검증 {at(p.verifiedAt)}</span></span></span>
                  </div>
                );
              })}
            </div>
          </TableScroll>
          <p className="fhint" style={{ margin: '6px 0 0' }}>관측 등급은 CLI 버전 · 모델 · 동시 수 · 깊이 설정 조합에 부여합니다. 하나라도 바뀌면 재검증 전까지 「미검증」입니다. 미검증 CLI 세션은 보수 계산하고, 재검증 전까지 최신 버전을 그대로 씁니다.</p>
          {conc && (
            <p className="fhint" style={{ margin: '6px 0' }}>
              {`지금 동시 실행을 제한하는 요인: ${FACTOR_LABEL[String(conc.factor)] ?? String(conc.factor)} · 일정 계산에 쓰는 동시 Task 수 ${String(Math.floor((conc.limit ?? conc.caps.total) / (1 + conc.subRatio)))}개 (한도 ${String(conc.limit ?? conc.caps.total)} ÷ (1 + 하위 Agent 비율 ${String(conc.subRatio)}))`}
            </p>
          )}
          <h3 className="h4" style={{ marginTop: 10 }}>실행 PC 이력</h3>
          <TableScroll minWidth={480} label="실행 PC 이력 표">
            <div className="gtb" style={{ margin: '0 0 6px' }}>
              <div className="gtr h" style={{ gridTemplateColumns: '148px 120px minmax(120px,1fr)', minWidth: 0 }}><span className="gc">시각</span><span className="gc">PC</span><span className="gc">사양</span></div>
              {runner && runner.hostHistory.length === 0 && <div className="gtr"><span className="gc muted">실행 PC 보고 기록이 없습니다.</span></div>}
              {runner?.hostHistory.slice(0, 4).map((h) => (
                <div key={`${h.hostId}-${h.seenAt}`} className="gtr" style={{ gridTemplateColumns: '148px 120px minmax(120px,1fr)', minWidth: 0 }}>
                  <span className="gc mono">{at(h.seenAt)}</span><span className="gc"><b>{h.hostId}</b></span><span className="gc">{`${h.cpu} · ${String(h.cores)}코어 · ${String(h.memGB)}GB`}</span>
                </div>
              ))}
            </div>
          </TableScroll>
          <h3 className="h4" style={{ marginTop: 10 }}>조절 기록</h3>
          <TableScroll minWidth={420} label="조절 기록 표">
            <div className="gtb" style={{ margin: 0 }}>
              <div className="gtr h" style={{ gridTemplateColumns: '148px 72px 76px minmax(120px,1fr)', minWidth: 0 }}><span className="gc">시각</span><span className="gc">주체</span><span className="gc">한도</span><span className="gc">사유</span></div>
              {runner?.concurrency && runner.concurrency.adjustments.length === 0 && <div className="gtr"><span className="gc muted">조절 기록이 없습니다. Runner가 한도를 바꾸면 여기에 남습니다.</span></div>}
              {runner?.concurrency?.adjustments.slice().reverse().slice(0, 6).map((a) => (
                <div key={`${a.at}-${String(a.to)}`} className="gtr" style={{ gridTemplateColumns: '148px 72px 76px minmax(120px,1fr)', minWidth: 0 }}>
                  <span className="gc mono">{at(a.at)}</span><span className="gc">{a.by}</span>
                  <span className="gc"><span className={a.to > a.from ? 'sc sc-ok' : a.to < a.from ? 'sc sc-warn' : 'sc sc-none'}>{a.from} → {a.to}</span></span>
                  <span className="gc">{a.reason}</span>
                </div>
              ))}
            </div>
          </TableScroll>
        </div>
      </div>
    </section>
  );
}
