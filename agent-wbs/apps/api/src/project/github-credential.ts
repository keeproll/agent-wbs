import { createCipheriv, createHash, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, type KeyObject } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { clientOf, routes } from '../changes/http.ts';
import { readToken } from '../notify/secrets.ts';
import { PlatformError } from '../platform/errors.ts';
import { runnerPublicKey } from '../platform/runner-key.ts';
import { RunnerRepository } from '../runner/repository.ts';

/** contracts §6.1. 이 바이트 배치는 Runner의 openSealedCredential과 독립적으로 맞춘다. */
export function sealGithubCredential(recipient: KeyObject, token: string): string {
  if (!token) throw new PlatformError('UNAVAILABLE');
  const ephemeral = generateKeyPairSync('x25519');
  const raw = (key: KeyObject) => key.export({ type: 'spki', format: 'der' }).subarray(-32);
  const publicKey = raw(ephemeral.publicKey);
  const key = Buffer.from(hkdfSync('sha256', diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient }),
    Buffer.concat([publicKey, raw(recipient)]), Buffer.from('agentwbs/github-credential/v1'), 32));
  const header = Buffer.concat([Buffer.from([1]), publicKey]);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([header, nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
}

export function installGithubCredentials(app: FastifyInstance): void {
  // 프로세스별 한 키만 보관한다. 서버 재시작 때 비우며 같은 Runner의 새 등록은 옛 키를 대체한다.
  const keys = new Map<string, { keyId: string; key: KeyObject; epoch: number; hostId: string; bootId: string }>();
  app.addHook('onClose', async () => { keys.clear(); });
  routes(app, 'Runner GitHub 자격 증명', route => {
    route('registerGithubKey', async r => {
      const b = r.body as { runnerId: string; hostId: string; bootId: string; publicKeyPem: string };
      const repo = new RunnerRepository(clientOf(r));
      await repo.lock();
      const host = await repo.host();
      if (r.platform?.principal !== `runner:${b.runnerId}` || host?.host_id !== b.hostId || host.boot_id !== b.bootId) throw new PlatformError('FORBIDDEN_PRINCIPAL');
      const key = runnerPublicKey(b.publicKeyPem);
      const keyId = createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex');
      keys.set(r.platform.principal, { keyId, key, epoch: r.platform.epoch, hostId: b.hostId, bootId: b.bootId });
      return { keyId };
    });
    route('getGithubCredential', async (r, reply) => {
      reply.header('Cache-Control', 'no-store');
      const repo = new RunnerRepository(clientOf(r));
      await repo.lock();
      const key = keys.get(r.platform?.principal ?? '');
      const host = await repo.host();
      if (!key || key.keyId !== (r.query as { keyId: string }).keyId || key.epoch !== r.platform?.epoch || key.hostId !== host?.host_id || key.bootId !== host.boot_id) throw new PlatformError('NOT_FOUND');
      const settings = await repo.githubSettings();
      if (settings?.mode !== 'token' || !settings.secret_key) throw new PlatformError('NOT_FOUND');
      try {
        // 기존 GitHub 설정이 저장한 AES-256-GCM 비밀 열을 읽는 같은 도우미를 쓴다.
        return { sealed: sealGithubCredential(key.key, await readToken(repo.client, settings.secret_key)) };
      } catch {
        throw new PlatformError('UNAVAILABLE');
      }
    });
  });
}
