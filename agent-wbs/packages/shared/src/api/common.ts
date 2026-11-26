import Type, { type TProperties, type TSchema } from 'typebox';
import * as v from '../vocabulary.ts';
import { ERROR_CODES } from './errors.ts';

/** 요청 본문. 정의하지 않은 필드는 거부한다(예: Task PATCH의 status). */
export const Body = <T extends TProperties>(properties: T) => Type.Object(properties, { additionalProperties: false });
export const AnyOf = <const T extends readonly string[]>(...values: T) => Type.Enum(values as unknown as [...T]);
const Named = <const T extends readonly string[]>(title: string, ...values: T) =>
  Type.Enum(values as unknown as [...T], { title });
export const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
export const Opt = Type.Optional;
export const List = Type.Array;
/** 자유 구조 JSON(명세·스냅샷). 저장 시 검증은 데이터를 소유하는 작업이 맡는다. */
export const Json = Type.Record(Type.String(), Type.Unknown());
export const Text = Type.String({ minLength: 1, pattern: '\\S' });
export const Id = Type.String({ title: 'Id', minLength: 1, maxLength: 128 });
export const Uuid = Type.String({ title: 'Uuid', pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' });
export const TaskKey = Type.String({ title: 'TaskKey', pattern: '^TASK-[0-9]{4,}$' });
/*
 * 시각·날짜의 허용 범위(M2-08 재리뷰 R2). 모양만 보는 정규식은 연도 0000·10000·2026-02-30 같은 값을 통과시켜
 * DB(timestamptz·date) 변환에서 500이 났다. 여기 한 곳에서 1970~9999년의 실재하는 날짜·시각만 받는다.
 * - 월별 일수와 윤년(4로 나눠지되 100의 배수는 400의 배수만)을 정규식으로 검사한다.
 * - 시각은 00:00:00~23:59:59(윤초 60 없음), 소수점 아래 최대 6자리(µs), UTC(Z)만.
 * 커서처럼 스키마 밖에서 받은 값은 isTimestamp·isDateOnly로 같은 규칙을 쓴다.
 */
const YEAR = '(?:19[7-9][0-9]|[2-9][0-9]{3})';
const MONTH_DAY = '(?:(?:0[13578]|1[02])-(?:0[1-9]|[12][0-9]|3[01])|(?:0[469]|11)-(?:0[1-9]|[12][0-9]|30)|02-(?:0[1-9]|1[0-9]|2[0-8]))';
const LEAP_YEAR = '(?=19[7-9]|[2-9])(?:[0-9]{2}(?:0[48]|[2468][048]|[13579][26])|(?:[02468][048]|[13579][26])00)';
const DATE = `(?:${YEAR}-${MONTH_DAY}|${LEAP_YEAR}-02-29)`;
const TIME = '(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\\.[0-9]{1,6})?';
export const TIMESTAMP_PATTERN = `^${DATE}T${TIME}Z$`;
export const DATE_PATTERN = `^${DATE}$`;
const TIMESTAMP_RE = new RegExp(TIMESTAMP_PATTERN, 'u');
const DATE_RE = new RegExp(DATE_PATTERN, 'u');
export const isTimestamp = (value: unknown): value is string => typeof value === 'string' && TIMESTAMP_RE.test(value);
export const isDateOnly = (value: unknown): value is string => typeof value === 'string' && DATE_RE.test(value);
/** UTC ISO 8601, 마이크로초까지. 1970~9999년의 실재하는 시각만 */
export const Timestamp = Type.String({ title: 'Timestamp', pattern: TIMESTAMP_PATTERN });
/** 날짜(Asia/Seoul 기준 하루). 1970~9999년의 실재하는 날짜만 */
export const DateOnly = Type.String({ title: 'DateOnly', pattern: DATE_PATTERN });
export const ClockTime = Type.String({ pattern: '^([01][0-9]|2[0-3]):[0-5][0-9]$' });
export const Sha = Type.String({ title: 'Sha', pattern: '^[0-9a-f]{40}([0-9a-f]{24})?$' });
export const Sha256 = Type.String({ title: 'Sha256', pattern: '^[0-9a-f]{64}$' });
/** 저장소 상대 경로. 절대 경로·`..`·역슬래시·제어 문자 거부(P TASK-0012, architecture §4). */
export const RepoPath = Type.String({
  title: 'RepoPath',
  minLength: 1,
  pattern: '^(?!/)(?![A-Za-z]:)(?!(?:.*/)?\\.\\.?(?:/|$))(?!.*//)[^\\\\\\u0000-\\u001f]+$',
});
export const Email = Type.String({ maxLength: 254, pattern: '^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$' });
/** 저장소까지만 허용(G§4.2, P L3748). 브랜치·폴더·파일 주소 거부 */
export const RepoUrl = Type.String({
  title: 'RepoUrl',
  pattern: '^https://github\\.com/[A-Za-z0-9-]+/[A-Za-z0-9._-]+/?$',
});
export const HttpUrl = Type.String({ pattern: '^https?://[^\\s/@]+(/[^\\s]*)?$' });
/** P L6570 */
export const ChatId = Type.String({ pattern: '^-?[0-9]{5,20}$' });
/** P L6554. 마스킹 문자열은 형식에서 거부된다. */
export const BotToken = Type.String({ pattern: '^[0-9]{6,12}:[A-Za-z0-9_-]{20,}$', writeOnly: true });
export const SecretInput = Type.String({ minLength: 1, writeOnly: true });

export const Count = Type.Integer({ minimum: 0 });
export const Fence = Type.Integer({ minimum: 0 });
export const Epoch = Type.Integer({ minimum: 0 });
export const Hours = Type.Number({ minimum: 0 });
export const Pct = Type.Number({ minimum: 0, maximum: 100 });

export const Agent = Named('Agent', ...v.AGENTS);
export const RunRole = Named('RunRole', ...v.RUN_ROLES);
export const AttemptKind = Named('AttemptKind', ...v.ATTEMPT_KINDS);
export const TaskStatus = Named('TaskStatus', ...v.TASK_STATUSES);
export const VerifState = Named('VerifState', 'none', 'running', 'pass', 'fail', 'blocked');
export const WorkType = Named('WorkType', ...v.WORK_TYPES);
export const Domain = Named('Domain', ...v.DOMAINS);
export const Priority = Type.Integer({ minimum: 0, maximum: 3 });
export const DepType = Named('DepType', ...v.DEPENDENCY_TYPES);
export const DesignKind = Named('DesignKind', ...v.DESIGN_KINDS);
export const Confidence = Named('Confidence', ...v.CONFIDENCES);
export const ReadinessKey = AnyOf(
  'claude', 'codex', 'git', 'node', 'pnpm', 'pg', 'repo', 'disk', 'subs', 'obs', 'gh', 'lfs',
);
export const ReadinessStatus = AnyOf('ok', 'warn', 'fail');
export const ObservationState = AnyOf('ok', 'unconfirmed');
export const PassFail = Named('PassFail', ...v.VERIFICATION_RESULTS);
export const StepStatus = Named('StepStatus', 'wait', 'run', 'done', 'fail');
export const CiStage = Named('CiStage', 'task', 'int', 'night', 'deploy');
export const CiStatus = Named('CiStatus', 'queued', 'run', 'pass', 'fail', 'skip');
export const QueueStatus = Named('QueueStatus', 'waiting_verify', 'queued', 'checking', 'merged', 'failed', 'removed');
export const ReportView = Named('ReportView', 'int', 'ext');
export const GithubMode = Named('GithubMode', 'gh', 'token');
/**
 * GitHub 권한 하나의 확인 상태(조정자 결정 2026-11-26). verified=확인됨, unverified=미확인(추정하지 않음), missing=부족.
 * fine-grained 토큰은 응답으로 권한을 알 수 없어 쓰기 권한이 unverified로 시작하고, 첫 실제 쓰기 결과로 바뀐다.
 */
export const GithubPermission = Named('GithubPermission', 'verified', 'unverified', 'missing');
export const GithubScopes = Type.Object({
  contents: GithubPermission,
  pulls: GithubPermission,
  statuses: GithubPermission,
  metadata: GithubPermission,
});

/** job 결과 보고의 소유권(contracts §3.2-4). 낡은 fence는 LEASE_LOST */
export const JobContext = { jobId: Id, fence: Fence };

/** 편집 화면이 본 버전(contracts §1.3) */
export const Version = { updatedAt: Timestamp };

export const ErrorResponse = Type.Object(
  {
    error: Type.Object({
      code: AnyOf(...ERROR_CODES),
      message: Type.String(),
      action: Type.String(),
      fix: Type.String(),
      errors: List(Type.Object({ path: Type.String(), rule: Type.String(), message: Type.String() })),
      details: Json,
      requestId: Type.String(),
    }),
  },
  { title: 'ErrorResponse' },
);

export const Page = <T extends TSchema>(item: T) =>
  Type.Object({ items: List(item), nextCursor: Nullable(Type.String()) });
export const PageQuery = {
  limit: Opt(Type.Integer({ minimum: 1 })),
  cursor: Opt(Type.String({ minLength: 1 })),
};
