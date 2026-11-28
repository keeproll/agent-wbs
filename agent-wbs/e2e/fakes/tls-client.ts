/** TLS 검증 시험의 별도 Node 프로세스. CA는 시작할 때만 주고, 인증서 검증은 끄지 않는다. */
import { checkSmtp, sendSmtp, type SmtpTarget } from '../../apps/api/src/mail/smtp.ts';
import { callBot } from '../../apps/api/src/notify/bot.ts';

const [kind, input] = process.argv.slice(2);
if (!input) throw new Error('시험 입력이 필요합니다.');
if (kind === 'telegram') {
  process.env.AWBS_TELEGRAM_BOT_API_URL = input;
  const results = [];
  for (const method of ['getMe', 'getUpdates', 'sendMessage'] as const) results.push(await callBot('awbs-W5-fake-token', method, { text: 'TLS 시험' }));
  process.stdout.write(JSON.stringify(results));
} else if (kind === 'smtp') {
  const target = JSON.parse(input) as SmtpTarget;
  process.stdout.write(JSON.stringify({
    check: await checkSmtp(target, 5_000),
    send: await sendSmtp(target, { from: 'w5@example.com', to: 'qa@example.com', subject: 'W5', text: 'TLS 시험', html: '<p>TLS 시험</p>' }, 5_000),
  }));
} else throw new Error('알 수 없는 시험입니다.');
