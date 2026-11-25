import { readFile } from 'node:fs/promises';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import type { Pool } from './pool.ts';
import { assertConnectedToTestDatabase, assertTestDatabaseUrl } from './test-database.ts';
import * as s from './schema.ts';

export async function seedSystem(pool: Pool): Promise<void> {
  await pool.query('select public.seed_system()');
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
  spec?: { ac?: unknown[] };
  approved: boolean;
  updated: string;
  actStart: string;
  actEnd: string;
  cg: string;
  srcV: number;
  run: { model: string; effort: string; basis: string; locked: boolean; at: string };
  vrun: DemoTask['run'];
  design: { kind: (typeof s.designKind.enumValues)[number] }[];
  outputs: { name: string; kind: string; required: boolean; verify: string; delivered: boolean }[];
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
    project: {
      name: string;
      target: string;
      regAt: string;
      instr: string;
      repo: { url: string; owner: string; name: string; base: string };
      boot: { approvedAt: string };
      inputs: {
        v: number;
        at: string;
        commit: string;
        proto: string;
        md: string[];
        changes: unknown[];
        result: string;
      }[];
    };
    phases: { id: string; title: string; wps: { id: string; title: string; tasks: string[] }[] }[];
    tasks: Record<string, DemoTask>;
    deps: { pred: string; succ: string; type: 'FS' | 'SS' }[];
    attempts: {
      id: string;
      task: string;
      kind: '개발' | 'QA' | '재작업' | '재검증';
      agent: 'Claude' | 'Codex';
      status: '완료' | '실행 중' | '실패' | '중단';
      start: string;
      end: string;
      summary: string;
      files: string[];
      fail: string;
      tok: number;
      model: string;
      effort: string;
    }[];
    verifs: {
      id: string;
      attempt: string;
      result: 'PASS' | 'FAIL' | 'BLOCKED';
      cmd: string;
      expected: string;
      actual: string;
      defects: string[];
    }[];
    msgs: {
      id: string;
      task: string;
      attempt: string;
      dir: 'in' | 'out';
      from: '팀장' | 'Claude' | 'Codex';
      to: '팀장' | 'Claude' | 'Codex';
      type: string;
      body: string;
      at: string;
      delivery: (typeof s.messageDelivery.enumValues)[number] | '';
      work: string;
      failReason: string;
      pendingNext: boolean;
    }[];
    plannings: {
      id: string;
      title: string;
      scope: string;
      analyses: { agent: 'Claude' | 'Codex' }[];
      review: {
        topic: string;
        kind: string;
        codex: string;
        claude: string;
        choice: string;
        memo: string;
      }[];
    }[];
    proposals: {
      id: string;
      source: { kind: string };
      status: (typeof s.proposalStatus.enumValues)[number];
      ops: unknown[];
      idMap: unknown;
      approvals: { actor: string; action: string; comment: string }[];
    }[];
    hist: {
      at: string;
      actor: string;
      task: string;
      kind: string;
      text: string;
      before: string;
      after: string;
    }[];
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

// P uses local Seoul time; unknown timestamps remain null rather than being invented.
const demoTime = (value: string) => {
  if (!value) throw new Error('demo timestamp is missing');
  return `${value.replace(' ', 'T')}:00+09:00`;
};
function demoRef(ids: Map<string, string>, key: string): string {
  const id = ids.get(key);
  if (!id) throw new Error(`missing demo reference ${key}`);
  return id;
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
    const epochResult = await tx.execute<{ epoch: number }>(
      'select epoch from system_state where id=1 for share',
    );
    const epoch = epochResult.rows[0]?.epoch;
    if (!epoch) throw new Error('system epoch is missing');
    if ((await tx.select().from(s.projects)).length)
      throw new Error('demo seed requires an empty project');
    const [p] = await tx
      .insert(s.projects)
      .values({
        name: demo.mock.project.name,
        repo_url: demo.mock.project.repo.url,
        repo_owner: demo.mock.project.repo.owner,
        repo_name: demo.mock.project.repo.name,
        base_commit: demo.mock.project.repo.base,
        target_date: demo.mock.project.target,
        lead_instruction: demo.mock.project.instr,
        phase: 'active',
      })
      .returning();
    if (!p) throw new Error('demo project insert failed');
    const inputs = new Map<number, string>();
    for (const input of demo.mock.project.inputs) {
      const [version] = await tx
        .insert(s.inputVersions)
        .values({
          project_id: p.id,
          v: input.v,
          commit_sha: input.commit,
          files: { summary: input.proto },
          md_list: input.md,
          changes: input.changes,
          instruction: '',
        })
        .returning();
      if (!version) throw new Error('demo input insert failed');
      inputs.set(input.v, version.id);
      await tx
        .insert(s.inputVersionResults)
        .values({ project_id: p.id, input_version: version.id, result: input.result });
    }
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
              act_start: t.actStart ? demoTime(t.actStart) : null,
              act_end: t.actEnd ? demoTime(t.actEnd) : null,
              conflict_group: t.cg || null,
              src_input_version: inputs.get(t.srcV) ?? null,
              planning_approved_at: t.approved
                ? demoTime(
                    demo.mock.hist.filter((h) => h.task === key && h.kind === '승인').at(-1)?.at ??
                      demo.mock.project.boot.approvedAt,
                  )
                : null,
            })
            .returning();
          if (!task) throw new Error('demo task insert failed');
          ids.set(key, task.id);
          for (const [role, grade] of [
            ['dev', t.run],
            ['qa', t.vrun],
          ] as const)
            await tx
              .insert(s.taskGrades)
              .values({
                project_id: p.id,
                task: task.id,
                role,
                model_id: grade.model,
                effort: grade.effort,
                reason: grade.basis,
                locked: grade.locked,
                effective_from: demoTime(grade.at),
              });
          for (const output of t.outputs)
            await tx.insert(s.taskOutputs).values({ project_id: p.id, task: task.id, ...output });
          for (const design of t.design)
            await tx
              .insert(s.taskDesigns)
              .values({ project_id: p.id, task: task.id, kind: design.kind, content: design });
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
    const attempts = new Map<string, string>();
    const kinds = { 개발: 'dev', QA: 'qa', 재작업: 'rework', 재검증: 'reverify' } as const;
    const statuses = {
      완료: 'completed',
      '실행 중': 'running',
      실패: 'failed',
      중단: 'interrupted',
    } as const;
    for (const a of demo.mock.attempts) {
      const [job] = await tx
        .insert(s.runnerJobs)
        .values({
          project_id: p.id,
          kind: 'attempt',
          payload: { taskKey: a.task, kind: kinds[a.kind], demo: true },
          epoch,
          state: a.status === '실행 중' ? 'started' : a.status === '완료' ? 'done' : 'failed',
          dedup_key: `demo:${a.id}`,
        })
        .returning();
      if (!job) throw new Error('demo job insert failed');
      const [attempt] = await tx
        .insert(s.taskAttempts)
        .values({
          project_id: p.id,
          task: demoRef(ids, a.task),
          attempt_key: a.id,
          attempt_no: Number(a.id.split('-').at(-1)),
          job: job.id,
          base_sha: demo.mock.project.repo.base,
          // P supplies no attempt head SHA; an empty value remains visibly unverified.
          head_sha: '',
          spec_revision: 1,
          kind: kinds[a.kind],
          agent: a.agent,
          status: statuses[a.status],
          started_at: demoTime(a.start),
          ended_at: a.end ? demoTime(`${a.start.slice(0, 10)} ${a.end}`) : null,
          model_id: a.model,
          effort: a.effort,
          summary: a.summary,
          failure: a.fail || null,
          tokens: a.tok,
        })
        .returning();
      if (!attempt) throw new Error('demo attempt insert failed');
      attempts.set(a.id, attempt.id);
      for (const path of a.files)
        await tx.insert(s.attemptFiles).values({ project_id: p.id, attempt: attempt.id, path });
    }
    for (const v of demo.mock.verifs) {
      const [verification] = await tx
        .insert(s.verifications)
        .values({
          project_id: p.id,
          attempt: demoRef(attempts, v.attempt),
          result: v.result,
          head_sha: '',
          spec_revision: 1,
          cmd: v.cmd,
          expected: v.expected,
          actual: v.actual,
        })
        .returning();
      if (!verification) throw new Error('demo verification insert failed');
      for (const defect of v.defects) {
        const [key, ...content] = defect.split(' ');
        if (!key) throw new Error('demo defect key is missing');
        await tx
          .insert(s.defects)
          .values({
            project_id: p.id,
            def_key: key,
            verification: verification.id,
            blocking: defect.includes('(차단 결함)'),
            content: content.join(' '),
          });
      }
    }
    for (const m of demo.mock.msgs)
      await tx
        .insert(s.messages)
        .values({
          project_id: p.id,
          task: demoRef(ids, m.task),
          msg_key: m.id,
          attempt: m.attempt ? demoRef(attempts, m.attempt) : null,
          dir: m.dir,
          type: m.type,
          to_agent: m.to === '팀장' ? null : m.to,
          from_agent: m.from === '팀장' ? null : m.from,
          body: m.body,
          delivery: m.delivery || null,
          pending_next: m.pendingNext,
          work_state: m.work,
          fail_reason: m.failReason || null,
          draft: m.delivery === 'Draft',
          created_at: demoTime(m.at),
        });
    for (const session of demo.mock.plannings) {
      const [planning] = await tx
        .insert(s.plannings)
        .values({
          project_id: p.id,
          planning_key: session.id,
          title: session.title,
          scope: session.scope,
          status: 'unconfirmed',
        })
        .returning();
      if (!planning) throw new Error('demo planning insert failed');
      for (const analysis of session.analyses)
        await tx
          .insert(s.planningAnalyses)
          .values({ project_id: p.id, planning: planning.id, agent: analysis.agent, analysis });
      for (const review of session.review)
        await tx
          .insert(s.planningReviews)
          .values({
            project_id: p.id,
            planning: planning.id,
            topic: review.topic,
            kind: review.kind,
            codex: review.codex,
            claude: review.claude,
            choice: review.choice,
            memo: review.memo,
          });
    }
    for (const cp of demo.mock.proposals) {
      const [proposal] = await tx
        .insert(s.changeProposals)
        .values({
          project_id: p.id,
          cp_key: cp.id,
          source: cp.source.kind,
          status: cp.status,
          ops: cp.ops,
          id_map: cp.idMap,
        })
        .returning();
      if (!proposal) throw new Error('demo proposal insert failed');
      for (const event of cp.approvals)
        await tx
          .insert(s.changeProposalEvents)
          .values({
            project_id: p.id,
            proposal: proposal.id,
            kind: event.action,
            actor: event.actor,
            comment: event.comment,
          });
    }
    for (const h of demo.mock.hist)
      await tx
        .insert(s.taskHistory)
        .values({
          project_id: p.id,
          task: h.task ? demoRef(ids, h.task) : null,
          at: demoTime(h.at),
          actor: h.actor,
          kind: h.kind,
          text: h.text,
          before: h.before,
          after: h.after,
        });
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
          is_demo: true,
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
