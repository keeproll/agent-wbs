import { pino, type DestinationStream, type Logger } from 'pino';
import type { Redact } from './security/redact.ts';

/**
 * 직렬화가 끝난 한 줄을 마지막에 가린다. 메시지·오류·child 필드·깊은 객체가 모두 같은 경로를 지난다.
 */
export function createLogger(
  level: string,
  redact: Redact,
  destination: DestinationStream = process.stdout,
): Logger {
  return pino(
    { name: 'agent-runner', level },
    {
      write(line: string) {
        destination.write(`${JSON.stringify(redact(JSON.parse(line) as unknown))}\n`);
      },
    },
  );
}
