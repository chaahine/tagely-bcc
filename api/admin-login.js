// POST /api/admin-login  { password }
// Vérifie le mot de passe admin côté serveur (hash SHA-256 comparé à
// process.env.ADMIN_PWD_HASH, jamais en clair ni en dur dans le code client)
// et retourne un token signé (HMAC-SHA256, 12h) à utiliser en header
// Authorization: Bearer <token> sur les routes d'écriture admin.

import { applyCors, checkPassword, issueAdminToken, BCC_CLUB_ID } from './_lib.js';

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.ADMIN_PWD_HASH || !process.env.ADMIN_TOKEN_SECRET) {
    return res.status(500).json({ error: 'Configuration serveur incomplète (variables d\'environnement manquantes)' });
  }

  const { password } = req.body || {};
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Mot de passe requis' });
  }

  if (!checkPassword(password)) {
    return res.status(401).json({ error: 'Mot de passe incorrect' });
  }

  try {
    // ── Repli mono-club (chantier multitenant, étape B) ──
    // Un seul club existe réellement aujourd'hui (le BCC) : la table `clubs`
    // créée à l'étape A n'a encore aucune ligne (le backfill/la migration
    // réelle est l'étape C, pas encore faite). On utilise donc un club_id
    // fixe (BCC_CLUB_ID, cf. api/_lib.js) plutôt que de lire
    // clubs.admin_pwd_hash, qui n'existe pas encore en vraies données. Le mot
    // de passe reste vérifié via ADMIN_PWD_HASH (env var), inchangé.
    // TODO(étape C) : une fois la ligne clubs (slug='bcc') créée et peuplée,
    // remplacer ce repli par une vraie résolution de club (slug ou email
    // admin envoyé par le formulaire de login) et lire clubs.admin_pwd_hash
    // au lieu de l'env var ADMIN_PWD_HASH.
    const { token, exp } = issueAdminToken(BCC_CLUB_ID);
    return res.status(200).json({ success: true, token, expiresAt: exp });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
