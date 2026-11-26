import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { Secret } from '../security/secret.ts';

/**
 * GitHub 토큰 봉인(architecture §보안 「GitHub 토큰 전달」).
 *
 * 서버는 Runner 공개키로 토큰을 봉인해 `GET /runner/github/credential`의 `sealed`로만 보낸다.
 * Runner는 메모리에 둔 개인키로 열어 `Secret`으로만 다룬다.
 *
 * 형식(base64url): version(1) | 임시 X25519 공개키(32) | nonce(12) | GCM tag(16) | 암호문
 * - 키 = HKDF-SHA256(공유 비밀, salt = 임시 공개키 ‖ Runner 공개키, info = INFO)
 * - AAD(함께 인증하는 머리말) = version ‖ 임시 공개키 → 머리말을 바꿔도 열리지 않는다.
 */
const VERSION = 1;
const INFO = Buffer.from('agentwbs/github-credential/v1');
const KEY_LEN = 32;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = 1 + KEY_LEN;
const MIN_LEN = HEADER_LEN + NONCE_LEN + TAG_LEN + 1;

/** 봉인·열기 실패. 메시지에 입력값(봉인 값·토큰)을 넣지 않는다. */
export class CredentialError extends Error {
  override name = 'CredentialError';
}

export interface RunnerKeyPair {
  /** 서버에 등록할 공개키(SPKI PEM). */
  publicKey: string;
  /** Runner 메모리에만 둔다. */
  privateKey: KeyObject;
}

export function generateRunnerKeyPair(): RunnerKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519');
  return { publicKey: publicKey.export({ type: 'spki', format: 'pem' }), privateKey };
}

function rawPublic(key: KeyObject): Buffer {
  // SPKI DER의 마지막 32바이트가 X25519 공개키다.
  return key.export({ type: 'spki', format: 'der' }).subarray(-KEY_LEN);
}

function deriveKey(shared: Buffer, ephemeral: Buffer, recipient: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephemeral, recipient]), INFO, KEY_LEN));
}

/** 서버 쪽 봉인과 같은 형식. Runner에서는 시험·형식 기준으로 쓴다. */
export function sealCredential(runnerPublicKey: string, token: string): string {
  if (token === '') throw new CredentialError('빈 토큰은 봉인하지 않습니다.');
  let recipient: KeyObject;
  try {
    recipient = createPublicKey(runnerPublicKey);
  } catch {
    throw new CredentialError('Runner 공개키 형식이 올바르지 않습니다.');
  }
  if (recipient.asymmetricKeyType !== 'x25519') throw new CredentialError('Runner 공개키는 X25519여야 합니다.');
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralRaw = rawPublic(ephemeral.publicKey);
  const key = deriveKey(
    diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient }),
    ephemeralRaw,
    rawPublic(recipient),
  );
  const header = Buffer.concat([Buffer.from([VERSION]), ephemeralRaw]);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return Buffer.concat([header, nonce, cipher.getAuthTag(), body]).toString('base64url');
}

/** 봉인 값을 열어 `Secret`으로 돌려준다. 평문 문자열을 반환하지 않는다. */
export function openSealedCredential(runnerPrivateKey: KeyObject, sealed: string): Secret {
  const raw = /^[A-Za-z0-9_-]+$/.test(sealed) ? Buffer.from(sealed, 'base64url') : Buffer.alloc(0);
  if (raw.length < MIN_LEN) throw new CredentialError('봉인 값 형식이 올바르지 않습니다.');
  if (raw[0] !== VERSION) throw new CredentialError('지원하지 않는 봉인 형식입니다.');
  const header = raw.subarray(0, HEADER_LEN);
  const ephemeralRaw = raw.subarray(1, HEADER_LEN);
  const nonce = raw.subarray(HEADER_LEN, HEADER_LEN + NONCE_LEN);
  const tag = raw.subarray(HEADER_LEN + NONCE_LEN, HEADER_LEN + NONCE_LEN + TAG_LEN);
  const body = raw.subarray(HEADER_LEN + NONCE_LEN + TAG_LEN);
  try {
    const ephemeral = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), ephemeralRaw]),
      format: 'der',
      type: 'spki',
    });
    const recipientRaw = rawPublic(createPublicKey(runnerPrivateKey));
    const key = deriveKey(diffieHellman({ privateKey: runnerPrivateKey, publicKey: ephemeral }), ephemeralRaw, recipientRaw);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    const token = Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    return new Secret(token);
  } catch {
    // 키가 다르거나 값이 변조되었다. 원인 메시지에도 입력이 섞일 수 있어 버린다.
    throw new CredentialError('봉인 값을 열 수 없습니다(다른 Runner 키이거나 변조됨).');
  }
}
