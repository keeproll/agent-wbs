import { timingSafeEqual } from 'node:crypto';
import assert from 'node:assert/strict';
import type { Pool, PoolClient } from '@awbs/db';
import { OPERATIONS, type Operation } from '@awbs/shared/api';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomToken, tokenHash, verifyPassword } from './credentials.ts';
import { installErrors, PlatformError } from './errors.ts';

export interface SecurityOptions { origin: string; lan: boolean }
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
  try { await client.query(commit ? 'commit' : 'rollback'); }
  catch (error) { client.release(true); throw error; }
  client.release();
}

export function installSecurity(app: FastifyInstance, pool: Pool, options: SecurityOptions): void {
  installErrors(app, pool);
  app.decorateRequest('platform', null);
  // shortcut: 로그인 횟수는 재시작 때 초기화된다. 다중 서버 운영 시 DB 제한으로 옮긴다.
  let passwordAttempts = 0;
  let passwordWindow = 0;

  app.addHook('preValidation', async (request) => {
    const operation = OPERATIONS.find((op) => op.path === request.routeOptions.url && (op.method === request.method || request.method === 'HEAD' && op.method === 'GET'));
    // 아직 계약에 없는 /api 경로도 실수로 공개되지 않게 팀장 인증을 요구한다.
    const principal = operation?.principal ?? (request.routeOptions.url?.startsWith('/api/') ? 'lead' : 'none');
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
      if (typeof epoch !== 'string' || !/^(0|[1-9]\d*)$/.test(epoch) || Number(epoch) > 2_147_483_647) throw new PlatformError('VALIDATION_FAILED');
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
      if (request.headers.origin !== options.origin || principal === 'lead' && (typeof csrf !== 'string' || !equal(csrf, context.session?.csrf ?? ''))) throw new PlatformError('FORBIDDEN_PRINCIPAL');
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
    if (!operation && !request.routeOptions.url?.startsWith('/api/')) return;
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
      if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0 || expected > 2_147_483_647) throw new PlatformError('VALIDATION_FAILED');
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
    // 초기화는 프로젝트 행을 지운다. 재전송 응답은 삭제되지 않는 전역 범위에 저장한다.
    const project = operation.id === 'resetProject' ? null : (await client.query<{ id: string }>('select id from projects')).rows[0]?.id ?? null;
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
    await finish(request, reply.statusCode < 400);
    return payload;
  });
  app.addHook('onError', async (request) => { await finish(request, false); });
  app.addHook('onRequestAbort', async (request) => { await finish(request, false); });
  app.addHook('onTimeout', async (request) => { await finish(request, false); });

  const cookie = (token: string, maxAge: number) => `awbs_session=${token}; Path=/; Max-Age=${String(maxAge)}; HttpOnly; SameSite=Strict${options.origin.startsWith('https:') ? '; Secure' : ''}`;
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
      if (Date.now() - passwordWindow >= 60_000) { passwordAttempts = 0; passwordWindow = Date.now(); }
      // 단일 팀장 서비스이므로 주소를 바꿔도 우회할 수 없는 서버 전체 제한을 쓴다.
      if (passwordAttempts >= 5) {
        reply.header('Retry-After', Math.max(1, Math.ceil((passwordWindow + 60_000 - Date.now()) / 1000)));
        throw new PlatformError('RATE_LIMITED');
      }
      passwordAttempts++;
      const stored = (await client.query<{ password_hash: string }>('select password_hash from lead_credentials where singleton=true')).rows[0];
      if (!stored || !await verifyPassword(input.password, stored.password_hash)) throw new PlatformError('LOGIN_FAILED');
    }
    const old = cookieToken(request);
    if (old) await client.query('delete from lead_sessions where token_hash=$1', [tokenHash(old)]);
    const token = randomToken();
    // 기존 csrf 열에 방식을 접두어로 보관한다. 난수 부분은 여전히 32바이트다.
    const csrf = `${input.method}.${randomToken()}`;
    await client.query("insert into lead_sessions(token_hash,expires_at,csrf) values($1,now()+interval '12 hours',$2)", [tokenHash(token), csrf]);
    return reply.header('Cache-Control', 'no-store').header('Set-Cookie', cookie(token, 43_200)).code(204).send();
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
    return reply.header('Set-Cookie', cookie('', 0)).code(204).send();
  });
}
