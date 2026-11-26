-- UAT-VERIFY-02, P6246–6252: 경로를 연결한 사실과 파일 업로드를 구분한다. 읽지 않은 파일의 지문·크기를 만들지 않는다.
ALTER TABLE public.evidence ADD COLUMN reference_path text;
--> statement-breakpoint
ALTER TABLE public.evidence ALTER COLUMN storage_path DROP NOT NULL, ALTER COLUMN sha256 DROP NOT NULL, ALTER COLUMN size DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE public.evidence ADD CONSTRAINT evidence_source CHECK
  ((reference_path IS NULL AND storage_path IS NOT NULL AND sha256 IS NOT NULL AND size IS NOT NULL)
   OR (reference_path IS NOT NULL AND length(btrim(reference_path))>0 AND storage_path IS NULL AND sha256 IS NULL AND size IS NULL AND verification IS NOT NULL));
--> statement-breakpoint
ALTER TABLE public.evidence ADD CONSTRAINT evidence_verification_reference UNIQUE (verification, reference_path);
