-- Tracks Google Cloud Vision API usage per calendar month so the admin
-- portal can warn before the 1,000 free-tier units/month are exceeded.
-- Each Vision API call bills 1 unit per feature requested:
--   ocr-payment     → DOCUMENT_TEXT_DETECTION                    = 1 unit/call
--   verify-contract → LABEL_DETECTION + DOCUMENT_TEXT_DETECTION  = 2 units/call
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.vision_api_usage (
  month_start date        PRIMARY KEY,
  units_used  integer     NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.vision_api_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "admin read vision_api_usage" ON public.vision_api_usage FOR SELECT
  USING (get_my_role() IN ('manager', 'admin'));

-- Edge functions call this via the service role key, which already bypasses
-- RLS; SECURITY DEFINER keeps the upsert atomic under concurrent calls.
CREATE OR REPLACE FUNCTION public.increment_vision_usage(p_units integer)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.vision_api_usage (month_start, units_used)
  VALUES (date_trunc('month', now())::date, p_units)
  ON CONFLICT (month_start)
  DO UPDATE SET units_used = vision_api_usage.units_used + p_units, updated_at = now();
END;
$$;

GRANT EXECUTE ON FUNCTION public.increment_vision_usage(integer) TO service_role;
