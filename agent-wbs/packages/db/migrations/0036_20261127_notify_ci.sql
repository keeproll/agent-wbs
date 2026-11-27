-- M6·M7 통합: Telegram 알림 한 건을 만드는 공통 함수.
-- 상태 전이 트리거(M6-04)와 CI 서버 코드(M7: 빌드 결과·서비스 없음·Gate 미충족·병합 불일치)가 함께 부른다.
-- 왜: 알림 기록(notify_events)과 발송 대기열(notify_outbox)을 늘 같은 트랜잭션에서 함께 만든다. 경로가 둘이면 한쪽은 기록만 남고 발송되지 않는다.
-- any_rule=true(serviceDown)는 알림 규칙과 무관하게, 전체 알림이 켜져 있으면 보낸다(M7-03 결정 11).
CREATE FUNCTION public.awbs_notify_emit(p uuid, event_kind text, event_key text, target text, nav text, state_text text,
  extra jsonb DEFAULT '{}'::jsonb, any_rule boolean DEFAULT false) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  project_name text; ev uuid; delivery uuid := gen_random_uuid(); conf record; body text; label text; app_url text; duplicates integer;
BEGIN
  IF current_setting('awbs.reset',true)='on' THEN RETURN; END IF;
  SELECT name INTO project_name FROM public.projects WHERE id=p;
  IF NOT FOUND THEN RETURN; END IF;
  -- 같은 사건이 아직 열려 있으면 새로 보내지 않고 중복 횟수만 센다.
  UPDATE public.notify_events SET dup_count=dup_count+1 WHERE project_id=p AND dedup_key=event_key AND resolved_at IS NULL;
  IF FOUND THEN RETURN; END IF;
  -- 꺼진 동안 생긴 상태를 나중에 같은 상태의 저장만으로 발송하지 않는다.
  SELECT * INTO conf FROM public.notify_settings WHERE singleton AND enabled AND secret_key IS NOT NULL;
  IF NOT FOUND OR NOT (any_rule OR coalesce((SELECT enabled FROM public.notify_rules WHERE key=event_kind),event_kind IN ('fail','admin','approve','buildFail'))) THEN RETURN; END IF;
  INSERT INTO public.notify_events(project_id,dedup_key,kind,ref) VALUES(p,event_key,event_kind,coalesce(extra,'{}'::jsonb) || jsonb_build_object('path',nav))
    ON CONFLICT (coalesce(project_id::text,'global'),dedup_key) WHERE resolved_at IS NULL
    DO UPDATE SET dup_count=notify_events.dup_count+1 RETURNING id,dup_count INTO ev,duplicates;
  IF duplicates>0 THEN RETURN; END IF;
  label := CASE event_kind WHEN 'done' THEN 'Task 완료' WHEN 'fail' THEN 'Task 실패' WHEN 'admin' THEN '관리자 개입 필요' WHEN 'approve' THEN '승인 요청'
    WHEN 'buildOk' THEN '빌드 성공' WHEN 'serviceDown' THEN '서비스 없음' ELSE '빌드 실패' END;
  SELECT s.app_url INTO app_url FROM public.app_settings s WHERE singleton;
  target := regexp_replace(replace(replace(target,chr(10),' '),chr(13),' '),'[0-9]{6,12}:[A-Za-z0-9_-]{20,}','[REDACTED]','g');
  body := '[Agent WBS] ' || label || chr(10) || '프로젝트: ' || left(project_name,300) || chr(10) || '대상: ' || target || chr(10)
    || '상태: ' || state_text || chr(10) || '발생: ' || to_char(clock_timestamp() AT TIME ZONE 'Asia/Seoul','YYYY-MM-DD HH24:MI') || chr(10) || '다음 행동: WBS에서 상세 내용과 근거를 확인하세요.';
  IF app_url IS NOT NULL AND app_url<>'' THEN body := body || chr(10) || 'WBS에서 확인: ' || rtrim(app_url,'/') || nav; END IF;
  body := regexp_replace(body,'[0-9]{6,12}:[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}','[REDACTED]','g');
  INSERT INTO public.notify_outbox(project_id,event,delivery_id,epoch,state,payload,kind)
    SELECT p,ev,delivery,epoch,'queued',jsonb_build_object('secretKey',conf.secret_key,'chatId',conf.chat_id,'targetName',conf.target_name,
      'event',event_kind,'target',target,'path',nav,'message',left(body,4096)),'biz' FROM public.system_state WHERE id=1;
EXCEPTION WHEN OTHERS THEN
  -- 알림 생성 오류는 이 함수의 작업만 되돌린다. 업무 상태(Task·CI 보고) 저장은 계속된다(G1076).
  RAISE LOG 'Telegram 알림 생성 실패: 상태 저장은 계속합니다';
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.awbs_notify_emit(uuid,text,text,text,text,text,jsonb,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.awbs_notify_emit(uuid,text,text,text,text,text,jsonb,boolean) TO awbs_app,awbs_data_owner;
--> statement-breakpoint
-- CI 실행(ci_runs)의 빌드 알림은 M7 CI 서버 코드가 만든다(순번 run_no로 최신 결과만 열고 닫기, 기준선 실패 묶음).
-- 트리거도 만들면 같은 결과가 두 번 쌓이므로 ci_runs 트리거를 뗀다(M6·M7 통합).
DROP TRIGGER telegram_transition ON public.ci_runs;
--> statement-breakpoint
-- 상태 전이 트리거: 판정은 0033과 같다. 바뀐 것은 둘이다: 알림 한 건 만들기를 위 공통 함수로 옮겼고, 재시도 한도(fail) 중복 키를 경보 키로 맞췄다.
CREATE OR REPLACE FUNCTION public.awbs_notify_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE
  n jsonb := to_jsonb(NEW); o jsonb := CASE WHEN TG_OP='UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  p uuid; event_kind text; event_key text; target text; nav text; state_text text;
  active boolean := false; previous_active boolean := false;
BEGIN
  IF current_setting('awbs.reset',true)='on' THEN RETURN NEW; END IF;
  SELECT id INTO p FROM public.projects LIMIT 1;
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
    -- 중복 키는 경보 키(retry:<시도 묶음>)를 따른다. 반복 보고 집계(repository.alert → repeatFailure)와 같은 키다(M6·M7 통합).
    -- 왜: 팀장이 다시 실행해 새 시도 묶음이 다시 한도를 넘으면 새 경보이고 새 알림이다(M7-06 시나리오). 같은 경보의 반복 보고만 중복으로 센다.
    event_key := 'fail|retry|' || substr(n->>'key',7); state_text := '실행 실패 — 자동 재시도 한도 초과';
    active := n->>'resolved_at' IS NULL; previous_active := TG_OP='UPDATE' AND o->>'resolved_at' IS NULL;
  WHEN 'execution_holds' THEN
    event_kind := 'admin'; event_key := 'admin|observation|' || (n->>'id'); target := '하위 Agent 관측'; nav := '/settings/runner';
    active := n->>'slot_state'='unconfirmed'; previous_active := o->>'slot_state'='unconfirmed'; state_text := '하위 Agent 관측 미확인(보유)';
  ELSE RETURN NEW;
  END CASE;
  IF NOT coalesce(active,false) THEN
    UPDATE public.notify_events SET resolved_at=clock_timestamp() WHERE project_id=p AND dedup_key=event_key AND resolved_at IS NULL;
    RETURN NEW;
  END IF;
  -- 같은 상태의 제목 수정·경보 확인은 새 실패 보고가 아니다.
  IF coalesce(previous_active,false) THEN RETURN NEW; END IF;
  PERFORM public.awbs_notify_emit(p,event_kind,event_key,target,nav,state_text);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- 알림 생성 오류는 이 블록의 작업만 되돌린다. Task·Runner 저장은 계속된다(G1076).
  RAISE LOG 'Telegram 알림 생성 실패: 상태 저장은 계속합니다';
  RETURN NEW;
END $$;
