alter table public.payment
  add column if not exists ocr_extracted jsonb;

notify pgrst, 'reload schema';
