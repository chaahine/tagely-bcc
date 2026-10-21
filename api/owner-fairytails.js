// POST /api/owner-fairytails   header: Authorization: Bearer <token admin>
//
// Relais pour la page /projets.html : renvoie tel quel le JSON de
// https://fairytails.fr/api/admin-stats. Le navigateur ne peut pas l'appeler
// lui-même depuis stagely.fr (Fairy Tails n'envoie pas d'en-têtes CORS), d'où
// ce passage par le serveur.
//
// Le mot de passe /ventes de Fairy Tails vit dans la variable
// d'environnement FAIRYTAILS_ADMIN_SECRET de ce projet : la page ne le
// demande plus. C'est donc la garde d'owner-signups.js — seul le fondateur
// du BCC — qui protège ces chiffres ; une session Stagely ordinaire n'y
// donne pas accès.

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

  try {
    if (!(await isOwner(auth.admin_id))) {
      return res.status(403).json({ error: 'Page réservée au propriétaire de Stagely' });
    }
    const key = process.env.FAIRYTAILS_ADMIN_SECRET;
    if (!key) return res.status(500).json({ error: 'FAIRYTAILS_ADMIN_SECRET manquante côté serveur' });
    const r = await fetch(`${FT_STATS_URL}?secret=${encodeURIComponent(key)}`, { cache: 'no-store' });
    // Pas un 401 : la page le prendrait pour une session Stagely expirée.
    if (r.status === 401) return res.status(502).json({ error: 'FAIRYTAILS_ADMIN_SECRET ne correspond plus au mot de passe de Fairy Tails' });
    if (!r.ok) return res.status(502).json({ error: `Fairy Tails a répondu ${r.status}` });
    return res.status(200).json(await r.json());
  } catch (e) {
    console.error('owner-fairytails:', e && e.message);
    return res.status(502).json({ error: 'Fairy Tails ne répond pas' });
  }
}
