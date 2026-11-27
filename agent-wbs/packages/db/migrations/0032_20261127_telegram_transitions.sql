-- 저장한 상태와 알림 대기열은 같은 트랜잭션에서 확정한다. 발송 실패는 업무 상태를 바꾸지 않는다.
CREATE FUNCTION public.awbs_notify_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  n jsonb := to_jsonb(NEW); o jsonb := CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  p uuid; project_name text; event_kind text; event_key text; target text; nav text; state_text text;
  active boolean := false; previous_active boolean := false; ev uuid; delivery uuid := gen_random_uuid(); conf record;
  body text; label text; app_url text; duplicates integer; passed_steps text;
BEGIN
  IF current_setting('awbs.reset',true)='on' THEN RETURN NEW; END IF;
  SELECT id,name INTO p,project_name FROM public.projects LIMIT 1;
  IF p IS NULL OR (n ? 'project_id' AND n->>'project_id' IS DISTINCT FROM p::text) THEN RETURN NEW; END IF;
  CASE TG_TABLE_NAME
  WHEN 'tasks' THEN
    target := n->>'task_key' || ' — ' || left(n->>'title',1000); nav := '/wbs/' || (n->>'task_key');
    IF n->>'status'='done' AND o->>'status' IS DISTINCT FROM 'done' AND EXISTS (
      SELECT 1 FROM public.merge_queue q JOIN public.ci_runs c ON c.id=q.ci_run
      WHERE q.task=NEW.id AND q.status='merged' AND q.actual_merge_sha IS NOT NULL AND c.stage=2 AND c.status='pass') THEN
      event_kind := 'done'; active := true; state_text := 'WBS 최종 완료';
    ELSE
      event_kind := 'fail'; active := n->>'verif_state'='fail'; previous_active := o->>'verif_state'='fail';
      state_text := 'QA FAIL 확정';
    END IF;
    event_key := event_kind || '|task|' || (n->>'id');
  WHEN 'runner_readiness' THEN
    event_kind := 'admin'; event_key := 'admin|ready|' || (n->>'key');
    target := 'Runner 준비 상태 — ' || (n->>'key'); nav := '/settings/runner';
    active := n->>'status'='fail'; previous_active := o->>'status'='fail'; state_text := '준비 상태 실패';
  WHEN 'github_settings' THEN
    event_kind := 'admin'; event_key := 'admin|github'; target := 'GitHub 인증'; nav := '/settings/runner';
    active := n->>'status'='failed'; previous_active := o->>'status'='failed'; state_text := 'GitHub 인증 실패';
  WHEN 'input_change_commits' THEN
    event_kind := 'admin'; event_key := 'admin|input|' || (n->>'sha'); target := '입력 자료 변경 — ' || left(n->>'sha',12); nav := '/project';
    active := n->>'state'='pending'; previous_active := o->>'state'='pending'; state_text := '팀장 확인 대기';
  WHEN 'change_proposals' THEN
    event_kind := 'approve'; event_key := 'approve|cp|' || (n->>'id'); target := n->>'cp_key' || ' — ' || left(n->>'title',1000); nav := '/change/' || (n->>'cp_key');
    active := n->>'status'='review'; previous_active := o->>'status'='review'; state_text := 'Change Proposal 승인 대기';
  WHEN 'tech_decisions' THEN
    event_kind := 'approve'; event_key := 'approve|decision|' || (n->>'id'); target := n->>'td_key' || ' — ' || left(n->>'title',1000); nav := '/design';
    active := n->>'status' IN ('pending','change'); previous_active := o->>'status' IN ('pending','change'); state_text := '기술 결정 승인 대기';
  WHEN 'wbs_drafts' THEN
    event_kind := 'approve'; event_key := 'approve|wbs|' || (n->>'project_id'); target := '초기 WBS'; nav := '/wbs';
    active := n->>'status'='pending'; previous_active := o->>'status'='pending'; state_text := '초기 WBS 승인 대기';
  WHEN 'alerts' THEN
    -- Runner가 재시도 정책을 끝까지 계산한 결과만 사용한다. 단순 failed 상태는 한도 초과의 근거가 아니다.
    IF n->>'key' NOT LIKE 'retry:%' THEN RETURN NEW; END IF;
    event_kind := 'fail'; target := n->'target'->>'taskKey'; nav := '/wbs/' || target;
    event_key := 'fail|retry|' || target; state_text := '실행 실패 — 자동 재시도 한도 초과';
    active := n->>'resolved_at' IS NULL; previous_active := TG_OP='UPDATE' AND o->>'resolved_at' IS NULL;
  WHEN 'execution_holds' THEN
    event_kind := 'admin'; event_key := 'admin|observation|' || (n->>'id'); target := '하위 Agent 관측'; nav := '/settings/runner';
    active := n->>'slot_state'='unconfirmed'; previous_active := o->>'slot_state'='unconfirmed'; state_text := '하위 Agent 관측 미확인(보유)';
  WHEN 'ci_runs' THEN
    IF (n->>'stage')::integer=1 THEN RETURN NEW; END IF;
    target := (CASE n->>'stage' WHEN '2' THEN '② 통합 확인' WHEN '3' THEN '③ 야간 점검' ELSE '④ 배포 확인' END)
      || CASE WHEN n->>'pr' IS NOT NULL THEN ' — PR #' || (n->>'pr') ELSE ' — ' || (n->>'ref') END;
    nav := '/ci/' || (n->>'run_key');
    event_key := 'buildFail|' || (n->>'stage') || '|' || coalesce(n->>'pr',n->>'ref');
    IF n->>'status'='pass' THEN
      UPDATE public.notify_events SET resolved_at=clock_timestamp() WHERE project_id=p AND dedup_key=event_key AND resolved_at IS NULL;
      IF (n->>'stage')::integer=3 THEN RETURN NEW; END IF;
      event_kind := 'buildOk'; event_key := 'buildOk|' || (n->>'id');
      active := true; previous_active := o->>'status'='pass';
      SELECT string_agg(step_key,', ' ORDER BY created_at,id) INTO passed_steps FROM public.ci_steps WHERE run=NEW.id AND status='pass';
      state_text := CASE n->>'stage' WHEN '2' THEN '통합 확인 통과' ELSE '배포 확인 통과' END || ' — 통과 단계: ' || coalesce(passed_steps,'개별 단계 보고 없음');
    ELSE
      IF n->>'status'<>'fail' THEN RETURN NEW; END IF;
      event_kind := 'buildFail'; active := n->>'status'='fail'; previous_active := o->>'status'='fail';
      state_text := '실패 — 실패 단계: ' || coalesce(n->>'fail_step','보고 없음');
    END IF;
  ELSE RETURN NEW;
  END CASE;
  IF NOT coalesce(active,false) THEN
    UPDATE public.notify_events SET resolved_at=clock_timestamp() WHERE project_id=p AND dedup_key=event_key AND resolved_at IS NULL;
    RETURN NEW;
  END IF;
  UPDATE public.notify_events SET dup_count=dup_count+1 WHERE project_id=p AND dedup_key=event_key AND resolved_at IS NULL;
  IF FOUND THEN RETURN NEW; END IF;
  -- 꺼진 동안 생긴 상태를 나중에 같은 상태의 저장만으로 발송하지 않는다.
  IF coalesce(previous_active,false) THEN RETURN NEW; END IF;
  SELECT * INTO conf FROM public.notify_settings WHERE singleton AND enabled AND secret_key IS NOT NULL;
  IF NOT FOUND OR NOT coalesce((SELECT enabled FROM public.notify_rules WHERE key=event_kind),event_kind IN ('fail','admin','approve','buildFail')) THEN RETURN NEW; END IF;
  INSERT INTO public.notify_events(project_id,dedup_key,kind,ref) VALUES(p,event_key,event_kind,jsonb_build_object('path',nav))
    ON CONFLICT (coalesce(project_id::text,'global'),dedup_key) WHERE resolved_at IS NULL
    DO UPDATE SET dup_count=notify_events.dup_count+1 RETURNING id,dup_count INTO ev,duplicates;
  IF duplicates>0 THEN RETURN NEW; END IF;
  label := CASE event_kind WHEN 'done' THEN 'Task 완료' WHEN 'fail' THEN 'Task 실패' WHEN 'admin' THEN '관리자 개입 필요' WHEN 'approve' THEN '승인 요청' WHEN 'buildOk' THEN '빌드 성공' ELSE '빌드 실패' END;
  SELECT s.app_url INTO app_url FROM public.app_settings s WHERE singleton;
  target := regexp_replace(replace(replace(target,chr(10),' '),chr(13),' '),'[0-9]{6,12}:[A-Za-z0-9_-]{20,}','[REDACTED]','g');
  body := '[Agent WBS] ' || label || chr(10) || '프로젝트: ' || left(project_name,300) || chr(10) || '대상: ' || target || chr(10)
    || '상태: ' || state_text || chr(10) || '발생: ' || to_char(clock_timestamp() AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD HH24:MI') || chr(10) || '다음 행동: WBS에서 상세 내용과 근거를 확인하세요.';
  IF app_url IS NOT NULL AND app_url<>'' THEN body := body || chr(10) || 'WBS에서 확인: ' || rtrim(app_url,'/') || nav; END IF;
  body := regexp_replace(body,'[0-9]{6,12}:[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}','[REDACTED]','g');
  INSERT INTO public.notify_outbox(project_id,event,delivery_id,epoch,state,payload,kind)
    SELECT p,ev,delivery,epoch,'queued',jsonb_build_object('secretKey',conf.secret_key,'chatId',conf.chat_id,'targetName',conf.target_name,
      'event',event_kind,'target',target,'path',nav,'message',left(body,4096)),'biz' FROM public.system_state WHERE id=1;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- 알림 생성 오류는 이 블록의 작업만 되돌린다. Task·Runner 저장은 계속된다(G1076).
  RAISE LOG 'Telegram 알림 생성 실패: 상태 저장은 계속합니다';
  RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.awbs_notify_transition() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.awbs_notify_transition() TO awbs_app,awbs_data_owner;
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['tasks','runner_readiness','github_settings','input_change_commits','change_proposals','tech_decisions','wbs_drafts','execution_holds','ci_runs','alerts'] LOOP
    EXECUTE format('CREATE TRIGGER telegram_transition AFTER INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.awbs_notify_transition()',t);
  END LOOP;
END $$;
