import { createApiClient } from '../../src/api/client.ts';
import { Outbox } from '../../src/api/outbox.ts';
import { State } from '../../src/state/state.ts';
import { Secret } from '../../src/security/secret.ts';

const [home, baseUrl, mode] = process.argv.slice(2);
if (!home || !baseUrl) throw new Error('시험 경로와 주소가 필요합니다.');
const state = await State.open(home);
const outbox = new Outbox(state, createApiClient({ baseUrl, token: new Secret('fake-runner-token-0123456789abcdef') }));
if (mode === 'enqueue') await outbox.enqueue('reportUsage', { epoch: 0, body: { agent: 'Codex', remainPct: 60 } });
await outbox.flush();
