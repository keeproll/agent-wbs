-- Q-13 결정 A: 외부 수신자(회사 밖 · 다른 네트워크에서 메일을 읽는 사람) 표시.
-- 왜: 「전체 보고서 보기」 링크는 같은 PC · 같은 네트워크에서만 열린다(G L1052). 외부 수신자에게는 링크 없이 보고용 보기 + PDF만 보낸다.
-- 기존 받는 사람 · 발송 기록은 모두 내부(false)로 둔다. 지금까지와 똑같이 동작한다.
ALTER TABLE "mail_outbox" ADD COLUMN "external" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mail_recipients" ADD COLUMN "external" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- 외부 발송 한 건은 반드시 보고용 보기이고 PDF를 붙인다. 팀장용(내부 용어 포함) 메일이 외부로 나가지 않게 DB에서도 막는다.
ALTER TABLE "mail_outbox" ADD CONSTRAINT "mail_outbox_external" CHECK (not "mail_outbox"."external" or ("mail_outbox"."view"='ext' and "mail_outbox"."pdf"));--> statement-breakpoint
-- 외부 수신자는 보고용 · PDF 첨부로 고정이고, 일간 보고서는 받지 않는다. 일간 보고서는 팀장용만 있기 때문이다(G L402).
ALTER TABLE "mail_recipients" ADD CONSTRAINT "recipient_external" CHECK (not "mail_recipients"."external" or ("mail_recipients"."view"='ext' and "mail_recipients"."pdf" and not "mail_recipients"."daily"));
