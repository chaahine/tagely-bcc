// POST /api/billing-checkout
//   Cas A (club actif ou en essai) : header Authorization: Bearer <token>
//                                    body { plan }
//   Cas B (club suspendu)          : body { plan, email, password }
//
// Ouvre une session Stripe Checkout et renvoie son URL. Le client redirige
// dessus ; le passage effectif au palier payé est écrit en base par le
// webhook (api/stripe-webhook.js), jamais ici — une redirection de retour
// peut être perdue, un webhook est réémis jusqu'à acquittement.
//
// ── Pourquoi deux modes d'authentification ──
// Un club dont l'essai a expiré passe en status 'suspended', et
// api/admin-login.js refuse alors de le connecter ("Ce club est suspendu").
// Sans le cas B, ce club serait dans un cul-de-sac parfait : plus de
// session, donc aucun moyen de souscrire, donc aucun moyen de revenir. Le
// cas B revérifie email + mot de passe exactement comme le login (mêmes
// contrôles, même message générique en cas d'échec) et n'émet AUCUN token :
// il ouvre seulement une session de paiement. Le seul droit accordé à un
// club suspendu est celui de payer pour ne plus l'être.

import {
  applyCors,
  sbAdmin,
  verifyAdminToken,
  verifyPasswordHash,
  isValidEmail,
} from './_lib.js';
import {
  stripeConfigured,
  stripeRequest,
  priceIdForPlan,
  purchasablePlans,
  publicOrigin,
} from './_stripe.js';

// Résout le club à facturer et l'email de contact, selon le mode d'auth.
// Retourne { club, email } ou { error, status }.
async function resolveTarget(req) {
  const auth = verifyAdminToken(req);

  if (auth) {
    const rows = await sbAdmin('clubs', {
      params: `?id=eq.${encodeURIComponent(auth.active_club_id)}&select=id,name,admin_email,stripe_customer_id&limit=1`,
    });
    const club = Array.isArray(rows) && rows.length ? rows[0] : null;
    if (!club) return { error: 'Club introuvable', status: 404 };
    let email = club.admin_email || null;
    if (!email) {
      try {
        const admins = await sbAdmin('admins', {
          params: `?id=eq.${encodeURIComponent(auth.admin_id)}&select=email&limit=1`,
        });
        email = Array.isArray(admins) && admins.length ? admins[0].email : null;
      } catch (e) { /* non bloquant : Stripe demandera l'email lui-même */ }
    }
    return { club, email };
  }

  // ── Cas B : club suspendu, plus de session possible ──
  const { email, password } = req.body || {};
  if (!isValidEmail(email) || typeof password !== 'string' || !password) {
    return { error: 'Non autorisé — reconnecte-toi en admin', status: 401 };
  }
  const cleanEmail = String(email).trim().toLowerCase();
  const admins = await sbAdmin('admins', {
    params: `?email=eq.${encodeURIComponent(cleanEmail)}&select=id,password_hash&limit=1`,
  });
  const admin = Array.isArray(admins) && admins.length ? admins[0] : null;
  // Message identique que l'email soit inconnu ou le mot de passe faux —
  // même choix qu'admin-login.js : ne jamais révéler quels comptes existent.
  const GENERIC = { error: 'Email ou mot de passe incorrect', status: 401 };
  if (!admin || !verifyPasswordHash(password, admin.password_hash)) return GENERIC;

  const links = await sbAdmin('admin_club_links', {
    params: `?admin_id=eq.${encodeURIComponent(admin.id)}&select=club_id`,
  });
  const clubIds = (Array.isArray(links) ? links : []).map(l => l.club_id).filter(Boolean);
  if (!clubIds.length) return GENERIC;

  const clubs = await sbAdmin('clubs', {
    params: `?id=in.(${clubIds.map(encodeURIComponent).join(',')})&select=id,name,status,admin_email,stripe_customer_id`,
  });
  const list = Array.isArray(clubs) ? clubs : [];
  // On vise en priorité un club suspendu : c'est le motif d'existence de ce
  // chemin. À défaut, le premier club du compte (un admin qui arrive ici
  // avec une session expirée plutôt qu'un club suspendu).
  const club = list.find(c => c.status === 'suspended') || list[0];
  if (!club) return GENERIC;
  return { club, email: club.admin_email || cleanEmail };
}

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!stripeConfigured()) {
    return res.status(503).json({ error: 'Le paiement en ligne n\'est pas encore activé — écris-nous pour souscrire' });
  }

  const { plan } = req.body || {};
  const priceId = priceIdForPlan(plan);
  if (!priceId) {
    return res.status(400).json({ error: 'Palier indisponible', available: purchasablePlans() });
  }

  try {
    const target = await resolveTarget(req);
    if (target.error) return res.status(target.status).json({ error: target.error });
    const { club, email } = target;

    const origin = publicOrigin(req);
    const session = await stripeRequest('/checkout/sessions', {
      body: {
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        // Réutilise le client Stripe déjà créé pour ce club si on en connaît
        // un : évite de créer un doublon à chaque changement de palier, et
        // conserve l'historique de facturation au même endroit.
        ...(club.stripe_customer_id
          ? { customer: club.stripe_customer_id }
          : { customer_email: email || undefined }),
        // club_id est LA donnée dont le webhook a besoin pour savoir quelle
        // ligne mettre à jour. Posée à la fois sur la session et sur
        // l'abonnement : les événements customer.subscription.* ne portent
        // pas les métadonnées de la session.
        metadata: { club_id: club.id, plan },
        subscription_data: { metadata: { club_id: club.id, plan } },
        client_reference_id: club.id,
        allow_promotion_codes: true,
        success_url: `${origin}/?billing=success`,
        cancel_url: `${origin}/?billing=cancelled`,
      },
    });

    return res.status(200).json({ success: true, url: session.url });
  } catch (e) {
    console.error('billing-checkout:', e.message);
    return res.status(500).json({ error: 'Impossible d\'ouvrir le paiement, réessaie dans un instant' });
  }
}
