import Type, { type Static } from 'typebox';
import * as c from './common.ts';
import { designOverview } from './models.ts';

/** 해석기가 만든 필드 목록. path는 JSON Pointer(중첩 필드의 고정 주소)다. 삭제·타입 변경·필수화를 서버가 비교한다. */
export const DesignShape = c.Body({ fields: c.List(c.Body({ path: c.Text, type: c.Text, required: Type.Boolean() })) });
export const DesignSnapshot = c.Body({
  ...c.JobContext,
  commit: c.Sha,
  // 생략은 main이다. 브랜치 보고는 확정 설계와 섞이지 않게 ref를 보낸다.
  ref: c.Opt(c.Text),
  files: c.List(c.Body({ path: c.RepoPath, kind: c.Text, format: c.Text, status: c.AnyOf('ok', 'draft', 'error'), error: c.Opt(c.Text), raw: c.Opt(Type.String()) })),
  items: c.List(c.Body({
    itemKey: c.Text, kind: c.Text, path: c.RepoPath, name: c.Opt(c.Text), taskKey: c.Opt(c.TaskKey), content: c.Json,
    contract: c.Opt(DesignShape), extracted: c.Opt(c.Nullable(DesignShape)),
  })),
  // compat는 Runner의 참고값이다. 서버는 contract·extracted를 비교해 저장한다. 추출이 없으면 unchecked다.
  drifts: c.List(c.Body({ itemKey: c.Text, kind: c.Text, where: c.Text, text: c.Text, taskKey: c.Opt(c.TaskKey), compat: c.AnyOf('compatible', 'breaking', 'unchecked') })),
  edges: c.Opt(c.List(c.Body({ from: c.Text, to: c.Text, kind: c.Text }))),
  ownership: c.Opt(c.List(c.Body({ data: c.Text, source: c.Text, copy: Type.String(), sync: Type.String(), lag: Type.String() }))),
  components: c.Opt(designOverview.components),
  links: c.Opt(designOverview.links),
});

export type DesignShapeInput = Static<typeof DesignShape>;
export type DesignSnapshotInput = Static<typeof DesignSnapshot>;
export type DesignItemInput = DesignSnapshotInput['items'][number];
