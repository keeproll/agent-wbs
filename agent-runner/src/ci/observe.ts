import type { InputChangeReporter } from '../git/inputs.ts';
import type { GitRepository } from '../git/repository.ts';
import type { MainBasis } from './integration/check.ts';
import { parsePipeline } from './pipeline.ts';

/**
 * 고정한 main의 파이프라인 정의를 입력 관측 API(reportInputChanges)로 보고한다. ①·②가 같은 함수를 쓴다.
 * 왜: 서버는 보고받은 main 정의(pipelineSha)로만 ①·② 결과를 받는다. 관측하지 않은 정의의 결과는 근거가 아니다.
 * 서버가 이 head를 받아들이지 않았으면(이력 재작성 등) 예외다. 받아들였다고 추측하지 않는다.
 */
export async function observeMainPipeline(inputs: InputChangeReporter, repo: Pick<GitRepository, 'inputObservation'>, basis: MainBasis): Promise<void> {
  const pipeline = parsePipeline(basis.source);
  const result = await inputs.report({ fetch: async () => basis.baseSha, inputObservation: async (base, head) => ({
    ...await repo.inputObservation(base, head), pipelineObservation: { baseSha: basis.baseSha, pipelineSha: basis.pipelineSha,
      definition: { path: '.agentwbs/pipeline.yaml', commit: basis.baseSha, status: 'ok', error: null, raw: basis.source,
        stages: Object.entries(pipeline.stages).map(([stage, steps]) => ({ stage: stage as 'task' | 'int' | 'night' | 'deploy', when: stage, gate: '검사 통과', steps: steps.map(s => s.name) })) } },
  }) });
  if (!('head' in result) || result.head !== basis.baseSha || result.historyRewritten) throw new Error('main 파이프라인 관측을 서버가 수용하지 않았습니다.');
}
