// POST /api/billing-portal   header: Authorization: Bearer <token admin>
//
// Ouvre le portail de facturation Stripe pour le club actif : moyen de
// paiement, factures, changement de palier, résiliation. Tout s'y passe chez
// Stripe — c'est ce qui permet de tenir l'engagement "résiliable à tout
// moment, sans nous écrire" des conditions générales sans construire nous-
// mêmes un écran de gestion d'abonnement.
//
// Les changements faits dans ce portail reviennent par webhook
// (customer.subscription.updated / deleted) : c'est là, et nulle part
// ailleurs, que clubs.plan et clubs.status sont réécrits.

import { applyCors, sbAdmin, verifyAdminToken } from './_lib.js';
import { stripeConfigured, stripeRequest, publicOrigin } from './_stripe.js';

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = verifyAdminToken(req);
  if (!auth) return res.status(401).json({ error: 'Non autorisé — reconnecte-toi en admin' });

  if (!stripeConfigured()) {
    return res.status(503).json({ error: 'Le paiement en ligne n\'est pas encore activé' });
  }

  try {
    const rows = await sbAdmin('clubs', {
      params: `?id=eq.${encodeURIComponent(auth.active_club_id)}&select=id,stripe_customer_id&limit=1`,
    });
    const club = Array.isArray(rows) && rows.length ? rows[0] : null;
    if (!club || !club.stripe_customer_id) {
      // Aucun client Stripe : ce club n'a jamais payé. Le portail de
      // facturation n'aurait rien à afficher — c'est vers Checkout qu'il
      // faut l'envoyer, ce que le client sait faire.
      return res.status(404).json({ error: 'Aucun abonnement à gérer pour ce club', needsCheckout: true });
    }

    const session = await stripeRequest('/billing_portal/sessions', {
      body: {
        customer: club.stripe_customer_id,
        return_url: `${publicOrigin(req)}/?billing=back`,
      },
    });
    return res.status(200).json({ success: true, url: session.url });
  } catch (e) {
    console.error('billing-portal:', e.message);
    return res.status(500).json({ error: 'Impossible d\'ouvrir la gestion de l\'abonnement' });
  }
}
