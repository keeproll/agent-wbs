import { timingSafeEqual } from 'node:crypto';
import assert from 'node:assert/strict';
import type { Pool, PoolClient } from '@awbs/db';
import { OPERATIONS, type Operation } from '@awbs/shared/api';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomToken, tokenHash, verifyPassword } from './credentials.ts';
import { installErrors, PlatformError } from './errors.ts';
import { dropChanges, flushChanges } from '../changes/events.ts';

export interface SecurityOptions { origin: string; lan: boolean; port?: number }
interface Session { token_hash: string; expires_at: Date; csrf: string }
interface StoredResponse { status: number; payload: string | null; headers: Record<string, string> }
interface Context {
  operation: Operation | undefined;
  principal: string;
  currentEpoch: number;
  epoch: number;
  session?: Session;
  client?: PoolClient;
  idempotency?: { key: string; hash: string; project: string | null };
  /** 오류 응답이어도 트랜잭션을 커밋한다. 업무 처리기가 「보류 판정과 함께 남길 기록(판단 job)」만 쓴 뒤 켠다. 500은 언제나 롤백. */
  commitOnError?: boolean;
}
declare module 'fastify' { interface FastifyRequest { platform: Context | null } }

const write = (request: FastifyRequest) => !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
const loopback = (address: string | undefined) => address === '::1' || /^(?:::ffff:)?127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(address ?? '');
const cookieToken = (request: FastifyRequest): string => {
  const cookies = request.headers.cookie?.split(';').map((part) => part.trim()).filter((part) => part.startsWith('awbs_session=')) ?? [];
  return cookies.length === 1 ? (cookies[0]?.slice('awbs_session='.length) ?? '') : '';
};
const equal = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
};

export async function assertLanPassword(pool: Pool): Promise<void> {
  const result = await pool.query('select 1 from lead_credentials where singleton=true');
  if (!result.rowCount) throw new Error('LAN 기동 거부: 먼저 auth CLI의 set-password로 비밀번호를 설정하세요.');
}

async function finish(request: FastifyRequest, commit: boolean): Promise<void> {
  const context = request.platform;
  const client = context?.client;
  if (!client || !context) return;
  delete context.client;
  try {
    // 트랜잭션 중간에 모아 둔 변경 이벤트는 모든 업무 잠금 뒤, 커밋 직전에 쓴다(changes/events.ts deferChange).
    if (commit) await flushChanges(client); else dropChanges(client);
    await client.query(commit ? 'commit' : 'rollback');
  } catch (error) { dropChanges(client); client.release(true); throw error; }
  client.release();
}

export function installSecurity(app: FastifyInstance, pool: Pool, options: SecurityOptions): void {
  installErrors(app, pool);
  app.decorateRequest('platform', null);
  const originUrl = new URL(options.origin);
  const localPort = options.port ?? Number(originUrl.port || (originUrl.protocol === 'https:' ? 443 : 80));
  const localOrigins = [`http://127.0.0.1:${String(localPort)}`, `http://[::1]:${String(localPort)}`].map((origin) => new URL(origin).origin);
  // shortcut: 출처별 횟수는 재시작 때 초기화된다. 다중 서버 운영 시 DB 제한으로 옮긴다.
  const passwordAttempts = new Map<string, { count: number; resetAt: number }>();
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) {
      if (!OPERATIONS.some((op) => op.path === route.url && (op.method === method || method === 'HEAD' && op.method === 'GET'))) {
        throw new Error(`경로에 권한 선언이 없습니다: ${method} ${route.url}`);
      }
    }
  });

  app.addHook('preValidation', async (request) => {
    const operation = OPERATIONS.find((op) => op.path === request.routeOptions.url && (op.method === request.method || request.method === 'HEAD' && op.method === 'GET'));
    // 미등록 요청은 404 처리기로 간다. 등록 경로는 onRoute에서 권한 선언을 확인한다.
    const principal = operation?.principal ?? 'none';
    const context: Context = { operation, principal, currentEpoch: 0, epoch: 0 };
    request.platform = context;
    if (principal === 'none' && operation?.id !== 'login') return;
    if (principal === 'runner' || principal === 'lead' && request.headers.authorization !== undefined) {
      const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(request.headers.authorization ?? '')?.[1];
      const token = bearer ? (await pool.query<{ runner_id: string }>('select runner_id from runner_tokens where token_hash=$1 and revoked_at is null', [tokenHash(bearer)])).rows[0] : undefined;
      if (!token) throw new PlatformError(principal === 'runner' ? 'RUNNER_UNAUTHORIZED' : 'LEAD_UNAUTHORIZED');
      if (principal !== 'runner') throw new PlatformError('FORBIDDEN_PRINCIPAL');
      context.principal = `runner:${token.runner_id}`;
      const epoch = request.headers['x-project-epoch'];
      if (typeof epoch !== 'string' || !/^(0|[1-9]\d*)$/.test(epoch)) {
        throw new PlatformError('VALIDATION_FAILED', {}, [{ path: 'x-project-epoch', rule: 'pattern', message: '세대 번호 헤더는 0 이상의 정수 형식이어야 합니다.' }]);
      }
      if (Number(epoch) > 2_147_483_647) {
        throw new PlatformError('VALIDATION_FAILED', {}, [{ path: 'x-project-epoch', rule: 'maximum', message: '세대 번호는 2147483647 이하여야 합니다.' }]);
      }
      context.epoch = Number(epoch);
      const body = request.body as { runnerId?: unknown } | undefined;
      if (body?.runnerId !== undefined && body.runnerId !== token.runner_id) throw new PlatformError('FORBIDDEN_PRINCIPAL');
    } else if (principal === 'lead') {
      const token = cookieToken(request);
      const session = token ? (await pool.query<Session>('select token_hash,expires_at,csrf from lead_sessions where token_hash=$1 and expires_at>now()', [tokenHash(token)])).rows[0] : undefined;
      if (!session) throw new PlatformError('LEAD_UNAUTHORIZED');
      context.session = session;
    }
    if (write(request) && principal !== 'runner') {
      const csrf = request.headers['x-csrf-token'];
      const origin = request.headers.origin;
      const originAllowed = origin === options.origin || options.lan && loopback(request.raw.socket.remoteAddress) && typeof origin === 'string' && localOrigins.includes(origin);
      if (!originAllowed || principal === 'lead' && (typeof csrf !== 'string' || !equal(csrf, context.session?.csrf ?? ''))) throw new PlatformError('FORBIDDEN_PRINCIPAL');
    }
    const state = (await pool.query<{ epoch: number }>('select epoch from system_state where id=1')).rows[0];
    assert(state, '시스템 초기값이 필요합니다.');
    context.currentEpoch = state.epoch;
    if (principal !== 'runner') context.epoch = context.currentEpoch;
    if (principal === 'runner' && (context.epoch > context.currentEpoch || !operation?.staleEpoch && context.epoch !== context.currentEpoch)) throw new PlatformError('EPOCH_MISMATCH', { currentEpoch: context.currentEpoch });
  });

  app.addHook('preHandler', async (request, reply) => {
    const context = request.platform;
    assert(context);
    const operation = context.operation;
    if (operation?.principal === 'none' && operation.id !== 'login') return;
    if (!write(request) && operation?.principal !== 'runner') return;
    if (!operation) return;
    const key = request.headers['idempotency-key'];
    if (operation?.idempotency === 'required' && key === undefined) throw new PlatformError('IDEMPOTENCY_KEY_REQUIRED');
    if (key !== undefined && (typeof key !== 'string' || key.length === 0 || key.length > 255 || /[^\x21-\x7e]/.test(key))) throw new PlatformError('VALIDATION_FAILED');
    const client = await pool.connect();
    context.client = client;
    await client.query('begin');
    if (operation?.id === 'resetProject') {
      const state = (await client.query<{ epoch: number }>('select public.lock_epoch_exclusive() as epoch')).rows[0];
      assert(state);
      const current = state.epoch;
      const expected = (request.body as { epoch?: unknown } | undefined)?.epoch;
      if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0 || expected > 2_147_483_647) {
        const rule = typeof expected !== 'number' || !Number.isInteger(expected) ? 'type' : expected < 0 ? 'minimum' : 'maximum';
        throw new PlatformError('VALIDATION_FAILED', {}, [{ path: 'epoch', rule, message: '세대 번호는 0~2147483647의 정수여야 합니다.' }]);
      }
      context.currentEpoch = current;
      context.epoch = expected;
    } else if (operation?.staleEpoch) {
      const state = (await client.query<{ epoch: number }>('select public.lock_current_epoch() as epoch')).rows[0];
      assert(state);
      context.currentEpoch = state.epoch;
    } else await client.query('select public.lock_epoch($1)', [context.epoch]);
    if (operation?.id === 'reportCommandResult') {
      const command = (await client.query<{ epoch: number }>('select epoch from runner_commands where id=$1', [(request.params as { id: string }).id])).rows[0];
      if (!command) throw new PlatformError('NOT_FOUND', { resource: 'runner_command' });
      if (command.epoch !== context.epoch) throw new PlatformError('EPOCH_MISMATCH', { currentEpoch: context.currentEpoch });
    }
    const checkResetEpoch = () => {
      if (operation?.id === 'resetProject' && context.epoch !== context.currentEpoch) throw new PlatformError('EPOCH_MISMATCH', { currentEpoch: context.currentEpoch });
    };
    if (typeof key !== 'string' || !operation || operation.idempotency === 'none') { checkResetEpoch(); return; }
    // 초기화는 프로젝트 행을 지우고, 등록은 프로젝트 행을 만든다. 처리 전후로 프로젝트 범위가 바뀌므로
    // 두 요청의 재전송 응답은 바뀌지 않는 전역 범위(epoch·주체·키)에 저장한다.
    const project = operation.id === 'resetProject' || operation.id === 'createProject' ? null : (await client.query<{ id: string }>('select id from projects')).rows[0]?.id ?? null;
    const hash = tokenHash(`${request.method}\n${request.url}\n${canonical(request.body)}`);
    const scope = canonical([project, context.epoch, context.principal, key]);
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [scope]);
    const existing = (await client.query<{ request_hash: string; response: StoredResponse }>(
      'select request_hash,response from idempotency_keys where project_id is not distinct from $1::uuid and epoch=$2 and principal=$3 and key=$4', [project, context.epoch, context.principal, key],
    )).rows[0];
    if (existing) {
      if (existing.request_hash !== hash) throw new PlatformError('IDEMPOTENCY_CONFLICT');
      reply.code(existing.response.status).headers(existing.response.headers).header('Idempotency-Replayed', 'true');
      return reply.send(existing.response.payload);
    }
    checkResetEpoch();
    context.idempotency = { key, hash, project };
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const context = request.platform;
    if (context?.operation?.id === 'heartbeat') reply.header('X-Current-Epoch', context.currentEpoch);
    if (context?.client && reply.statusCode < 400 && context.idempotency) {
      if (payload != null && typeof payload !== 'string') throw new Error('멱등 응답은 JSON 문자열이어야 합니다.');
      const headers: Record<string, string> = {};
      for (const name of ['content-type', 'etag', 'location', 'content-disposition', 'x-current-epoch']) {
        const value = reply.getHeader(name);
        if (value !== undefined) headers[name] = String(value);
      }
      const saved: StoredResponse = { status: reply.statusCode, payload: payload ?? null, headers };
      const { project, key, hash } = context.idempotency;
      await context.client.query('insert into idempotency_keys(project_id,epoch,principal,key,request_hash,response) values($1,$2,$3,$4,$5,$6)', [project, context.epoch, context.principal, key, hash, saved]);
    }
    await finish(request, reply.statusCode < 400 || (context?.commitOnError === true && reply.statusCode < 500));
    return payload;
  });
  // onError는 onSend보다 먼저 실행된다. 보류 기록을 커밋하기로 한 요청은 onSend에서 커밋 여부를 정한다.
  app.addHook('onError', async (request) => { if (!request.platform?.commitOnError) await finish(request, false); });
  app.addHook('onRequestAbort', async (request) => { await finish(request, false); });
  app.addHook('onTimeout', async (request) => { await finish(request, false); });

  const cookie = (token: string, maxAge: number, origin: string | undefined) => `awbs_session=${token}; Path=/; Max-Age=${String(maxAge)}; HttpOnly; SameSite=Strict${origin?.startsWith('https:') ? '; Secure' : ''}`;
  const login = OPERATIONS.find((op) => op.id === 'login');
  assert(login?.body);
  app.post('/api/auth/session', { schema: { body: login.body } }, async (request, reply) => {
    const client = request.platform?.client;
    assert(client);
    const input = request.body as { method: 'link'; token: string } | { method: 'password'; password: string };
    if (input.method === 'link') {
      if (!loopback(request.raw.socket.remoteAddress)) throw new PlatformError('LOGIN_FAILED');
      const result = await client.query('update lead_login_tokens set used_at=now() where token_hash=$1 and used_at is null and expires_at>now() returning id', [tokenHash(input.token)]);
      if (!result.rowCount) throw new PlatformError('LOGIN_FAILED');
    } else {
      if (!options.lan) throw new PlatformError('LOGIN_FAILED');
      const now = Date.now();
      for (const [address, attempt] of passwordAttempts) if (attempt.resetAt <= now) passwordAttempts.delete(address);
      // 프록시 헤더는 위조할 수 있으므로 실제 소켓 주소로만 구분한다.
      const address = (request.raw.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
      const attempt = passwordAttempts.get(address) ?? { count: 0, resetAt: now + 60_000 };
      if (attempt.count >= 5) {
        reply.header('Retry-After', Math.max(1, Math.ceil((attempt.resetAt - now) / 1000)));
        throw new PlatformError('RATE_LIMITED');
      }
      attempt.count++;
      passwordAttempts.set(address, attempt);
      // 확인부터 세션 발급까지 재설정과 겹치지 않게 자격 증명 행을 잠근다.
      const stored = (await client.query<{ password_hash: string }>('select password_hash from lead_credentials where singleton=true for share')).rows[0];
      if (!stored || !await verifyPassword(input.password, stored.password_hash)) throw new PlatformError('LOGIN_FAILED');
    }
    const old = cookieToken(request);
    if (old) await client.query('delete from lead_sessions where token_hash=$1', [tokenHash(old)]);
    const token = randomToken();
    // 기존 csrf 열에 방식을 접두어로 보관한다. 난수 부분은 여전히 32바이트다.
    const csrf = `${input.method}.${randomToken()}`;
    await client.query("insert into lead_sessions(token_hash,expires_at,csrf) values($1,now()+interval '12 hours',$2)", [tokenHash(token), csrf]);
    return reply.header('Cache-Control', 'no-store').header('Set-Cookie', cookie(token, 43_200, request.headers.origin)).code(204).send();
  });
  app.get('/api/session', (request, reply) => {
    const session = request.platform?.session;
    assert(session);
    return reply.header('Cache-Control', 'no-store').send({ principal: 'lead', method: session.csrf.startsWith('password.') ? 'password' : 'link', expiresAt: session.expires_at.toISOString(), csrfToken: session.csrf });
  });
  app.delete('/api/auth/session', async (request, reply) => {
    const context = request.platform;
    assert(context?.client && context.session);
    await context.client.query('delete from lead_sessions where token_hash=$1', [context.session.token_hash]);
    return reply.header('Set-Cookie', cookie('', 0, request.headers.origin)).code(204).send();
  });
}
