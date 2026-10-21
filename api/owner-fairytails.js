// POST /api/owner-fairytails   header: Authorization: Bearer <token admin>
//                              header: X-FT-Key: <mot de passe /ventes de Fairy Tails>
//
// Relais pour la page /projets.html : renvoie tel quel le JSON de
// https://fairytails.fr/api/admin-stats. Le navigateur ne peut pas l'appeler
// lui-même depuis stagely.fr (Fairy Tails n'envoie pas d'en-têtes CORS), d'où
// ce passage par le serveur.
//
// Rien n'est stocké ici : la clé Fairy Tails vient du navigateur à chaque
// appel et repart aussitôt vers fairytails.fr. Même garde que
// owner-signups.js — seul le fondateur du BCC peut s'en servir, pour que ce
// relais ne devienne jamais un moyen de tester des mots de passe Fairy Tails
// en masse depuis l'extérieur.

import { applyCors, verifyAdminToken } from './_lib.js';
import { isOwner } from './owner-signups.js';

export const config = { maxDuration: 60 };

const FT_STATS_URL = 'https://fairytails.fr/api/admin-stats';

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = verifyAdminToken(req);
  if (!auth) return res.status(401).json({ error: 'Non autorisé — reconnecte-toi en admin' });

  const key = req.headers['x-ft-key'];
  if (typeof key !== 'string' || !key) return res.status(400).json({ error: 'Mot de passe Fairy Tails manquant', code: 'ft_key' });

  try {
    if (!(await isOwner(auth.admin_id))) {
      return res.status(403).json({ error: 'Page réservée au propriétaire de Stagely' });
    }
    const r = await fetch(`${FT_STATS_URL}?secret=${encodeURIComponent(key)}`, { cache: 'no-store' });
    if (r.status === 401) return res.status(401).json({ error: 'Mot de passe Fairy Tails incorrect', code: 'ft_key' });
    if (!r.ok) return res.status(502).json({ error: `Fairy Tails a répondu ${r.status}` });
    return res.status(200).json(await r.json());
  } catch (e) {
    console.error('owner-fairytails:', e && e.message);
    return res.status(502).json({ error: 'Fairy Tails ne répond pas' });
  }
}
