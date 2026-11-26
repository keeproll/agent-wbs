import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite } from '../state/files.ts';

/*
 * Planning 작업의 로컬 진행 기록(checkpoint, 다시 이어 하기 위한 저장점).
 *
 * 왜 필요한가:
 * - 단계가 실패하면 서버는 같은 Planning 작업에 새 Runner job을 만들고 「실패한 단계부터」(resumeStep) 하라고 한다.
 *   그런데 Runner가 서버에서 이전 분석 결과를 읽는 API는 없다(contracts §3.2: Runner는 payload만으로 판단한다).
 *   그래서 끝난 단계의 결과(Codex·Claude 분석, 교차 검토, diff)를 이 PC에 저장해 두고 다음 job에서 다시 쓴다.
 * - 보낸 요청과 멱등 키도 저장한다. 응답을 잃거나 Runner가 재시작해 같은 job을 다시 실행하면,
 *   같은 키·같은 본문으로 다시 보내 서버가 한 번만 처리하게 한다(contracts §1.2 멱등).
 *
 * 저장 위치: `AWBS_HOME/state/planning/<작업 키의 SHA-256 앞 32자>.json`. 쓰기는 임시 파일·fsync·이름 교체(atomicWrite)다.
 * 결과(outputs)는 분석 회차(runNo)별로 둔다. 재분석은 회차가 바뀌므로 이전 회차 결과를 쓰지 않는다.
 */

export interface SentRequest { key: string; request: unknown }
interface Document {
  version: 1;
  /** 회차 → 단계 결과 이름 → 값 */
  outputs: Record<string, Record<string, unknown>>;
  /** `<Runner job ID>:<요청 이름>` → 보낸 요청 */
  sent: Record<string, SentRequest>;
}

const empty = (): Document => ({ version: 1, outputs: {}, sent: {} });

function valid(value: unknown): value is Document {
  if (typeof value !== 'object' || value === null) return false;
  const doc = value as Partial<Document>;
  return doc.version === 1 && typeof doc.outputs === 'object' && doc.outputs !== null && typeof doc.sent === 'object' && doc.sent !== null;
}

export class PlanningCheckpointError extends Error { override name = 'PlanningCheckpointError'; }

export class PlanningCheckpoint {
  private readonly directory: string;
  private readonly file: string;
  private doc: Document;
  private readonly runNo: number;
  private constructor(directory: string, file: string, doc: Document, runNo: number) {
    this.directory = directory;
    this.file = file;
    this.doc = doc;
    this.runNo = runNo;
  }

  static async load(directory: string, workKey: string, runNo: number): Promise<PlanningCheckpoint> {
    const file = `${createHash('sha256').update(workKey).digest('hex').slice(0, 32)}.json`;
    let doc = empty();
    try {
      const parsed: unknown = JSON.parse(await readFile(join(directory, file), 'utf8'));
      // 깨진 기록을 고쳐 쓰지 않는다. 지우면 이미 보낸 요청의 멱등 키를 잃어 중복 처리될 수 있다.
      if (!valid(parsed)) throw new PlanningCheckpointError(`Planning 진행 기록 ${file}의 형식이 올바르지 않습니다.`);
      doc = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        if (error instanceof PlanningCheckpointError) throw error;
        throw new PlanningCheckpointError(`Planning 진행 기록 ${file}을 읽지 못했습니다.`);
      }
    }
    return new PlanningCheckpoint(directory, file, doc, runNo);
  }

  output<T>(name: string): T | undefined {
    return this.doc.outputs[String(this.runNo)]?.[name] as T | undefined;
  }

  async saveOutput(name: string, value: unknown): Promise<void> {
    const run = String(this.runNo);
    await this.write({ ...this.doc, outputs: { ...this.doc.outputs, [run]: { ...this.doc.outputs[run], [name]: structuredClone(value) } } });
  }

  sent(jobId: string, name: string): SentRequest | undefined {
    return this.doc.sent[`${jobId}:${name}`];
  }

  async recordSent(jobId: string, name: string, entry: SentRequest): Promise<void> {
    await this.write({ ...this.doc, sent: { ...this.doc.sent, [`${jobId}:${name}`]: structuredClone(entry) } });
  }

  private async write(next: Document): Promise<void> {
    // 디스크에 먼저 쓰고 메모리를 바꾼다. 쓰다 실패하면 메모리도 그대로다.
    await atomicWrite(this.directory, this.file, JSON.stringify(next));
    this.doc = next;
  }
}

export class PlanningCheckpoints {
  private readonly directory: string;
  private constructor(directory: string) { this.directory = directory; }

  /** `home`은 AWBS_HOME이다. 폴더는 Runner 사용자만 읽고 쓴다(0700). */
  static async open(home: string): Promise<PlanningCheckpoints> {
    const directory = join(home, 'state', 'planning');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return new PlanningCheckpoints(directory);
  }

  load(workKey: string, runNo: number): Promise<PlanningCheckpoint> {
    return PlanningCheckpoint.load(this.directory, workKey, runNo);
  }
}
