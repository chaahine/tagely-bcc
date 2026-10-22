-- Suivi serveur de « Envoyer le planning » (2026-10-22).
-- Une ligne par humoriste et par mois envoyé. Sert à :
--  - afficher dans l'app la date d'envoi, sur tous les appareils ;
--  - n'ouvrir dans le portail que les mois envoyés (api/data-read.js).
-- Écrite et lue uniquement par le serveur (service_role) : RLS sans policy.

create table if not exists planning_sends (
  club_id uuid not null references clubs(id) on delete cascade,
  month text not null check (month ~ '^\d{4}-\d{2}$'),
  comedian_id text not null,
  sent_at timestamptz,            -- null = envoyé avant ce suivi, date inconnue
  primary key (club_id, month, comedian_id)
);
alter table planning_sends enable row level security;

-- Reprise : octobre 2026 était déjà envoyé et en cours, il reste visible.
insert into planning_sends (club_id, month, comedian_id, sent_at)
select distinct club_id, '2026-10', comedian_id, null::timestamptz
from assignments
where slot_key like '2026-10-%' and club_id is not null
on conflict do nothing;

-- Dates d'envoi retrouvées chez Brevo.
update planning_sends p set sent_at = v.sent_at::timestamptz
from comedians c, (values
  ('yassine.benkhadda@gmail.com', '2026-10-22T11:20:53+02:00'),
  ('amylondonisfunny@gmail.com', '2026-10-20T12:22:18+02:00'),
  ('fahdlbk@gmail.com', '2026-10-18T15:42:17+02:00'),
  ('guanodieu@gmail.com', '2026-10-14T19:06:03+02:00'),
  ('walidjabbari.contact@gmail.com', '2026-10-14T18:37:47+02:00'),
  ('charlynyobe1@gmail.com', '2026-10-14T18:21:23+02:00')
) as v(email, sent_at)
where lower(c.email) = v.email and c.id::text = p.comedian_id and p.month = '2026-10';

select month, count(*) as humoristes, max(sent_at) as dernier_envoi from planning_sends group by month;
