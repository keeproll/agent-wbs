-- M6-03 메일 큐. 발송 한 건(보고서·받는 사람·발송 번호)마다 보기·사유·제목·첨부 여부를 함께 저장한다.
-- 왜 저장하나: 수신자 설정이 나중에 바뀌어도 「그때 어떤 보기로, 왜 보냈는지」가 발송 기록에 그대로 남아야 한다(G L407).
-- 이 파일 전에는 메일 큐에 쓰는 코드가 없었다. 그래도 남은 행이 있으면 아래 기본값으로 채운 뒤 기본값을 없앤다.
ALTER TABLE "mail_outbox" ADD COLUMN "view" "report_view" NOT NULL DEFAULT 'int';--> statement-breakpoint
ALTER TABLE "mail_outbox" ALTER COLUMN "view" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD COLUMN "reason" text NOT NULL DEFAULT '이전 버전에서 저장되어 사유가 없음';--> statement-breakpoint
ALTER TABLE "mail_outbox" ALTER COLUMN "reason" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD COLUMN "subject" text NOT NULL DEFAULT '(제목 없음)';--> statement-breakpoint
ALTER TABLE "mail_outbox" ALTER COLUMN "subject" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD COLUMN "pdf" boolean NOT NULL DEFAULT false;--> statement-breakpoint
-- 15분 뒤 자동 재시도를 이미 한 번 했는지. 자동 재시도는 한 번뿐이다(contracts §2.3).
ALTER TABLE "mail_outbox" ADD COLUMN "retried" boolean NOT NULL DEFAULT false;--> statement-breakpoint
-- 마지막으로 SMTP 호출을 시작한 시각(sending 커밋 시각). 진단과 「수락 여부 불명」 판정 기록에 쓴다.
ALTER TABLE "mail_outbox" ADD COLUMN "sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_reason_text" CHECK (length(btrim("mail_outbox"."reason"))>0);--> statement-breakpoint
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_subject_text" CHECK (length(btrim("mail_outbox"."subject"))>0);--> statement-breakpoint
-- 자동 재시도 대기는 다음 시각이 있어야 한다. 대기 중이 아닌 행은 다음 시각이 없다.
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_next_at" CHECK (("mail_outbox"."state"='retry_wait')=("mail_outbox"."next_at" is not null));--> statement-breakpoint
-- worker가 보낼 차례인 행을 찾는 순서(상태 → 다음 시각)
CREATE INDEX "mail_outbox_due" ON "mail_outbox" ("state","next_at");--> statement-breakpoint
-- 발송 기록(추가 전용)은 어느 큐 행의 몇 번째 발송 결과인지 함께 남긴다.
ALTER TABLE "mail_log" ADD COLUMN "outbox" uuid;--> statement-breakpoint
ALTER TABLE "mail_log" ADD COLUMN "try_no" integer;--> statement-breakpoint
ALTER TABLE "mail_log" ADD CONSTRAINT "mail_log_try_positive" CHECK ("mail_log"."try_no" is null or "mail_log"."try_no">0);
--> statement-breakpoint
-- SMTP 설정의 편집 버전. 연결 확인 결과(status·checked_at)를 적어도 편집 버전은 바뀌지 않게 따로 둔다.
-- 왜: 팀장이 수정 폼을 연 채 「연결 확인」을 눌렀다고 저장이 409 충돌이 되면 안 된다(설정 0025와 같은 방식).
ALTER TABLE "mail_settings" ADD COLUMN "settings_version" timestamp with time zone;--> statement-breakpoint
UPDATE "mail_settings" SET "settings_version"="updated_at";
