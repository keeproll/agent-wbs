import { createPublicKey, diffieHellman, generateKeyPairSync } from 'node:crypto';
import { PlatformError } from './errors.ts';

/** PEM 공개키만 받는다. 작은 차수의 키도 실제 키 교환으로 거부한다. 입력은 오류에 싣지 않는다. */
export function runnerPublicKey(pem: string) {
  try {
    if (!pem.trim().startsWith('-----BEGIN PUBLIC KEY-----')) throw new Error();
    const key = createPublicKey(pem);
    if (key.asymmetricKeyType !== 'x25519') throw new Error();
    diffieHellman({ privateKey: generateKeyPairSync('x25519').privateKey, publicKey: key });
    return key;
  } catch {
    throw new PlatformError('VALIDATION_FAILED', {}, [{ path: 'publicKeyPem', rule: 'x25519', message: 'X25519 SubjectPublicKeyInfo PEM 공개키가 필요합니다.' }]);
  }
}
