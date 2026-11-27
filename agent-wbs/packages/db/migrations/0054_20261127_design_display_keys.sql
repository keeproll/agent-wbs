-- 기존 표시 번호는 보존한다. 99를 넘겨도 잘리지 않게 자릿수를 늘린다.
WITH missing AS (
  SELECT d.id, row_number() OVER (PARTITION BY d.project_id ORDER BY d.created_at,d.id)
    + coalesce((SELECT max(substring(x.resolution->>'displayKey' FROM 4)::bigint) FROM public.design_drifts x
      WHERE x.project_id=d.project_id AND x.resolution->>'displayKey' ~ '^DR-[0-9]{2,}$'),0) AS number
  FROM public.design_drifts d WHERE NOT (coalesce(d.resolution,'{}'::jsonb) ? 'displayKey')
)
UPDATE public.design_drifts d SET resolution=coalesce(d.resolution,'{}'::jsonb)
  || jsonb_build_object('displayKey','DR-' || lpad(m.number::text,greatest(2,length(m.number::text)),'0'))
FROM missing m WHERE m.id=d.id;
