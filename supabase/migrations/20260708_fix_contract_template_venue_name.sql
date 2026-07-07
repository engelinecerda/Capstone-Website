-- ── Fix incorrect business name in seeded contract templates ─────────────────
-- The VIP Lounge / Main Hall / Snack Bar / Coffee Bar / Catering templates
-- seeded in 20260707_seed_contract_templates.sql named the venue
-- "Eli Coffee Bar" / "Eli Coffee" in their opening sentence — the correct
-- registered name is "ELI Coffee Events Cafe Binangonan". (The All-Occasion
-- template intentionally keeps "ELI Events & Catering", its own distinct
-- letterhead from the original document — not touched here.)
--
-- Targeted, idempotent text replacement on already-seeded rows only; running
-- this twice is a no-op since the target phrases won't exist after the first
-- run.
-- ─────────────────────────────────────────────────────────────────────────────

update public.contract_templates
set template_body = replace(template_body, 'Eli Coffee Bar ("the Venue")', 'ELI Coffee Events Cafe Binangonan ("the Venue")')
where template_body like '%Eli Coffee Bar ("the Venue")%';

update public.contract_templates
set template_body = replace(template_body, 'Eli Coffee Bar ("the Service Provider")', 'ELI Coffee Events Cafe Binangonan ("the Service Provider")')
where template_body like '%Eli Coffee Bar ("the Service Provider")%';

update public.contract_templates
set template_body = replace(template_body, 'Eli Coffee ("the Venue")', 'ELI Coffee Events Cafe Binangonan ("the Venue")')
where template_body like '%Eli Coffee ("the Venue")%';
