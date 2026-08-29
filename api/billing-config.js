// GET /api/billing-config
//
// Dit au client si le paiement en ligne est disponible et quels paliers sont
// réellement achetables. Sans ça, l'app afficherait un bouton "Passer au
// Pro" qui échoue en 503 tant que les clés Stripe ne sont pas renseignées —
// c'est précisément l'état du produit aujourd'hui.
//
// Aucune authentification : la réponse ne contient rien de sensible (pas de
// clé, pas de price id, juste des noms de paliers). Elle ne dit rien non
// plus d'un club en particulier.

import { applyCors } from './_lib.js';
import { stripeConfigured, purchasablePlans } from './_stripe.js';

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const enabled = stripeConfigured();
  return res.status(200).json({
    enabled,
    plans: enabled ? purchasablePlans() : [],
  });
}
