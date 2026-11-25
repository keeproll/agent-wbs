import { readFile } from 'node:fs/promises';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import type { Pool } from './pool.ts';
import { assertConnectedToTestDatabase, assertTestDatabaseUrl } from './test-database.ts';
import * as s from './schema.ts';

// owner Q-03, P STAGE_PCT; remaining defaults: G §5.2-1, §7.3, §8.2, §10.
export const stagePercent = {
  planning: 0,
  approval: 0,
  ready: 0,
  failed: 20,
  running: 35,
  paused: 40,
  rework: 50,
  qa: 65,
  verifying: 80,
  gate: 90,
  done: 100,
  cancelled: 0,
};
export const splitDefaults = {
  maxH: 4,
  minH: 0.5,
  maxFiles: 8,
  testIn: true,
  dir: 'layer',
  on: {
    one: true,
    domain: true,
    size: true,
    verify: true,
    revert: true,
    cg: true,
    contract: true,
    irrev: true,
    refactor: true,
    unknown: true,
  },
};
// G §4.14 fixes these defaults; P TG_RULES0 supplies their keys.
export const notifyDefaults = {
  done: false,
  fail: true,
  admin: true,
  approve: true,
  buildOk: false,
  buildFail: true,
};

// Mapping approval is distinct from model availability or permission to run it.
export const effortModels = {
  Codex: [
    'gpt-6.2-sol',
    'gpt-6.2-astra',
    'gpt-6.1-sol',
    'gpt-6.1-terra',
    'gpt-6-sol',
    'gpt-6-astra',
    'gpt-5.6-sol',
    'gpt-5.6-terra',
    'gpt-6-luna',
    'gpt-5.6-luna',
    'gpt-5.5',
  ],
  Claude: ['claude-fable-5-2', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
};

export async function seedSystem(pool: Pool): Promise<void> {
  await drizzle(pool).transaction(async (tx) => {
    await tx.insert(s.systemState).values({ id: 1 }).onConflictDoNothing();
    await tx.execute('select epoch from system_state where id=1 for share');
    await tx
      .insert(s.appSettings)
      .values({
        singleton: true,
        heartbeat_seconds: 60,
        heartbeat_misses: 3,
        split: splitDefaults,
        stage_pct: stagePercent,
        timezone: 'Asia/Seoul',
      })
      .onConflictDoNothing();
    await tx
      .insert(s.execPolicy)
      .values({
        singleton: true,
        on_usage: 'wait',
        on_rework: 'up1',
        esc_notify: 2,
        floors: { verifyGeDev: true, dbHigh: true },
        live_inject: false,
        auto_retry_limit: 2,
        auto_rework_limit: 3,
      })
      .onConflictDoNothing();
    await tx
      .insert(s.schedulePolicy)
      .values({ singleton: true, window_days: 7, min_hours: 72 })
      .onConflictDoNothing();
    await tx
      .insert(s.ciSettings)
      .values({ singleton: true, night_at: '02:00', retry: 1 })
      .onConflictDoNothing();
    await tx
      .insert(s.notifySettings)
      .values({ singleton: true, enabled: false })
      .onConflictDoNothing();
    for (const [key, enabled] of Object.entries(notifyDefaults)) {
      await tx.insert(s.notifyRules).values({ key, enabled }).onConflictDoNothing();
    }
    for (const cli of ['Codex', 'Claude'] as const) {
      for (const model of effortModels[cli]) {
        for (const [i, value] of ['low', 'medium', 'high', 'xhigh', 'max'].entries()) {
          if (model === 'gpt-5.5' && value === 'max') continue;
          await tx
            .insert(s.agentEfforts)
            .values({
              agent: cli,
              model_id: model,
              value,
              common_level: i + 1,
              supported: cli === 'Claude' || model === 'gpt-5.5' ? null : true,
              confirmation:
                cli === 'Claude'
                  ? 'bundled-api-docs; cli-per-model-unconfirmed'
                  : model === 'gpt-5.5'
                    ? 'bundled-only; availability-unconfirmed'
                    : 'bundled-and-local-cache',
            })
            .onConflictDoNothing();
        }
      }
    }
  });
}

interface DemoTask {
  id: string;
  title: string;
  type: (typeof s.workType.enumValues)[number];
  domain: (typeof s.domain.enumValues)[number];
  rel: (typeof s.domain.enumValues)[number][];
  priority: number;
  assignee: 'Claude' | 'Codex';
  verifier: 'Claude' | 'Codex';
  status: (typeof s.taskStatus.enumValues)[number];
  verif: string;
  purpose: string;
  background: string;
  scope: string[];
  out: string[];
  precond: string;
  doneCond: string;
  spec?: { ac?: string[] };
  checklist: {
    id: string;
    text: string;
    required: boolean;
    done: boolean;
    method: string;
    evidence: string;
    note: string;
  }[];
}
interface Demo {
  mock: {
    project: { name: string; target: string };
    phases: { id: string; title: string; wps: { id: string; title: string; tasks: string[] }[] }[];
    tasks: Record<string, DemoTask>;
    deps: { pred: string; succ: string; type: 'FS' | 'SS' }[];
  };
  sub: {
    defs: {
      id: string;
      v: number;
      agent: 'Claude' | 'Codex';
      role: string;
      tools: string;
      sandbox: string;
      text: string;
      hash: string;
      allowed: boolean;
      ref: string;
    }[];
  };
  sched: Record<
    string,
    { est: number; lo: number; hi: number; tok: number; conf: string; basis: string }
  >;
}

/** Demo is restricted to the same disposable local DB boundary as destructive tests. */
export async function seedDemo(pool: Pool, testDatabaseUrl: string): Promise<void> {
  assertTestDatabaseUrl(testDatabaseUrl);
  await assertConnectedToTestDatabase(pool);
  const demo = JSON.parse(
    await readFile(new URL('../seed/demo.json', import.meta.url), 'utf8'),
  ) as Demo;
  await seedSystem(pool);
  await drizzle(pool).transaction(async (tx) => {
    await tx.execute('select epoch from system_state where id=1 for share');
    if ((await tx.select().from(s.projects)).length)
      throw new Error('demo seed requires an empty project');
    // P does not supply a real repository: keep it empty rather than inventing a URL.
    const [p] = await tx
      .insert(s.projects)
      .values({
        name: demo.mock.project.name,
        repo_url: '',
        repo_owner: '',
        repo_name: '',
        target_date: demo.mock.project.target,
        lead_instruction: '',
        phase: 'active',
      })
      .returning();
    if (!p) throw new Error('demo project insert failed');
    const ids = new Map<string, string>();
    for (const [phaseIndex, phase] of demo.mock.phases.entries()) {
      const [ph] = await tx
        .insert(s.wbsNodes)
        .values({
          project_id: p.id,
          node_key: phase.id,
          kind: 'phase',
          title: phase.title,
          sort_order: phaseIndex,
        })
        .returning();
      if (!ph) throw new Error('demo phase insert failed');
      for (const [wpIndex, wp] of phase.wps.entries()) {
        const [node] = await tx
          .insert(s.wbsNodes)
          .values({
            project_id: p.id,
            node_key: wp.id,
            kind: 'work_package',
            parent_id: ph.id,
            title: wp.title,
            sort_order: wpIndex,
          })
          .returning();
        if (!node) throw new Error('demo work package insert failed');
        for (const [taskIndex, key] of wp.tasks.entries()) {
          const t = demo.mock.tasks[key];
          if (!t) throw new Error(`missing demo task ${key}`);
          const [task] = await tx
            .insert(s.tasks)
            .values({
              project_id: p.id,
              wbs_node_id: node.id,
              task_key: key,
              sort_order: taskIndex,
              title: t.title,
              work_type: t.type,
              primary_domain: t.domain,
              related_domains: t.rel,
              priority: t.priority,
              assignee_agent: t.assignee,
              verifier_agent: t.verifier,
              status: t.status,
              verif_state: t.verif,
            })
            .returning();
          if (!task) throw new Error('demo task insert failed');
          ids.set(key, task.id);
          await tx.insert(s.taskSpecs).values({
            project_id: p.id,
            task: task.id,
            overview: {
              purpose: t.purpose,
              background: t.background,
              scope: t.scope,
              out: t.out,
              precond: t.precond,
              doneCond: t.doneCond,
            },
            spec: t.spec ?? {},
            ac: t.spec?.ac ?? [],
            revision: 1,
          });
          for (const [index, c] of t.checklist.entries()) {
            await tx.insert(s.checklistItems).values({
              project_id: p.id,
              task: task.id,
              item_key: c.id,
              content: c.text,
              required: c.required,
              done: c.done,
              verify_method: c.method,
              evidence: c.evidence,
              note: c.note,
              sort_order: index,
            });
          }
          const estimate = demo.sched[key];
          if (estimate)
            await tx.insert(s.taskEstimates).values({
              project_id: p.id,
              task: task.id,
              est: String(estimate.est),
              lo: String(estimate.lo),
              hi: String(estimate.hi),
              tokens_k: String(estimate.tok),
              confidence: estimate.conf,
              basis: estimate.basis,
              agreed_by: 'Planning Agent (Codex · Claude 합의)',
            });
        }
      }
    }
    for (const d of demo.mock.deps) {
      const pred = ids.get(d.pred);
      const succ = ids.get(d.succ);
      if (!pred || !succ) throw new Error('invalid demo dependency');
      await tx
        .insert(s.taskDependencies)
        .values({ project_id: p.id, pred, succ, dep_type: d.type });
    }
    for (const d of demo.sub.defs) {
      await tx
        .insert(s.subagentDefs)
        .values({
          def_key: d.id,
          version: d.v,
          agent: d.agent,
          role: d.role,
          tools: d.tools.split(' · '),
          sandbox: d.sandbox,
          text: d.text,
          hash: d.hash,
          allowed: d.allowed,
          ref: d.ref,
        })
        .onConflictDoNothing();
    }
    await tx.insert(s.counters).values({ project_id: p.id, kind: 'task', value: 12 });
    await tx
      .update(s.schedulePolicy)
      .set({ auto_replan: true, cp_auto: true, threshold_days: '1', assume_rate: '0.6' })
      .where(eq(s.schedulePolicy.singleton, true));
  });
}
