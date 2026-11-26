import Type from 'typebox';
import * as c from '../common.ts';
import * as m from '../models.ts';
import { operation } from '../operation.ts';

const { AnyOf, Body, Nullable, Opt, List, Text, Page, PageQuery } = c;
const lead = { principal: 'lead' } as const;
const byBody = { ...lead, version: 'body' } as const;
const noVersion = { ...lead, version: 'none' } as const;
const V = c.Version;
const jobCreated = { 202: Type.Object({ jobId: c.Id }) };
const Revision = Type.Integer({ minimum: 1 });

const project = [
  operation({
    ...noVersion,
    id: 'createRepoCheck',
    method: 'POST',
    path: '/api/project/repo-checks',
    summary: '저장소 접근 확인 요청(형식 검사 먼저)',
    body: Body({ url: c.RepoUrl }),
    responses: { 202: Type.Object({ id: c.Id }) },
  }),
  operation({
    ...lead,
    id: 'getRepoCheck',
    method: 'GET',
    path: '/api/project/repo-checks/:id',
    summary: '저장소 접근 확인 결과',
    responses: {
      200: Type.Object({
        id: c.Id,
        url: Type.String(),
        // repo_checks.status의 값 목록은 원본·계획에 없다
        status: Type.String(),
        private: Nullable(Type.Boolean()),
        commit: Nullable(c.Sha),
        structure: Nullable(m.RepoStructure),
        error: Nullable(Type.String()),
      }),
    },
  }),
  operation({
    ...noVersion,
    id: 'createProject',
    method: 'POST',
    path: '/api/project',
    summary: '프로젝트 등록 → 초기 분석 작업 생성(성공한 저장소 확인이 없으면 INVALID_TRANSITION)',
    body: Body({
      name: Text,
      url: c.RepoUrl,
      targetDate: Opt(c.DateOnly),
      constraints: List(
        Type.Union([
          Body({ name: Text, level: AnyOf('must', 'ban') }),
          Body({ name: Text, level: AnyOf('cond'), condition: Text }),
        ]),
      ),
      instruction: Type.String(),
      repoCheckId: c.Id,
    }),
    responses: { 201: Type.Object({ project: Type.Object({ id: c.Id, name: Type.String() }), jobId: c.Id }) },
    errors: ['PROJECT_EXISTS', 'CLEANUP_PENDING', 'INVALID_TRANSITION', 'NOT_FOUND'],
  }),
  operation({
    ...lead,
    id: 'getProject',
    method: 'GET',
    path: '/api/project',
    summary: '등록·입력·bootstrap·변경 감지',
    responses: { 200: m.ProjectState },
  }),
  operation({
    ...lead,
    version: 'revision',
    id: 'approveBootstrap',
    method: 'POST',
    path: '/api/project/bootstrap/approve',
    summary: '초기 WBS 승인 → WBS + 기준 v1(한 트랜잭션)',
    body: Body({ revision: Revision }),
    responses: { 200: Type.Object({ baselineVersion: Type.Literal(1), taskCount: c.Count }) },
    errors: ['INVALID_TRANSITION', 'SPLIT_JUDGEMENT_REQUIRED'],
  }),
  operation({
    ...lead,
    version: 'revision',
    id: 'rerunBootstrap',
    method: 'POST',
    path: '/api/project/bootstrap/rerun',
    summary: '재분석 요청(확정된 기술 결정 유지)',
    body: Body({ revision: Revision, instruction: Text }),
    responses: jobCreated,
    errors: ['INVALID_TRANSITION'],
  }),
  operation({
    ...lead,
    version: 'revision',
    id: 'retryBootstrap',
    method: 'POST',
    path: '/api/project/bootstrap/retry',
    summary: '실패 단계부터 다시 시도. 초안이 있으면 revision, 없으면 분석 회차(runNo)를 비교',
    body: Type.Union([Body({ revision: Revision }), Body({ revision: Type.Null(), runNo: Revision })]),
    responses: jobCreated,
    errors: ['INVALID_TRANSITION', 'CLEANUP_PENDING'],
  }),
  operation({
    ...lead,
    version: 'list',
    id: 'confirmTech',
    method: 'POST',
    path: '/api/projects/:projectId/boot/tech/confirm',
    summary: '기술 결정 확정(미결정이 있으면 409)',
    body: Body({
      decisions: List(Body({ id: c.Id, choice: AnyOf('approve', 'reject'), updatedAt: c.Timestamp })),
    }),
    responses: { 200: Type.Object({ decisions: List(m.Decision) }) },
    errors: ['DECISIONS_PENDING', 'INVALID_TRANSITION'],
  }),
  operation({
    ...byBody,
    id: 'analyzeInputs',
    method: 'POST',
    path: '/api/project/inputs',
    summary: '「이 버전으로 분석」. commits는 팀장이 확인한 대기 커밋 목록, commit은 조회의 inputHead(입력 사슬 끝)',
    body: Body({
      ...V,
      commit: c.Sha,
      commits: List(c.Sha, { minItems: 1, uniqueItems: true }),
      instr: Opt(Type.String()),
    }),
    responses: jobCreated,
    errors: ['INPUT_UNCHANGED', 'CLEANUP_PENDING', 'INVALID_TRANSITION'],
  }),
  operation({
    ...byBody,
    id: 'skipInputs',
    method: 'POST',
    path: '/api/project/inputs/skip',
    summary: '「분석 안 함」',
    body: Body({ ...V, commits: List(c.Sha, { minItems: 1, uniqueItems: true }) }),
    responses: { 204: null },
    errors: ['INVALID_TRANSITION'],
  }),
  operation({
    ...byBody,
    id: 'retryInputs',
    method: 'POST',
    path: '/api/project/inputs/retry',
    summary: '차이 분석 다시 시도(끝난 단계는 건너뜀). version은 실패한 입력 버전',
    body: Body({ ...V, version: Revision }),
    responses: jobCreated,
    errors: ['INVALID_TRANSITION', 'CLEANUP_PENDING'],
  }),
  operation({
    ...lead,
    version: 'epoch',
    id: 'resetProject',
    method: 'POST',
    path: '/api/project/reset',
    summary: '초기화. epoch는 화면이 본 초기화 번호',
    body: Body({ confirmName: Text, keepSettings: Type.Boolean(), epoch: c.Epoch }),
    responses: { 200: Type.Object({ epoch: c.Epoch }) },
    errors: ['EPOCH_MISMATCH'],
  }),
  operation({
    ...lead,
    id: 'previewReset',
    method: 'GET',
    path: '/api/project/reset-preview',
    summary: '삭제 건수·Runner 정리 내용',
    responses: { 200: m.ResetPreview },
  }),
  operation({
    ...lead,
    id: 'exportProject',
    method: 'GET',
    path: '/api/project/export',
    summary: '내보내기 zip(데이터 JSON·보고서 PDF·Evidence. 비밀값·수신자 제외)',
    binary: 'application/zip',
    responseHeaders: ['Content-Disposition'],
    responses: { 200: null },
  }),
  operation({
    ...lead,
    id: 'listResets',
    method: 'GET',
    path: '/api/system/resets',
    summary: '초기화 기록',
    responses: {
      200: Type.Object({
        items: List(
          Type.Object({
            epoch: c.Epoch,
            at: c.Timestamp,
            actor: Type.String(),
            deletedTaskCount: c.Count,
            keepSettings: Type.Boolean(),
            runnerCleanupStatus: AnyOf('none', 'pending', 'running', 'failed'),
            finishedAt: Nullable(c.Timestamp),
          }),
        ),
      }),
    },
  }),
];

const reportSummary = {
  id: c.Id,
  kind: AnyOf('daily', 'weekly', 'custom'),
  from: c.DateOnly,
  to: c.DateOnly,
  view: c.ReportView,
  generatedAt: c.Timestamp,
  dueAt: Nullable(c.Timestamp),
  reason: Nullable(Type.String()),
};
const reports = [
  operation({
    ...lead,
    id: 'listReports',
    method: 'GET',
    path: '/api/projects/:projectId/reports',
    summary: '보고서 목록(최신순)',
    query: Type.Object({ ...PageQuery, kind: Opt(reportSummary.kind) }),
    responses: { 200: Page(Type.Object(reportSummary)) },
  }),
  operation({
    ...noVersion,
    id: 'createReport',
    method: 'POST',
    path: '/api/projects/:projectId/reports',
    summary: '기간 지정 생성(from ≤ to ≤ 오늘, 최대 93일)',
    body: Body({ from: c.DateOnly, to: c.DateOnly, view: c.ReportView }),
    responses: { 201: Type.Object(reportSummary) },
  }),
  operation({
    ...lead,
    id: 'getReport',
    method: 'GET',
    path: '/api/reports/:reportId',
    summary: '스냅샷 + 「생성 이후 변경」 요약',
    responses: {
      200: Type.Object({
        ...reportSummary,
        snapshot: m.ReportSnapshot,
        // 「생성 이후 일정 재조정 N회 — 현재 완료 예상 X (보고서 기준 Y)」
        changesSince: Type.Object({
          replans: c.Count,
          currentEnd: Nullable(c.DateOnly),
          reportEnd: Nullable(c.DateOnly),
        }),
      }),
    },
  }),
  operation({
    ...lead,
    id: 'getReportPdf',
    method: 'GET',
    path: '/api/reports/:reportId/pdf',
    summary: 'PDF(서버 렌더링, 캐시)',
    query: Type.Object({ view: c.ReportView }),
    binary: 'application/pdf',
    responseHeaders: ['Content-Disposition'],
    responses: { 200: null },
    errors: ['PDF_FAILED'],
  }),
];

const ciPath = '/api/projects/:projectId/ci';
const FlakyTest = Type.Object({
  id: c.Id,
  testKey: Type.String(),
  rate: Type.String(),
  quarantined: Type.Boolean(),
  taskKey: Nullable(c.TaskKey),
  updatedAt: c.Timestamp,
});
// 같은 설정 한 벌의 다른 경로(`/api/settings/ci`). 저장 전에는 updatedAt이 null이다.
const settingVersion = { updatedAt: Nullable(c.Timestamp) };
const ciSettings = Type.Object({ ...m.CiSettings, ...settingVersion });
const ci = [
  operation({
    ...lead,
    id: 'listCiRuns',
    method: 'GET',
    path: `${ciPath}/runs`,
    summary: '실행 기록',
    query: Type.Object({ ...PageQuery, stage: Opt(c.CiStage), taskKey: Opt(c.TaskKey) }),
    responses: { 200: Page(m.CiRun) },
  }),
  operation({
    ...lead,
    id: 'getCiRun',
    method: 'GET',
    path: `${ciPath}/runs/:id`,
    summary: '실행 상세',
    responses: { 200: m.CiRun },
  }),
  operation({
    ...lead,
    id: 'getMergeQueue',
    method: 'GET',
    path: `${ciPath}/queue`,
    summary: '병합 대기열',
    responses: { 200: Type.Object({ items: List(m.MergeQueueItem) }) },
  }),
  operation({
    ...noVersion,
    id: 'retryCiRun',
    method: 'POST',
    path: `${ciPath}/runs/:id/retry`,
    summary: '다시 실행',
    responses: jobCreated,
    errors: ['EXTERNAL_WRITE_BLOCKED'],
  }),
  operation({
    ...noVersion,
    id: 'requestDeployCheck',
    method: 'POST',
    path: `${ciPath}/deploy-check`,
    summary: '배포 확인 요청',
    responses: jobCreated,
    errors: ['EXTERNAL_WRITE_BLOCKED'],
  }),
  operation({
    ...lead,
    id: 'listFlakyTests',
    method: 'GET',
    path: `${ciPath}/flaky`,
    summary: '불안정 테스트',
    responses: { 200: Type.Object({ items: List(FlakyTest) }) },
  }),
  operation({
    ...byBody,
    id: 'updateFlakyTest',
    method: 'PATCH',
    path: `${ciPath}/flaky/:id`,
    summary: '격리·해제',
    body: Body({ ...V, quarantined: Type.Boolean() }),
    responses: { 200: FlakyTest },
  }),
  operation({
    ...lead,
    id: 'getPipeline',
    method: 'GET',
    path: `${ciPath}/pipeline`,
    summary: '파이프라인 정의 표시',
    responses: { 200: m.Pipeline },
  }),
  operation({
    ...lead,
    id: 'getCiSettings',
    method: 'GET',
    path: `${ciPath}/settings`,
    summary: 'CI 실행 설정',
    responses: { 200: ciSettings },
  }),
  operation({
    ...byBody,
    id: 'updateCiSettings',
    method: 'PATCH',
    path: `${ciPath}/settings`,
    summary: 'CI 실행 설정 변경',
    body: Type.Object(
      {
        ...settingVersion,
        nightAt: Opt(m.CiSettings.nightAt),
        retry: Opt(m.CiSettings.retry),
        deployUrl: Opt(m.CiSettings.deployUrl),
      },
      { additionalProperties: false, minProperties: 2 },
    ),
    responses: { 200: ciSettings },
  }),
];

const designPath = '/api/projects/:projectId/design';
const designItem = { key: Type.String(), name: Type.String(), taskKey: Nullable(c.TaskKey), status: Type.String() };
const design = [
  operation({
    ...lead,
    id: 'getDesign',
    method: 'GET',
    path: designPath,
    summary: '설계 버전·결정 수·승인 대기·불일치',
    responses: {
      200: Type.Object({
        version: Nullable(c.Count),
        decisions: c.Count,
        pending: c.Count,
        drifts: c.Count,
        ...m.designOverview,
      }),
    },
  }),
  operation({
    ...lead,
    id: 'listDecisions',
    method: 'GET',
    path: `${designPath}/decisions`,
    summary: '기술 결정 목록',
    responses: { 200: Type.Object({ items: List(m.Decision) }) },
  }),
  operation({
    principal: 'runner',
    id: 'createDecision',
    method: 'POST',
    path: `${designPath}/decisions`,
    summary: '기술 결정 추가. agent는 팀장 승인 대기, free는 재량 기록',
    body: Body({ ...c.JobContext, authority: AnyOf('agent', 'free'), ...m.TechProposal }),
    responses: { 201: m.Decision },
  }),
  ...(['approve', 'reject'] as const).map((action) =>
    operation({
      ...byBody,
      id: `${action}Decision`,
      method: 'POST',
      path: `/api/design/decisions/:id/${action}`,
      summary: `기술 결정 ${action === 'approve' ? '승인' : '반려'}`,
      body: Body({ ...V, comment: Opt(Type.String()) }),
      responses: { 200: m.Decision },
      errors: ['INVALID_TRANSITION'],
    }),
  ),
  operation({
    ...byBody,
    id: 'changeDecision',
    method: 'POST',
    path: '/api/design/decisions/:id/change',
    summary: '기술 결정 변경 제안',
    body: Body({ ...V, choice: Text, reason: Text }),
    responses: { 200: m.Decision },
    errors: ['INVALID_TRANSITION'],
  }),
  operation({
    ...lead,
    id: 'listInterfaces',
    method: 'GET',
    path: `${designPath}/interfaces`,
    summary: '인터페이스 목록',
    query: Type.Object({ kind: Opt(m.IfaceKind) }),
    responses: { 200: Type.Object({ items: List(Type.Object({ ...designItem, kind: m.IfaceKind })) }) },
  }),
  operation({
    ...lead,
    id: 'getInterface',
    method: 'GET',
    path: `${designPath}/interfaces/:key`,
    summary: '인터페이스 상세',
    responses: { 200: Type.Object({ ...designItem, kind: m.IfaceKind, source: m.DesignSource, content: m.IfaceContent }) },
  }),
  operation({
    ...lead,
    id: 'listDataItems',
    method: 'GET',
    path: `${designPath}/data`,
    summary: '데이터 항목 목록',
    query: Type.Object({ store: Opt(m.DesignStore) }),
    responses: { 200: Type.Object({ items: List(Type.Object({ ...designItem, store: m.DesignStore })) }) },
  }),
  operation({
    ...lead,
    id: 'getDataItem',
    method: 'GET',
    path: `${designPath}/data/:key`,
    summary: '데이터 항목 상세',
    responses: { 200: Type.Object({ ...designItem, store: m.DesignStore, source: m.DesignSource, content: m.DataContent }) },
  }),
  operation({
    ...lead,
    id: 'getOwnership',
    method: 'GET',
    path: `${designPath}/ownership`,
    summary: '소유권·흐름',
    responses: {
      200: Type.Object({
        items: List(
          Type.Object({
            data: Type.String(),
            source: Type.String(),
            copy: Type.String(),
            sync: Type.String(),
            lag: Type.String(),
          }),
        ),
      }),
    },
  }),
  operation({
    ...lead,
    id: 'listDrifts',
    method: 'GET',
    path: `${designPath}/drifts`,
    summary: '불일치',
    responses: { 200: Type.Object({ items: List(m.Drift) }) },
  }),
  operation({
    ...byBody,
    id: 'resolveDrift',
    method: 'POST',
    path: `${designPath}/drifts/:id/resolve`,
    summary: '불일치 처리. contract는 Runner job의 결과 커밋 뒤 resolved',
    body: Body({ ...V, how: AnyOf('contract', 'code') }),
    responses: { 200: m.Drift, 202: Type.Object({ jobId: c.Id }) },
    errors: ['EXTERNAL_WRITE_BLOCKED', 'INVALID_TRANSITION'],
  }),
];

export const projectOperations = [...project, ...reports, ...ci, ...design];
