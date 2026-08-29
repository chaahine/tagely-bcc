// POST /api/stripe-webhook   (appelé par Stripe, jamais par le navigateur)
//
// SEUL endroit du produit qui écrit clubs.status / clubs.plan à partir d'un
// paiement. Ni Checkout ni le portail de facturation ne les touchent : une
// redirection de retour peut être fermée ou perdue, alors qu'un webhook est
// réémis jusqu'à recevoir un 2xx. Faire foi sur la redirection donnerait des
// clubs qui ont payé sans être activés.
//
// ── Corps brut obligatoire ──
// La signature Stripe porte sur les octets exacts du corps. Vercel parse le
// JSON automatiquement ; re-sérialiser l'objet parsé produirait des octets
// différents (ordre des clés, espaces) et invaliderait toute signature. D'où
// `bodyParser: false` ci-dessous et la lecture manuelle du flux.
//
// ── Idempotence ──
// Stripe réémet un événement tant qu'il n'a pas reçu de 2xx, et peut le
// livrer deux fois. Tous les traitements ici sont des écritures de la forme
// "mets ces colonnes à cette valeur" : les rejouer ne produit rien de
// différent. Aucun compteur, aucune insertion, donc rien à dédupliquer.

import { sbAdmin } from './_lib.js';
import {
  verifyStripeSignature,
  readRawBody,
  planForPriceId,
  stripeRequest,
} from './_stripe.js';

export const config = { api: { bodyParser: false } };

// Écrit les colonnes de facturation en tolérant qu'elles n'existent pas
// encore sur cet environnement : la migration (stagely-stripe-schema.sql)
// peut ne pas avoir été appliquée. On retente alors sans les colonnes
// Stripe, pour que status/plan — l'essentiel — passent quand même.
async function patchClub(clubId, fields) {
  const params = `?id=eq.${encodeURIComponent(clubId)}`;
  try {
    await sbAdmin('clubs', { method: 'PATCH', params, body: fields });
    return true;
  } catch (e) {
    const fallback = { ...fields };
    delete fallback.stripe_customer_id;
    delete fallback.stripe_subscription_id;
    delete fallback.current_period_end;
    if (!Object.keys(fallback).length) {
      console.error('stripe-webhook: écriture impossible pour', clubId, e.message);
      return false;
    }
    try {
      await sbAdmin('clubs', { method: 'PATCH', params, body: fallback });
      console.warn('stripe-webhook: colonnes Stripe absentes, status/plan seuls écrits pour', clubId);
      return true;
    } catch (e2) {
      console.error('stripe-webhook: écriture impossible pour', clubId, e2.message);
      return false;
    }
  }
}

// Retrouve le club visé. Priorité aux métadonnées (posées à la création de
// la session ET de l'abonnement, cf. billing-checkout.js) ; à défaut, on
// remonte par le customer Stripe déjà enregistré sur un club.
async function resolveClubId(object) {
  const meta = (object && object.metadata) || {};
  if (meta.club_id) return meta.club_id;
  if (object && object.client_reference_id) return object.client_reference_id;
  const customer = object && (typeof object.customer === 'string' ? object.customer : object.customer?.id);
  if (!customer) return null;
  try {
    const rows = await sbAdmin('clubs', {
      params: `?stripe_customer_id=eq.${encodeURIComponent(customer)}&select=id&limit=1`,
    });
    return Array.isArray(rows) && rows.length ? rows[0].id : null;
  } catch (e) {
    return null;
  }
}

function planFromSubscription(sub) {
  const item = sub && sub.items && Array.isArray(sub.items.data) && sub.items.data[0];
  const priceId = item && item.price && item.price.id;
  return planForPriceId(priceId) || (sub && sub.metadata && sub.metadata.plan) || null;
}

// Traduction des statuts d'abonnement Stripe en clubs.status.
//  - active / trialing        → 'active'  (le club a accès)
//  - past_due / incomplete    → 'active'  : Stripe relance le paiement
//    pendant plusieurs jours. Couper l'accès à la première carte refusée
//    ferait perdre un client pour une carte expirée ; on attend que Stripe
//    déclare l'abandon.
//  - canceled / unpaid /
//    incomplete_expired       → 'suspended'
function statusFromSubscription(stripeStatus) {
  if (['active', 'trialing', 'past_due', 'incomplete'].includes(stripeStatus)) return 'active';
  if (['canceled', 'unpaid', 'incomplete_expired'].includes(stripeStatus)) return 'suspended';
  return null; // statut inconnu : on ne touche à rien plutôt que de deviner
}

async function handleSubscription(sub) {
  const clubId = await resolveClubId(sub);
  if (!clubId) {
    console.warn('stripe-webhook: abonnement sans club identifiable', sub && sub.id);
    return;
  }
  const status = statusFromSubscription(sub.status);
  if (!status) return;
  const plan = planFromSubscription(sub);
  const fields = {
    status,
    stripe_customer_id: typeof sub.customer === 'string' ? sub.customer : undefined,
    stripe_subscription_id: sub.id,
  };
  // Le palier n'est écrit que s'il a pu être déterminé — sinon on préfère
  // conserver celui déjà en base plutôt que le faire retomber sur un défaut.
  if (plan) fields.plan = plan;
  // Un abonnement résilié ne doit pas laisser un palier payant en base : le
  // club retombe au palier d'entrée en plus d'être suspendu.
  if (status === 'suspended') fields.plan = 'essentiel';
  // L'essai n'a plus lieu d'être une fois un abonnement en place.
  fields.trial_ends_at = null;
  await patchClub(clubId, fields);
}

async function handleCheckoutCompleted(session) {
  const clubId = await resolveClubId(session);
  if (!clubId) {
    console.warn('stripe-webhook: session sans club identifiable', session && session.id);
    return;
  }
  // La session ne porte pas le détail de l'abonnement : on le relit pour
  // connaître le prix réellement souscrit, plutôt que de faire confiance au
  // palier demandé au départ (l'utilisateur a pu en changer dans Checkout).
  let plan = (session.metadata && session.metadata.plan) || null;
  let subStatus = 'active';
  if (session.subscription) {
    const subId = typeof session.subscription === 'string' ? session.subscription : session.subscription.id;
    try {
      const sub = await stripeRequest(`/subscriptions/${subId}`, { method: 'GET' });
      plan = planFromSubscription(sub) || plan;
      subStatus = statusFromSubscription(sub.status) || 'active';
    } catch (e) {
      // Relecture impossible : on active quand même sur la foi du paiement
      // encaissé. Le customer.subscription.updated qui suit corrigera le
      // palier si besoin.
      console.warn('stripe-webhook: relecture de l\'abonnement impossible', e.message);
    }
  }
  await patchClub(clubId, {
    status: subStatus,
    ...(plan ? { plan } : {}),
    stripe_customer_id: typeof session.customer === 'string' ? session.customer : undefined,
    stripe_subscription_id: typeof session.subscription === 'string' ? session.subscription : undefined,
    trial_ends_at: null,
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    console.error('stripe-webhook: STRIPE_WEBHOOK_SECRET manquante');
    return res.status(503).json({ error: 'Webhook non configuré' });
  }

  let raw;
  try {
    raw = await readRawBody(req);
  } catch (e) {
    return res.status(400).json({ error: 'Corps illisible' });
  }

  if (!verifyStripeSignature(raw, req.headers['stripe-signature'], secret)) {
    // Jamais de détail sur ce qui a échoué : cet endpoint est public.
    return res.status(400).json({ error: 'Signature invalide' });
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch (e) {
    return res.status(400).json({ error: 'JSON invalide' });
  }

  try {
    const object = (event.data && event.data.object) || {};
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(object);
        break;
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        await handleSubscription(object);
        break;
      default:
        // Tout le reste est acquitté sans traitement : répondre 2xx évite que
        // Stripe réessaie indéfiniment des événements qui ne nous concernent
        // pas (invoice.*, payment_intent.*, ...).
        break;
    }
    return res.status(200).json({ received: true });
  } catch (e) {
    // 500 => Stripe réessaiera. C'est voulu : mieux vaut un nouvel essai
    // qu'un club payé qui reste suspendu.
    console.error('stripe-webhook:', event.type, e.message);
    return res.status(500).json({ error: 'Traitement en échec' });
  }
}

// Exportés pour les tests — la logique de traduction Stripe → état du club
// est le coeur métier de ce fichier, elle mérite d'être vérifiable sans
// simuler une requête HTTP complète.
export const __test = { statusFromSubscription, planFromSubscription, resolveClubId };
