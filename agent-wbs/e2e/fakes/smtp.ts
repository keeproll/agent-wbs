/**
 * 로컬 가짜 SMTP 서버(M6-03). 실제 메일 서버에 연결하지 않고 메일 발송을 시험한다(Q-13 미결, milestones M6-03).
 *
 * - 127.0.0.1의 빈 포트에서만 듣는다. 밖으로 메일을 내보내지 않는다.
 * - 받은 메일은 `messages`에 원문 그대로 쌓는다. 시험은 이 원문을 읽어 HTML·text/plain을 확인한다.
 * - `mode`로 실패를 흉내 낸다.
 *   - `accept`: 정상 수락(250).
 *   - `auth_fail`: 로그인 거부(535). 본문을 보내기 전에 확실히 실패한다.
 *   - `temp_fail`: 본문을 받은 뒤 명시적 일시 거부(451). 수락되지 않은 것이 확실하다.
 *   - `hold`: 본문을 받아 저장한 뒤 응답하지 않는다. 보낸 쪽은 수락 여부를 알 수 없다(응답 유실·timeout).
 *   - `drop`: 본문을 받아 저장한 뒤 연결을 끊는다(응답 유실).
 *   - `drop_on_mail`: 보내는 사람(MAIL FROM)을 받자마자 연결을 끊는다. 본문을 보내기 **전**이라 수락되지 않은 것이 확실하다.
 * - `onMessage`: 본문을 저장한 직후, 응답하기 **전에** 부른다. 「서버는 받았는데 보낸 쪽이 응답을 받기 전에 죽은」 순간을 만들 때 쓴다.
 * 용어: SMTP = 메일을 보내는 표준 방식. 250·354·451·535 = SMTP 응답 번호(2xx 성공, 3xx 계속, 4xx 일시 실패, 5xx 영구 실패).
 */
import { createServer, type Server, type Socket } from 'node:net';
import { createServer as createTlsServer, createSecureContext, TLSSocket, type TlsOptions } from 'node:tls';

type SmtpTls = Pick<TlsOptions, 'key' | 'cert'> & { starttls?: boolean };

export type SmtpMode = 'accept' | 'auth_fail' | 'temp_fail' | 'hold' | 'drop' | 'drop_on_mail';
export interface SmtpMessage { from: string; to: string[]; raw: string; user: string | null }

export class FakeSmtp {
  readonly messages: SmtpMessage[] = [];
  mode: SmtpMode = 'accept';
  /** 받는 사람별 거부(RCPT 550). 주소는 소문자 */
  readonly rejectRecipients = new Set<string>();
  user = 'agent-wbs';
  password = 'fake-password';
  onMessage: ((message: SmtpMessage) => Promise<void> | void) | null = null;
  /** 연결 수(연결 확인 시험에 쓴다) */
  connections = 0;
  private readonly server: Server;
  private readonly sockets = new Set<Socket>();
  private readonly tls: SmtpTls | undefined;
  port = 0;

  constructor(tls?: SmtpTls) {
    this.tls = tls;
    this.server = tls && !tls.starttls
      ? createTlsServer(tls, (socket) => { this.session(socket, true); })
      : createServer((socket) => { this.session(socket); });
  }

  async start(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('가짜 SMTP 주소를 알 수 없습니다.');
    this.port = address.port;
    return this.port;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => { resolve(); }));
  }

  private session(socket: Socket, secured = false, greet = true) {
    this.connections++;
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => undefined);
    socket.setEncoding('utf8');
    const say = (line: string) => { if (!socket.destroyed) socket.write(`${line}\r\n`); };
    let buffer = '';
    let inData = false;
    let data = '';
    let authStep: 'login-user' | 'login-pass' | null = null;
    let loginUser = '';
    let user: string | null = null;
    let from = '';
    let to: string[] = [];
    const authenticate = (name: string, pass: string) => {
      if (this.mode === 'auth_fail' || name !== this.user || pass !== this.password) { say('535 5.7.8 Authentication credentials invalid'); return; }
      user = name;
      say('235 2.7.0 Authentication successful');
    };
    const finishData = async () => {
      const raw = data.replace(/\r\n\.\./g, '\r\n.');
      const message: SmtpMessage = { from, to, raw, user };
      this.messages.push(message);
      from = ''; to = [];
      await this.onMessage?.(message);
      if (this.mode === 'hold') return;
      if (this.mode === 'drop') { socket.destroy(); return; }
      if (this.mode === 'temp_fail') { this.messages.pop(); say('451 4.7.1 Try again later'); return; }
      say('250 2.0.0 OK queued');
    };
    const line = (text: string) => {
      if (authStep === 'login-user') { loginUser = Buffer.from(text, 'base64').toString(); authStep = 'login-pass'; say('334 UGFzc3dvcmQ6'); return; }
      if (authStep === 'login-pass') { authStep = null; authenticate(loginUser, Buffer.from(text, 'base64').toString()); return; }
      const [verb = '', ...rest] = text.split(' ');
      const arg = rest.join(' ');
      switch (verb.toUpperCase()) {
        case 'EHLO':
          say('250-fake.smtp.local');
          if (this.tls?.starttls && !secured) say('250-STARTTLS');
          say('250-AUTH PLAIN LOGIN'); say('250 8BITMIME'); return;
        case 'STARTTLS': {
          if (!this.tls?.starttls || secured) { say('454 TLS unavailable'); return; }
          say('220 Ready to start TLS');
          socket.removeAllListeners('data');
          const upgraded = new TLSSocket(socket, { isServer: true, secureContext: createSecureContext(this.tls) });
          this.session(upgraded, true, false);
          return;
        }
        case 'HELO': say('250 fake.smtp.local'); return;
        case 'AUTH': {
          const [method = '', initial] = arg.split(' ');
          if (method.toUpperCase() === 'PLAIN') {
            const [, name = '', pass = ''] = Buffer.from(initial ?? '', 'base64').toString().split('\0');
            authenticate(name, pass);
          } else if (method.toUpperCase() === 'LOGIN') { authStep = 'login-user'; say('334 VXNlcm5hbWU6'); }
          else say('504 5.5.4 Unrecognized authentication type');
          return;
        }
        case 'MAIL':
          if (this.mode === 'drop_on_mail') { socket.destroy(); return; }
          from = /<([^>]*)>/.exec(arg)?.[1] ?? ''; to = []; say('250 2.1.0 OK'); return;
        case 'RCPT': {
          const address = (/<([^>]*)>/.exec(arg)?.[1] ?? '').toLowerCase();
          if (this.rejectRecipients.has(address)) { say('550 5.1.1 No such user'); return; }
          to.push(address); say('250 2.1.5 OK'); return;
        }
        case 'DATA': inData = true; data = ''; say('354 End data with <CR><LF>.<CR><LF>'); return;
        case 'RSET': from = ''; to = []; say('250 2.0.0 OK'); return;
        case 'NOOP': say('250 2.0.0 OK'); return;
        case 'QUIT': say('221 2.0.0 Bye'); socket.end(); return;
        default: say('502 5.5.2 Command not recognized');
      }
    };
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0 && !(buffer.startsWith('.\r\n') && data === '')) return;
          if (end < 0) { buffer = buffer.slice(3); } else { data += buffer.slice(0, end); buffer = buffer.slice(end + 5); }
          inData = false;
          void finishData();
          continue;
        }
        const at = buffer.indexOf('\r\n');
        if (at < 0) return;
        const text = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        line(text);
      }
    });
    if (greet) say('220 fake.smtp.local ESMTP');
  }
}

/** 원문에서 한 부분(text/plain·text/html)을 꺼낸다. quoted-printable·base64를 푼다. */
export function mimePart(raw: string, type: 'text/plain' | 'text/html'): string | null {
  // PDF를 붙이면 multipart/mixed 안에 multipart/alternative가 들어간다(Q-13 외부 수신자). 모든 경계로 나눠 안쪽 본문까지 찾는다.
  const boundaries = [...raw.matchAll(/boundary="?([^";\r\n]+)"?/gi)].map((m) => m[1] ?? '').filter(Boolean);
  const parts = boundaries.length ? boundaries.reduce<string[]>((list, boundary) => list.flatMap((x) => x.split(`--${boundary}`)), [raw]) : [raw];
  for (const part of parts) {
    const split = part.indexOf('\r\n\r\n');
    if (split < 0) continue;
    const head = part.slice(0, split);
    if (!new RegExp(`content-type:\\s*${type.replace('/', '\\/')}`, 'i').test(head)) continue;
    const body = part.slice(split + 4).replace(/\r\n$/, '');
    const encoding = /content-transfer-encoding:\s*([\w-]+)/i.exec(head)?.[1]?.toLowerCase();
    if (encoding === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    if (encoding === 'quoted-printable') {
      const bytes = body.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      return Buffer.from(bytes, 'latin1').toString('utf8');
    }
    return body;
  }
  return null;
}

/** 머리글(Subject 등)을 푼다. RFC 2047 인코딩(=?UTF-8?B?…?=)을 풀어 돌려준다. */
export function mimeHeader(raw: string, name: string): string | null {
  const head = raw.slice(0, raw.indexOf('\r\n\r\n'));
  const match = new RegExp(`^${name}:\\s*((?:.*)(?:\\r\\n[ \\t].*)*)`, 'im').exec(head);
  if (!match?.[1]) return null;
  return match[1].replace(/\r\n[ \t]/g, ' ').replace(/=\?utf-8\?([bq])\?([^?]*)\?=\s*/gi, (_m, enc: string, text: string) =>
    enc.toLowerCase() === 'b' ? Buffer.from(text, 'base64').toString('utf8')
      : Buffer.from(text.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8')).trim();
}
