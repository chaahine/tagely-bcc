-- 2026-10-15 — Fermeture de la lecture publique (clé anon).
-- Toutes les lectures passent désormais par /api/data-read (clé service_role,
-- club tiré du token admin ou du code portail). La clé anon, visible dans le
-- code des pages, ne doit plus rien pouvoir lire. RLS reste activée : sans
-- policy, l'anon ne voit plus aucune ligne ; la service_role contourne RLS.
-- Idempotent.
BEGIN;
drop policy if exists "lecture publique comedians" on public.comedians;
drop policy if exists "lecture publique assignments" on public.assignments;
drop policy if exists "lecture publique dispos" on public.dispos;
drop policy if exists "lecture publique dispo_status" on public.dispo_status;
drop policy if exists "lecture publique chat_messages" on public.chat_messages;
drop policy if exists "lecture publique schedule_templates" on public.schedule_templates;
drop policy if exists "lecture publique rooms" on public.rooms;
drop policy if exists "lecture publique events" on public.events;
COMMIT;

-- Vérification : doit renvoyer 0 ligne.
select tablename, policyname from pg_policies
where schemaname = 'public' and cmd in ('SELECT', 'ALL')
  and (roles && array['anon', 'public']::name[]);
