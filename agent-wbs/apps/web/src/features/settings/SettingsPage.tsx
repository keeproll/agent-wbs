/**
 * 설정 화면(UI-12, P L2251–2676). 주소: `/settings`(기본 Runner 탭), `/settings/<탭>`(G§4.9).
 *
 * - 탭 6개는 주소가 있는 링크다. 새로고침·뒤로 가기·공유 때 같은 탭이 열린다(UAT-SHELL-01, MM-29).
 * - 등록 전에도 열린다(OPEN_BEFORE_ACTIVE). 실행 PC·정책은 등록 전에 정해 둘 수 있어야 하기 때문이다.
 * - 카드마다 초안이 있다(useSettingForm). 저장하지 않은 카드가 있으면 다른 탭·메뉴로 가기 전에 묻는다(편집 보호).
 * - 보고서·메일·알림 탭 본문은 M6-03·M6-04가 만든다. 여기서는 주소·선택 강조만 판정한다(UAT-SHELL-01 b).
 */
import { Link, Navigate, useParams } from 'react-router';
import { MenuScreen } from '../../shared/layout/MenuScreen.tsx';
import { Page } from '../../shared/layout/Page.tsx';
import { useApiQuery } from '../../shared/api/queries.ts';
import { useEditGuard } from '../../shared/state/useEditGuard.ts';
import { AgentTab } from './AgentTab.tsx';
import { githubOk } from './githubOk.ts';
import { isSettingsTab, SETTINGS_TABS, type SettingsTab } from './labels.ts';
import { PlanTab } from './PlanTab.tsx';
import { RunnerTab } from './RunnerTab.tsx';
import { SystemTab } from './SystemTab.tsx';
import { DirtyContext, useDirtyRegistry } from './useSettingForm.tsx';
import './settings.css';

/** 페이지 설명(P L2253). 제품에 없는 「Runner 동작 (Mock)」·「구현 현황」은 뺐다(UAT-POLICY-05). */
const SUB = 'Runner · 실행 환경, Agent, 일정 · Task, 보고서 · 메일, 점검 — Agent 역할 · 기본 Workflow · Runner 동작 · 데이터 정합성 점검';

export function SettingsPage() {
  const { tab } = useParams();
  if (tab !== undefined && !isSettingsTab(tab)) return <Navigate to="/settings/runner" replace />;
  return (
    <MenuScreen menu="settings">
      {(project) => <SettingsBody tab={tab ?? 'runner'} preReg={preRegNotice(project.state)} />}
    </MenuScreen>
  );
}

/** 초기 WBS 승인 전 안내(P L6878 문구 그대로) */
function preRegNotice(state: string | number): string | null {
  if (state === 'active') return null;
  return state === 'none'
    ? '프로젝트 등록 전 — 실행 환경 · 정책 설정은 지금 정해 두면 등록 후 그대로 적용됩니다.'
    : '초기 분석 중 — 설정 변경은 초기 WBS 승인 후 일정 계산에 반영됩니다.';
}

/** 탭 배지(G§4.9 표, P L6659–6664). 서버가 주는 값으로만 센다. */
function useBadges(): Partial<Record<SettingsTab, { count: number; alert: boolean }>> {
  const runner = useApiQuery('getRunnerState', {}, { topics: ['runner'] });
  const github = useApiQuery('getGithubSettings', {}, { topics: ['settings', 'runner'] });
  const readinessBad = runner.data?.readiness?.items.filter((item) => item.status !== 'ok').length ?? 0;
  const githubBad = github.data && !githubOk(github.data.scopes) ? 1 : 0;
  const count = readinessBad + githubBad;
  return { runner: { count, alert: count > 0 } };
}

function SettingsBody({ tab, preReg }: { tab: SettingsTab; preReg: string | null }) {
  const { anyDirty, report } = useDirtyRegistry();
  useEditGuard(anyDirty);
  const badges = useBadges();
  const current = SETTINGS_TABS.find((t) => t.key === tab) ?? SETTINGS_TABS[0];
  return (
    <DirtyContext.Provider value={report}>
      <Page title="설정" sub={SUB}>
        {preReg && (
          <div className="banner warn" role="note">
            <div className="banner-b">{preReg}</div>
          </div>
        )}
        <nav className="stabs" aria-label="설정 영역">
          {SETTINGS_TABS.map((t) => {
            const badge = badges[t.key];
            return (
              <Link
                key={t.key}
                to={`/settings/${t.key}`}
                className={t.key === tab ? 'tab on' : 'tab'}
                aria-current={t.key === tab ? 'page' : undefined}
              >
                {t.label}
                {badge && badge.count > 0 && <span className={badge.alert ? 'tab-c alert' : 'tab-c'} aria-label={`문제 ${String(badge.count)}건`}>{badge.count}</span>}
              </Link>
            );
          })}
        </nav>
        <p className="fhint" style={{ margin: '-4px 0 12px' }}>{current.desc}</p>
        {tab === 'runner' && <RunnerTab />}
        {tab === 'agent' && <AgentTab />}
        {tab === 'plan' && <PlanTab />}
        {tab === 'system' && <SystemTab />}
        {(tab === 'report' || tab === 'notify') && (
          <section className="card" aria-label={current.label}>
            <p style={{ margin: 0 }}>이 탭은 아직 구현되지 않았습니다.</p>
          </section>
        )}
      </Page>
    </DirtyContext.Provider>
  );
}
