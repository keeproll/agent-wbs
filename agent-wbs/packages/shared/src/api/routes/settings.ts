import Type, { type TProperties } from 'typebox';
import * as c from '../common.ts';
import * as m from '../models.ts';
import { operation } from '../operation.ts';

const { AnyOf, Body, Nullable, Opt, List, Text, Page, PageQuery } = c;
const lead = { principal: 'lead' } as const;
const byBody = { ...lead, version: 'body' } as const;
const noVersion = { ...lead, version: 'none' } as const;
/** 아직 저장한 적이 없으면 null(초기화 직후) */
const settingVersion = { updatedAt: Nullable(c.Timestamp) };
const jobCreated = { 202: Type.Object({ jobId: c.Id }) };

/** GET·PUT 쌍. 응답은 저장값 + updatedAt */
const setting = <const Name extends string, T extends TProperties, W extends TProperties = Record<never, never>, R extends TProperties = Record<never, never>>(
  name: Name,
  path: string,
  summary: string,
  fields: T,
  extra: { write?: W; read?: R } = {},
) => [
  operation({
    ...lead,
    id: `get${name}` as const,
    method: 'GET',
    path,
    summary: `${summary} 조회`,
    responses: { 200: Type.Object({ ...fields, ...extra.read as R, ...settingVersion }) },
  }),
  operation({
    ...byBody,
    id: `put${name}` as const,
    method: 'PUT',
    path,
    summary: `${summary} 저장`,
    body: Body({ ...settingVersion, ...fields, ...extra.write as W }),
    responses: { 200: Type.Object({ ...fields, ...extra.read as R, ...settingVersion }) },
  }),
];

const SPLIT_RULES = ['one', 'domain', 'size', 'verify', 'revert', 'cg', 'contract', 'irrev', 'refactor', 'unknown'];

const settings = [
  // G§5.2-1·P L6703: 예외를 반영한 진행 전·진행 중 Task 위반 목록. count는 탭 배지의 Task 수다.
  operation({
    ...lead, id: 'getSplitViolations', method: 'GET', path: '/api/settings/split/violations',
    summary: '분할 기준 위반·의심 목록과 배지',
    responses: { 200: Type.Object({
      count: c.Count,
      items: List(Type.Object({
        taskKey: c.TaskKey, title: Text, wbs: Type.String(),
        violations: c.Count, suspicions: c.Count, cautions: c.Count, exceptions: c.Count,
        approvalHolds: List(Type.String()),
        items: List(Type.Object({
          rule: Type.String(), label: Text, mode: AnyOf('auto', 'judge'),
          status: AnyOf('통과', '의심', '위반', '주의', '판단', '예외', '꺼짐'),
          detail: Type.String(), judgement: Nullable(AnyOf('met', 'not_met', 'missing')),
        })),
      })),
    }) },
  }),
  // G L869·P L6710~6716·L6763: 지정 Task와 관측으로 확인한 실제 사용을 구분한다.
  operation({
    ...lead, id: 'getAgentUsage', method: 'GET', path: '/api/settings/agent-usage',
    summary: '팀장 고정 Task·모델·하위 Agent 사용 현황',
    responses: { 200: Type.Object({
      lockedTasks: List(Type.Object({ taskKey: c.TaskKey, title: Text, role: AnyOf('dev', 'qa'), agent: c.Agent, modelId: Text, effort: Text })),
      models: List(Type.Object({ agent: c.Agent, modelId: Text, taskKeys: List(c.TaskKey) })),
      subagents: List(Type.Object({
        id: c.Id, defKey: Text, version: c.PositiveInt4, taskKeys: List(c.TaskKey),
        lastTaskKey: Nullable(c.TaskKey), lastAttemptKey: Nullable(Text), lastUsedAt: Nullable(c.Timestamp),
        decisions: c.Count, failures: c.Count, reworkRate: Nullable(Type.Number({ minimum: 0, maximum: 1 })),
      })),
    }) },
  }),
  operation({
    ...noVersion, id: 'ackAlert', method: 'POST', path: '/api/alerts/:id/ack',
    summary: '알림 확인(반복 가능, 현재 목록에서 제외)', responses: { 204: null },
  }),
  // P L2282: 접수만으로 점검 결과를 바꾸지 않는다. Runner 정책의 증가 번호로 재점검을 전달한다.
  operation({
    ...noVersion, id: 'checkReadiness', method: 'POST', path: '/api/settings/readiness/check',
    summary: 'Runner 준비 상태 다시 점검 요청', responses: { 202: Type.Object({ readinessCheckRequest: c.Count }) },
  }),
  ...setting('WorkflowSettings', '/api/settings/workflow', 'Agent 역할·기본 Workflow', {
    devAgent: c.Agent,
    qaAgent: c.Agent,
    liveInject: Type.Boolean(),
    heartbeatSeconds: c.PositiveInt4,
    missedHeartbeats: c.PositiveInt4,
  }),
  ...setting('ExecPolicy', '/api/settings/exec-policy', '실행 정책', {
    ...m.ExecPolicy,
    floors: Body({ verifyGeDev: Type.Boolean(), dbHigh: Type.Boolean() }),
    autoRetryLimit: c.Int4Count,
    autoReworkLimit: c.Int4Count,
  }),
  // 모델 정보는 Runner 보고, 매핑은 owner 승인표다. 팀장은 허용과 순서·Claude 목록을 정한다(G§7.1, Q-06, owner 2026-11-26 아이템 8).
  // rank는 rankOrder(아래부터)에서 서버가 계산한 값이다. 순서·목록은 바꿀 때만 보낸다.
  ...setting('ModelSettings', '/api/settings/models', '허용 모델·모델 순서', {}, {
    write: {
      models: List(Body({ agent: c.Agent, id: Text, allowed: Type.Boolean() })),
      rankOrder: Opt(m.ModelRankOrder),
      codexFamilyOrder: Opt(m.CodexFamilyOrder),
      claudeModels: Opt(m.ClaudeModels),
    },
    read: {
      rankOrder: m.ModelRankOrder,
      codexFamilyOrder: m.CodexFamilyOrder,
      claudeModels: m.ClaudeModels,
      models: List(
        Type.Object({
          agent: c.Agent,
          id: Type.String(),
          label: Type.String(),
          rank: Type.Integer(),
          allowed: Type.Boolean(),
          isNew: Type.Boolean(),
          // 지원 값 미확인이면 null. 공통 단계가 없으면(ultra 등) level이 null
          efforts: Nullable(
            List(Type.Object({ key: Type.String(), level: Nullable(Type.Integer({ minimum: 1, maximum: 5 })) })),
          ),
        }),
      ),
    },
  }),
  ...setting('SplitSettings', '/api/settings/split', 'Task 분할 기준', {
    maxHours: Type.Number({ exclusiveMinimum: 0 }),
    minHours: Type.Number({ exclusiveMinimum: 0 }),
    maxFiles: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    testIn: Type.Boolean(),
    dir: AnyOf('layer'),
    on: Body(Object.fromEntries(SPLIT_RULES.map((rule) => [rule, Type.Boolean()]))),
  }),
  ...setting('ScheduleSettings', '/api/settings/schedule', '일정 재조정 정책', {
    autoReplan: Type.Boolean(),
    cpAuto: Type.Boolean(),
    thresholdDays: Type.Number({ minimum: 0 }),
    assumeRate: Type.Number({ exclusiveMinimum: 0, maximum: 1 }),
    windowDays: c.PositiveInt4,
    minHours: c.Hours,
  }),
  ...setting('Blackouts', '/api/settings/blackouts', '작업 불가일', {
    days: List(Body({ date: c.DateOnly, note: Type.String() })),
  }),
  ...setting('Concurrency', '/api/settings/concurrency', '동시 실행 상한', {
    mode: AnyOf('auto', 'manual'),
    caps: Body(m.Caps),
    memReserveGB: Type.Number({ minimum: 0 }),
  }),
  ...setting('ObsBudget', '/api/settings/obs-budget', '하위 Agent 동시 예산', { budget: m.SubagentBudget }),
  ...setting(
    'SubagentSettings',
    '/api/settings/subagents',
    '하위 Agent 사용·허용',
    { enabled: Type.Boolean() },
    {
      write: { allowed: List(Body({ id: c.Id, allowed: Type.Boolean() })) },
      read: {
        defs: List(
          Type.Object({
            id: c.Id,
            version: c.Int4Count,
            agent: c.Agent,
            role: Type.String(),
            tools: Type.String(),
            sandbox: Type.String(),
            text: Type.String(),
            hash: Type.String(),
            allowed: Type.Boolean(),
            ref: Nullable(Type.String()),
          }),
        ),
      },
    },
  ),
  ...setting('CiDefaults', '/api/settings/ci', 'CI 실행 설정', m.CiSettings),
  ...setting(
    'GithubSettings',
    '/api/settings/github',
    'GitHub 연결',
    { mode: c.GithubMode },
    {
      write: { token: Opt(c.SecretInput) },
      read: {
        tokenSet: Type.Boolean(),
        status: Type.String(),
        account: Nullable(Type.String()),
        scopes: Nullable(c.GithubScopes),
        // 미확인 권한 등 알릴 것이 있을 때의 문구. 없으면 null
        warning: Nullable(Type.String()),
        expiresAt: Nullable(c.Timestamp),
        checkedAt: Opt(Nullable(c.Timestamp)),
      },
    },
  ),
  operation({
    ...noVersion,
    id: 'checkGithub',
    method: 'POST',
    path: '/api/settings/github/check',
    summary: 'GitHub 연결 확인 요청(Runner)',
    responses: jobCreated,
  }),
  ...setting(
    'AppUrl',
    '/api/settings/app-url',
    'Agent WBS 접속 주소(메일·Telegram 공용, 빈 값이면 링크 없음)',
    { appUrl: Nullable(c.HttpUrl) },
  ),
];

/* ---- 메일(G§8.5) ---- */
const smtp = {
  host: Text,
  port: Type.Integer({ minimum: 1, maximum: 65535 }),
  // 값 목록이 원본에 없다(P Mock은 STARTTLS)
  sec: Text,
  from: Text,
  user: Type.String(),
};
const subscription = { daily: Type.Boolean(), weekly: Type.Boolean(), view: c.ReportView, pdf: Type.Boolean() };
const Recipient = Type.Object(
  {
    id: c.Id,
    email: Type.String(),
    name: Type.String(),
    ...subscription,
    active: Type.Boolean(),
    // M6-03: 등록 시각(P 받는 사람 표 「등록 2026-10-27 09:50」)
    createdAt: c.Timestamp,
    updatedAt: c.Timestamp,
  },
  { title: 'Recipient' },
);
const MailLog = Type.Object(
  {
    id: c.Id,
    reportId: c.Id,
    // M6-03: 보고서 표시 번호(RPT-…)·PDF 첨부 여부·아직 해소되지 않은 실패인지(같은 보고서·같은 사람의 마지막 발송이 실패)
    reportKey: Type.String(),
    pdf: Type.Boolean(),
    pending: Type.Boolean(),
    recipientId: Nullable(c.Id),
    to: Type.String(),
    subject: Type.String(),
    view: c.ReportView,
    tryNo: Type.Integer({ minimum: 1 }),
    state: AnyOf('queued', 'sending', 'accepted', 'retry_wait', 'failed', 'unknown'),
    error: Nullable(Type.String()),
    reason: Type.String(),
    at: c.Timestamp,
  },
  { title: 'MailLog' },
);
const queued = { 202: Type.Object({ ids: List(c.Id) }) };

const mail = [
  operation({
    ...lead,
    id: 'getSmtp',
    method: 'GET',
    path: '/api/settings/mail/smtp',
    summary: 'SMTP 설정(비밀번호는 pwSet만)',
    responses: {
      200: Type.Object({
        ...smtp, host: Type.String(), from: Type.String(), pwSet: Type.Boolean(), ...settingVersion,
        // M6-03: 마지막 연결 확인 결과(화면의 정상/실패 표시·실패 배너). 확인 전이거나 설정을 바꾼 뒤면 null
        check: Nullable(Type.Object({ ok: Type.Boolean(), checkedAt: c.Timestamp, error: Nullable(Type.String()) })),
      }),
    },
  }),
  operation({
    ...byBody,
    id: 'putSmtp',
    method: 'PUT',
    path: '/api/settings/mail/smtp',
    summary: 'SMTP 저장. password는 교체할 때만',
    body: Body({ ...settingVersion, ...smtp, password: Opt(c.SecretInput) }),
    responses: { 200: Type.Object({ ...smtp, pwSet: Type.Boolean(), ...settingVersion, check: Nullable(Type.Object({ ok: Type.Boolean(), checkedAt: c.Timestamp, error: Nullable(Type.String()) })) }) },
  }),
  operation({
    ...noVersion,
    id: 'checkSmtp',
    method: 'POST',
    path: '/api/settings/mail/smtp/check',
    summary: 'SMTP 연결 확인',
    responses: {
      200: Type.Object({ ok: Type.Boolean(), checkedAt: c.Timestamp, error: Nullable(Type.String()) }),
    },
  }),
  operation({
    ...lead,
    id: 'listRecipients',
    method: 'GET',
    path: '/api/settings/mail/recipients',
    summary: '받는 사람',
    responses: { 200: Type.Object({ items: List(Recipient) }) },
  }),
  operation({
    ...noVersion,
    id: 'addRecipient',
    method: 'POST',
    path: '/api/settings/mail/recipients',
    summary: '받는 사람 추가(중복 409, 구독 하나 이상)',
    body: Body({ email: c.Email, name: Type.String(), ...subscription }),
    responses: { 201: Recipient },
    errors: ['RECIPIENT_DUPLICATE'],
  }),
  operation({
    ...byBody,
    id: 'updateRecipient',
    method: 'PATCH',
    path: '/api/settings/mail/recipients/:id',
    summary: '구독·보기·PDF·받는 중 변경',
    body: Type.Object(
      {
        ...c.Version,
        daily: Opt(Type.Boolean()),
        weekly: Opt(Type.Boolean()),
        view: Opt(c.ReportView),
        pdf: Opt(Type.Boolean()),
        active: Opt(Type.Boolean()),
      },
      { additionalProperties: false, minProperties: 2 },
    ),
    responses: { 200: Recipient },
  }),
  operation({
    ...lead,
    version: 'query',
    id: 'deleteRecipient',
    method: 'DELETE',
    path: '/api/settings/mail/recipients/:id',
    summary: '받는 사람 삭제(발송 기록 유지)',
    query: Type.Object(c.Version),
    responses: { 204: null },
  }),
  operation({
    ...noVersion,
    id: 'testRecipient',
    method: 'POST',
    path: '/api/settings/mail/recipients/:id/test',
    summary: '테스트 발송(최신 보고서)',
    responses: queued,
  }),
  operation({
    ...noVersion,
    id: 'sendReportMail',
    method: 'POST',
    path: '/api/reports/:reportId/mail',
    summary: '수동 발송',
    body: Body({ recipientIds: List(c.Id, { minItems: 1, uniqueItems: true }), view: Opt(c.ReportView) }),
    responses: queued,
  }),
  operation({
    ...lead,
    id: 'previewReportMail',
    method: 'GET',
    path: '/api/reports/:reportId/mail/preview',
    summary: '메일 HTML 미리보기(실제 발송과 같은 함수)',
    query: Type.Object({ view: Opt(c.ReportView), to: Opt(c.Id) }),
    responses: {
      200: Type.Object({
        subject: Type.String(),
        from: Type.String(),
        to: Type.String(),
        html: Type.String(),
        attachment: Nullable(Type.String()),
      }),
    },
  }),
  operation({
    ...lead,
    id: 'listMailLog',
    method: 'GET',
    path: '/api/mail/log',
    summary: '발송 기록',
    query: Type.Object({ ...PageQuery, status: Opt(AnyOf('failed')) }),
    responses: { 200: Page(MailLog) },
  }),
  operation({
    ...noVersion,
    id: 'resendMail',
    method: 'POST',
    path: '/api/mail/log/:id/resend',
    summary: '다시 보내기',
    responses: queued,
  }),
  operation({
    ...noVersion,
    id: 'resendFailedMail',
    method: 'POST',
    path: '/api/mail/log/resend-failed',
    summary: '실패 전체 다시 보내기',
    responses: queued,
  }),
];

/* ---- Telegram(G§8.7) ---- */
const TelegramError = AnyOf(
  'token_invalid', 'chat_not_found', 'forbidden', 'rate_limited', 'network', 'webhook_in_use', 'chat_migrated',
);
const Bot = Type.Object({ id: Type.Integer(), username: Type.String(), name: Type.String() });
const Chat = Type.Object({ chatId: c.ChatId, title: Type.String(), type: Type.String() });
const TelegramSettings = Type.Object(
  {
    enabled: Type.Boolean(),
    targetName: Type.String(),
    chatId: Nullable(c.ChatId),
    tokenSet: Type.Boolean(),
    tokenLast4: Nullable(Type.String({ maxLength: 4 })),
    bot: Nullable(Bot),
    chat: Nullable(Chat),
    test: Nullable(Type.Object({ ok: Type.Boolean(), error: Nullable(TelegramError), at: c.Timestamp })),
    ...settingVersion,
  },
  { title: 'TelegramSettings' },
);
const telegramResult = { ok: Type.Boolean(), error: Nullable(TelegramError), retryAfter: Nullable(c.Count) };
const TOKEN_OPTIONAL = { botToken: Opt(c.BotToken) };
const NotifyEvent = AnyOf('done', 'fail', 'admin', 'approve', 'buildOk', 'buildFail');
const NotifyRules = {
  done: Type.Boolean(),
  fail: Type.Boolean(),
  admin: Type.Boolean(),
  approve: Type.Boolean(),
  buildOk: Type.Boolean(),
  buildFail: Type.Boolean(),
};
const notifyLog = {
  id: c.Id,
  at: c.Timestamp,
  kind: AnyOf('biz', 'test'),
  event: Nullable(NotifyEvent),
  target: Type.String(),
  // unknown은 화면에서 「실패 — 수락 여부 불명」(data-model §3.7)
  state: AnyOf('queued', 'sending', 'accepted', 'retry_wait', 'failed', 'unknown'),
  attempts: c.Count,
  duplicates: c.Count,
  error: Nullable(Type.String()),
};

const notify = [
  operation({
    ...lead,
    id: 'getTelegram',
    method: 'GET',
    path: '/api/notify/telegram',
    summary: '연결 설정(토큰은 끝 4자리만)',
    responses: { 200: TelegramSettings },
  }),
  operation({
    ...byBody,
    id: 'putTelegram',
    method: 'PUT',
    path: '/api/notify/telegram',
    summary: '연결 설정 저장. botToken은 교체할 때만',
    body: Body({
      ...settingVersion,
      enabled: Type.Boolean(),
      ...TOKEN_OPTIONAL,
      targetName: Type.String(),
      chatId: c.ChatId,
    }),
    responses: { 200: TelegramSettings },
  }),
  operation({
    ...noVersion,
    id: 'checkTelegramBot',
    method: 'POST',
    path: '/api/notify/telegram/check-bot',
    summary: '봇 확인(getMe)',
    body: Body(TOKEN_OPTIONAL),
    responses: { 200: Type.Object({ ...telegramResult, bot: Nullable(Bot) }) },
  }),
  operation({
    ...noVersion,
    id: 'findTelegramChats',
    method: 'POST',
    path: '/api/notify/telegram/find-chats',
    summary: '최근 대화 후보(getUpdates). 자동 선택·저장하지 않음',
    body: Body(TOKEN_OPTIONAL),
    responses: {
      200: Type.Object({
        ...telegramResult,
        candidates: List(Type.Object({ ...Chat.properties, lastAt: c.Timestamp })),
      }),
    },
  }),
  operation({
    ...noVersion,
    id: 'testTelegram',
    method: 'POST',
    path: '/api/notify/telegram/test',
    summary: '테스트 알림(저장 전 값으로 발송)',
    body: Body({ ...TOKEN_OPTIONAL, chatId: c.ChatId, targetName: Type.String() }),
    responses: { 200: Type.Object(telegramResult) },
  }),
  ...setting('NotifyRules', '/api/projects/:projectId/notify/rules', '알림 규칙 6종', NotifyRules),
  operation({
    ...lead,
    id: 'listNotifyLog',
    method: 'GET',
    path: '/api/projects/:projectId/notify/log',
    summary: '전송 이력',
    query: Type.Object({ ...PageQuery, kind: Opt(AnyOf('biz', 'test')) }),
    responses: { 200: Page(Type.Object(notifyLog)) },
  }),
  operation({
    ...lead,
    id: 'getNotifyLog',
    method: 'GET',
    path: '/api/projects/:projectId/notify/log/:id',
    summary: '전송 이력 상세·보낸 메시지',
    responses: { 200: Type.Object({ ...notifyLog, message: Type.String() }) },
  }),
  operation({
    ...lead,
    id: 'previewNotify',
    method: 'GET',
    path: '/api/projects/:projectId/notify/preview',
    summary: '메시지 미리보기(예시 데이터)',
    query: Type.Object({ event: NotifyEvent }),
    responses: { 200: Type.Object({ text: Type.String({ maxLength: 4096 }) }) },
  }),
];

export const settingsOperations = [...settings, ...mail, ...notify];
