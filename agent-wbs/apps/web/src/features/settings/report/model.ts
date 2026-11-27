/**
 * 설정 → 보고서 · 메일 탭의 화면 없는 계산(P mailVM L6496-6531, addRecip L4934, saveSmtp L4951).
 * 화면 부품(ReportMailTab.tsx)은 여기 값만 그린다. 그래서 규칙을 브라우저 없이 시험할 수 있다(test/settings-mail-model.test.ts).
 */
import type { ResponseOf } from '../../../shared/api/contract.ts';

export type Recipient = ResponseOf<'listRecipients'>['items'][number];
export type MailLog = ResponseOf<'listMailLog'>['items'][number];
export type Smtp = ResponseOf<'getSmtp'>;

/** 보기 이름(P mailVM viewL) */
export const VIEW_LABEL = { int: '팀장용 (상세)', ext: '보고용 (요약)' } as const;
/** 보안 방식(P mailVM secs L6512). 고르면 포트도 기본값으로 바뀐다. */
export const SECURITY = [
  { value: 'STARTTLS', label: 'STARTTLS (587)', port: 587 },
  { value: 'SSL/TLS', label: 'SSL/TLS (465)', port: 465 },
  { value: '없음', label: '암호화 없음 (사내 릴레이)', port: 25 },
] as const;

/**
 * 발송 상태 표시(data-model §3.7: 화면에는 G의 4상태, unknown은 「실패 — 수락 여부 불명」).
 * 원본 P는 「발송됨 / 실패」 두 가지만 있다. 큐가 생기며 「대기 · 보내는 중」이 더해졌다.
 */
export function stateLabel(state: string): { label: string; cls: string } {
  switch (state) {
    case 'accepted': return { label: '발송됨', cls: 'vf v-pass' };
    case 'unknown': return { label: '실패 — 수락 여부 불명', cls: 'vf v-fail' };
    case 'failed': return { label: '실패', cls: 'vf v-fail' };
    case 'retry_wait': return { label: '실패 · 15분 후 재시도', cls: 'vf v-fail' };
    case 'sending': return { label: '보내는 중', cls: 'vf v-run' };
    default: return { label: '대기', cls: 'vf v-none' };
  }
}

/** 이메일 형식(P Sel.mailOk L4045, 서버 addRecipient와 같다) */
export const mailOk = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());

export interface RecipientForm { email: string; name: string; daily: boolean; weekly: boolean; view: 'int' | 'ext'; pdf: boolean; external: boolean }
/** 받는 사람 추가 폼의 처음 값(P addRecip 뒤 초기화 L4940). 외부 수신자(Q-13 결정 A)는 원본에 없어 기본값은 내부다. */
export const BLANK_RECIPIENT: RecipientForm = { email: '', name: '', daily: true, weekly: true, view: 'int', pdf: false, external: false };

/**
 * 외부 수신자 안내(Q-13 결정 A, G L1052 · L1153).
 * 앱 링크는 같은 PC · 같은 네트워크에서만 열리므로, 외부 수신자에게는 링크 없이 보고용 + PDF만 보낸다. 일간(팀장용만 있음)은 받지 않는다.
 */
export const EXTERNAL_HINT = '회사 밖 · 다른 네트워크에서 받는 사람 — 앱 링크 없이 보고용 본문 + PDF 첨부로만 보냅니다. 일간 보고서는 팀장용만 있어 받지 않습니다.';
export const EXTERNAL_DAILY_ERROR = '외부 수신자는 일간 보고를 받을 수 없습니다 — 일간 보고서는 팀장용만 있습니다.';

/** 「외부」를 켜면 외부 규칙(일간 끔 · 보고용 · PDF 첨부)으로 맞춘 폼. 끄면 다른 칸은 그대로 둔다. */
export const withExternal = (form: RecipientForm, external: boolean): RecipientForm =>
  external ? { ...form, external, daily: false, weekly: true, view: 'ext', pdf: true } : { ...form, external };

/** 받는 사람 추가 전 검사(P addRecip L4936 문구 그대로). 통과하면 빈 문자열 */
export function recipientError(form: RecipientForm, existing: readonly Recipient[]): string {
  const email = form.email.trim().toLowerCase();
  if (!email) return '이메일 주소를 입력하세요.';
  if (!mailOk(email)) return '이메일 형식이 올바르지 않습니다 — 예: name@example.com';
  if (existing.some((r) => r.email.toLowerCase() === email)) return '이미 등록된 주소입니다.';
  if (!form.daily && !form.weekly) return '일간 · 주간 중 하나 이상 선택하세요.';
  if (form.external && form.daily) return EXTERNAL_DAILY_ERROR;
  return '';
}

export interface SmtpForm { host: string; port: string; sec: string; from: string; user: string; pw: string }
/** SMTP 저장 전 검사(P saveSmtp L4952 문구 그대로). 통과하면 빈 문자열 */
export function smtpError(form: SmtpForm, pwSet: boolean): string {
  const from = /<([^>]+)>/.exec(form.from)?.[1] ?? form.from;
  if (!form.host.trim()) return 'SMTP 서버를 입력하세요.';
  const port = Number(form.port);
  if (!(Number.isInteger(port) && port > 0 && port < 65536)) return '포트는 1 ~ 65535 사이 숫자입니다.';
  if (!mailOk(from)) return '보내는 주소 형식이 올바르지 않습니다 — 예: Agent WBS <agent-wbs@example.com>';
  if (!form.pw && !pwSet && form.user.trim()) return '계정을 입력했다면 비밀번호(앱 비밀번호)도 입력하세요.';
  return '';
}

/** 받는 사람별 「최근 발송」(P mailVM recL L6497). 기록은 최신 먼저 온다. at은 화면이 서울 시각으로 바꿔 보인다. */
export function lastSend(log: readonly MailLog[], recipientId: string): { label: string; cls: string; at: string | null; reportKey: string | null } {
  const last = log.find((l) => l.recipientId === recipientId);
  if (!last) return { label: '발송 기록 없음', cls: 'vf v-none', at: null, reportKey: null };
  const s = stateLabel(last.state);
  return { label: s.label, cls: s.cls, at: last.at, reportKey: last.reportKey };
}

/** 받는 사람 요약(P mailVM sumL) */
export function recipientSummary(list: readonly Recipient[]): string {
  const on = list.filter((r) => r.active);
  return `수신자 ${String(list.length)}명 · 받는 중 ${String(on.length)} (일간 ${String(on.filter((r) => r.daily).length)} · 주간 ${String(on.filter((r) => r.weekly).length)})`;
}

/** 발송 기록 화면 표시 최대 행(P mailVM L6505: 최근 40건) */
export const LOG_LIMIT = 40;
