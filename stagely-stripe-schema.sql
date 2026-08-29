-- ════════════════════════════════════════════════════════════════════════
-- Stagely — colonnes de facturation Stripe
-- ════════════════════════════════════════════════════════════════════════
-- À exécuter une fois dans l'éditeur SQL de Supabase, AVANT de renseigner
-- les variables d'environnement Stripe en production.
--
-- Le code tolère l'absence de ces colonnes (api/stripe-webhook.js retombe
-- sur une écriture status/plan seuls), mais sans elles le lien entre un club
-- et son client Stripe est perdu : le portail de facturation ne peut plus
-- s'ouvrir et un second paiement créerait un client en double. Cette
-- migration n'est donc pas optionnelle en pratique.
--
-- Toutes les instructions sont idempotentes : les relancer ne casse rien.

-- Client Stripe du club. Un club = un customer, réutilisé à chaque
-- changement de palier pour garder l'historique de facturation au même
-- endroit.
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS stripe_customer_id text;

-- Abonnement en cours. Sert au diagnostic et au rapprochement avec le
-- tableau de bord Stripe ; le webhook s'appuie sur les métadonnées, pas sur
-- cette colonne.
ALTER TABLE clubs ADD COLUMN IF NOT EXISTS stripe_subscription_id text;

-- Recherche du club à partir du customer Stripe : chemin de repli du webhook
-- quand un événement arrive sans métadonnée club_id (abonnement créé
-- manuellement depuis le tableau de bord Stripe, par exemple).
CREATE UNIQUE INDEX IF NOT EXISTS clubs_stripe_customer_id_key
  ON clubs (stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

-- Vérification : doit lister les deux colonnes.
-- SELECT column_name FROM information_schema.columns
--  WHERE table_name = 'clubs' AND column_name LIKE 'stripe%';
