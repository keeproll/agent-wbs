/**
 * SMTP 한 번 보내기와 연결 확인(nodemailer, architecture §4 「메일」).
 *
 * 결과는 셋 중 하나다(contracts §4.4).
 * - `accepted`: 서버가 명시적으로 수락했다(250).
 * - `rejected`: 수락되지 않은 것이 **확실하다**. 연결 전 실패, 로그인 거부(535), 명시적 거부(4xx·5xx) 등.
 *   → 실패/재시도 규칙을 적용한다.
 * - `unknown`: 본문을 보내기 시작한 뒤 응답을 받지 못했다(응답 유실·timeout·연결 끊김).
 *   → 서버가 받았을 수도 있으니 자동으로 다시 보내지 않는다.
 *
 * 왜 본문 시작을 직접 재나: nodemailer 오류는 연결 실패와 응답 유실을 같은 `command:'CONN'`으로 알린다(직접 확인함).
 * 그래서 메일 원문을 넘기는 스트림이 **처음 읽힌 순간**(서버가 DATA에 354로 답한 뒤)을 기록해 둘을 가른다.
 */
import { Readable } from 'node:stream';
import MailComposer from 'nodemailer/lib/mail-composer';
import SMTPConnection from 'nodemailer/lib/smtp-connection';
import { redactText } from '../platform/redact.ts';

/** 보안 방식 3가지(P mailVM secs L6512). 값 목록은 원본에 있고 계약은 Text로만 정했다. */
export const SMTP_SECURITY = ['STARTTLS', 'SSL/TLS', '없음'] as const;
export type SmtpSecurity = (typeof SMTP_SECURITY)[number];

export interface SmtpTarget {
  host: string;
  port: number;
  sec: SmtpSecurity;
  /** 비어 있으면 로그인하지 않는다(사내 릴레이) */
  user: string;
  password: string | null;
}
export interface OutgoingMail {
  /**
   * 보내는 사람. 글(옛 설정 그대로)이거나, 허용 목록으로 읽은 이름 · 주소(Q-13 fix3).
   * 이름 · 주소로 주면 메일 생성기가 설정 글을 다시 해석하지 않고 이 두 값으로 From 헤더를 만든다.
   */
  from: string | { name: string; address: string };
  to: string;
  subject: string;
  html: string;
  text: string;
  attachments?: { filename: string; content: Buffer }[];
}
export type SendOutcome =
  | { state: 'accepted'; response: string }
  | { state: 'rejected'; error: string }
  | { state: 'unknown'; error: string };

/** 운영 기본값. 시험은 짧게 준다. */
export const DEFAULT_TIMEOUT_MS = 60_000;

interface SmtpError extends Error { code?: string; responseCode?: number; response?: string; command?: string }

const clip = (s: string) => redactText(s).replace(/\s+/g, ' ').trim().slice(0, 300);

/** 사람이 읽는 원인(발송 기록 · 연결 확인 결과). 비밀번호는 오류 문장에 들어가지 않지만 한 번 더 가린다. */
export function describeError(error: SmtpError, password: string | null): string {
  let text = error.response ?? error.message;
  if (password) text = text.split(password).join('••••');
  const detail = clip(text);
  if (error.code === 'EAUTH' || error.responseCode === 535) return `SMTP 인증 실패 — ${detail}`;
  if (error.responseCode && error.responseCode >= 400 && error.responseCode < 500) return `수신 서버 일시 거부 — ${detail}`;
  if (error.responseCode && error.responseCode >= 500) return `수신 서버 거부 — ${detail}`;
  if (error.code === 'ETIMEDOUT') return `SMTP 서버 응답 시간 초과 — ${detail}`;
  return `SMTP 서버 연결 실패 — ${detail}`;
}

function connection(target: SmtpTarget, timeoutMs: number) {
  return new SMTPConnection({
    host: target.host,
    port: target.port,
    secure: target.sec === 'SSL/TLS',
    requireTLS: target.sec === 'STARTTLS',
    ignoreTLS: target.sec === '없음',
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  });
}

/** 연결 → (계정이 있으면) 로그인까지. 실패하면 오류를 던진다. 본문은 보내지 않는다. */
async function open(conn: SMTPConnection, target: SmtpTarget): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    conn.once('error', reject);
    conn.connect((error) => { if (error) reject(error); else resolve(); });
  });
  if (!target.user) return;
  await new Promise<void>((resolve, reject) => {
    conn.login({ user: target.user, pass: target.password ?? '' }, (error) => { if (error) reject(error); else resolve(); });
  });
}

/** 연결 확인(POST /api/settings/mail/smtp/check). 로그인까지만 하고 끊는다. */
export async function checkSmtp(target: SmtpTarget, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<{ ok: boolean; error: string | null }> {
  const conn = connection(target, timeoutMs);
  conn.on('error', () => undefined);
  try {
    await open(conn, target);
    conn.quit();
    return { ok: true, error: null };
  } catch (error) {
    conn.close();
    return { ok: false, error: describeError(error as SmtpError, target.password) };
  }
}

/** 한 통 보내기. 예외를 던지지 않고 결과 셋 중 하나를 돌려준다. */
export async function sendSmtp(target: SmtpTarget, mail: OutgoingMail, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SendOutcome> {
  const raw = await new MailComposer({
    from: mail.from, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html,
    ...(mail.attachments?.length ? { attachments: mail.attachments } : {}),
  }).compile().build();
  let bodyStarted = false;
  const body = new Readable({
    read() {
      bodyStarted = true;
      this.push(raw);
      this.push(null);
    },
  });
  const envelope = { from: addressOf(mail.from), to: [mail.to] };
  const conn = connection(target, timeoutMs);
  // 연결이 끊기며 나는 오류 이벤트가 프로세스를 죽이지 않게 한다. 결과는 아래 콜백이 정한다.
  conn.on('error', () => undefined);
  try {
    await open(conn, target);
  } catch (error) {
    conn.close();
    return { state: 'rejected', error: describeError(error as SmtpError, target.password) };
  }
  return new Promise<SendOutcome>((resolve) => {
    let settled = false;
    const finish = (outcome: SendOutcome) => { if (!settled) { settled = true; resolve(outcome); } };
    // 응답 없이 연결이 끝나면 send 콜백이 오지 않을 수 있다. 그때도 결과를 정한다.
    conn.once('end', () => {
      finish(bodyStarted
        ? { state: 'unknown', error: '본문 전송 후 응답을 받지 못함 — 수락 여부 불명(받는 쪽에 도착했을 수 있음)' }
        : { state: 'rejected', error: 'SMTP 서버 연결 실패 — 본문을 보내기 전에 연결이 끊김' });
    });
    conn.send(envelope, body, (error, info) => {
      if (!error && info && info.accepted.length > 0) {
        finish({ state: 'accepted', response: clip(info.response) });
        conn.quit();
        return;
      }
      const e = (error ?? new Error('받는 사람이 거부됨')) as SmtpError;
      if (e.responseCode || !bodyStarted) finish({ state: 'rejected', error: describeError(e, target.password) });
      else finish({ state: 'unknown', error: `본문 전송 후 응답을 받지 못함 — 수락 여부 불명(받는 쪽에 도착했을 수 있음) · ${describeError(e, target.password)}` });
      conn.close();
    });
  });
}

/** `Agent WBS <a@example.com>` → `a@example.com` */
export function addressOf(from: string | { name: string; address: string }): string {
  if (typeof from !== 'string') return from.address;
  return /<([^>]+)>/.exec(from)?.[1]?.trim() ?? from.trim();
}
