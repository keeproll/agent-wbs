import Type, { type Static } from 'typebox';
import { Value } from 'typebox/value';
import * as c from './common.ts';
import { DataContent, designOverview, IfaceContent } from './models.ts';
import { DESIGN_REF_PATTERN } from '../domain/numbering.ts';

const text = (maxLength: number) => Type.String({ minLength: 1, pattern: '\\S', maxLength });
const key = text(512);
const path = Type.Intersect([c.RepoPath, Type.String({ pattern: '^contracts/', maxLength: 1024 })]);
/** REST의 /parameters·/requestBody는 요청, /responses는 응답이다. 메시지는 모두 응답 규칙이다. type에는 enum·const·format 지문도 포함한다. */
export const DesignShape = c.Body({ fields: c.List(c.Body({ path: Type.String({ pattern: '^/', maxLength: 4096 }), type: text(4096), required: Type.Boolean() }), { maxItems: 5000 }) });
const empty = c.Body({});
const iface = IfaceContent.anyOf[0].anyOf;
const data = DataContent.anyOf[0].anyOf;
const contents = {
  REST: Type.Union([empty, iface[0]]),
  WebSocket: Type.Union([empty, iface[1]]), SSE: Type.Union([empty, iface[1]]), Kafka: Type.Union([empty, iface[1]]),
  postgres: Type.Union([empty, data[0]]), neo4j: Type.Union([empty, data[1], data[2]]),
  questdb: Type.Union([empty, data[3]]), redis: Type.Union([empty, data[4]]),
};
const item = <const K extends keyof typeof contents>(kind: K, pattern = '\\S') => c.Body({
  itemKey: Type.String({ minLength: 1, maxLength: 512, pattern }), kind: c.AnyOf(kind), path, name: c.Opt(key), taskKey: c.Opt(c.TaskKey),
  description: c.Opt(c.Nullable(Type.String({ maxLength: 8192 }))),
  content: contents[kind], contract: c.Opt(DesignShape), extracted: c.Opt(c.Nullable(DesignShape)),
});
const file = { path, kind: text(128), format: text(128), raw: c.Opt(Type.String({ maxLength: 262144 })) };
export const DesignSnapshot = Type.Object({
  ...c.JobContext,
  commit: c.Sha,
  // main은 design_apply·merge_followup, Task 브랜치는 자기 attempt job만 보고한다.
  ref: Type.String({ pattern: DESIGN_REF_PATTERN, maxLength: 1024 }),
  // 미지원 형식도 원문으로 표시하므로 파일 kind·format은 열린 문자열이다. 항목 kind는 아래 enum만 받는다.
  files: c.List(Type.Union([
    c.Body({ ...file, status: c.AnyOf('ok', 'draft'), error: c.Opt(text(4096)) }),
    c.Body({ ...file, status: c.AnyOf('error'), error: text(4096) }),
  ]), { maxItems: 256 }),
  items: c.List(Type.Union([
    item('REST', '^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) /\\S*$'),
    item('WebSocket'), item('SSE'), item('Kafka'),
    item('postgres', '^postgres:\\S.*$'), item('neo4j', '^neo4j:\\S.*$'),
    item('questdb', '^questdb:\\S.*$'), item('redis', '^redis:\\S.*$'),
  ]), { maxItems: 1000 }),
  // compat는 Runner의 참고값이다. 서버는 contract·extracted를 비교해 저장한다. 추출이 없으면 unchecked다.
  drifts: c.List(c.Body({ itemKey: key, kind: text(128), where: text(4096), text: text(4096), taskKey: c.Opt(c.TaskKey), compat: c.AnyOf('compatible', 'breaking', 'unchecked') }), { maxItems: 1000 }),
  edges: c.Opt(c.List(c.Body({ from: key, to: key, kind: text(128) }), { maxItems: 5000 })),
  ownership: c.Opt(c.List(c.Body({ data: key, source: key, copy: Type.String({ maxLength: 4096 }), sync: Type.String({ maxLength: 4096 }), lag: Type.String({ maxLength: 4096 }) }), { maxItems: 1000 })),
  components: c.Opt(c.List(designOverview.components.items, { maxItems: 256 })),
  links: c.Opt(c.List(designOverview.links.items, { maxItems: 5000 })),
}, {
  additionalProperties: false,
  description: '전체 본문은 UTF-8 JSON 1048576바이트 이하이다. ref는 필수다. main은 design_apply·merge_followup만 보고한다. attempt는 payload.branch와 같은 ref만 보고한다. 같은 commit은 unchecked→checked만 허용한다. VERSION_CONFLICT의 details.conflicts는 충돌 항목만 [{itemKey,serverState:"checked"|"unchecked",serverContentHash,commit,ref}]로 보낸다. serverContentHash는 {itemKey,kind,path,name,description,taskKey,content,contract,extracted}를 RFC 8785 JCS로 직렬화한 UTF-8의 SHA-256, 소문자 64자리다. 없는 name·description·taskKey·contract·extracted는 null이다. DB sourceCommit은 제외한다. 정규화는 충돌 비교와 해시에 공통 적용한다. 의미 없는 배열은 키로 먼저 정렬한다: fields(path), files(path), items(itemKey), edges(from,to,kind), ownership(data,source,copy,sync,lag), components(id), links(from,to,via,contractPath). 키 튜플은 UTF-16 순서로 비교하고 동률이면 원소의 JCS 문자열로 비교한다. content.decisionKeys·content.tables·content.usedBy는 문자열을 UTF-16 순서로 정렬한다. 나머지 배열의 순서는 보존한다. 보고의 drifts 참고값은 충돌 비교에서 제외한다. 서버에 항목이 없으면 null의 JCS를 해시하고 unchecked로 표시한다. 고정 벡터는 contracts/fixtures/design-snapshot.json에 있다.',
});

export type DesignShapeInput = Static<typeof DesignShape>;
export type DesignSnapshotInput = Static<typeof DesignSnapshot>;
export type DesignItemInput = DesignSnapshotInput['items'][number];

/** 원문만 있는 항목은 빈 객체다. 해석한 내용은 화면이 쓰는 계약과 일치해야 한다. */
export function designContentValid(item: DesignItemInput): boolean {
  return Value.Check(contents[item.kind], item.content);
}
