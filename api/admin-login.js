// POST /api/admin-login  { password }
// Vérifie le mot de passe admin côté serveur (hash SHA-256 comparé à
// process.env.ADMIN_PWD_HASH, jamais en clair ni en dur dans le code client)
// et retourne un token signé (HMAC-SHA256, 12h) à utiliser en header
// Authorization: Bearer <token> sur les routes d'écriture admin.

import { applyCors, checkPassword, issueAdminToken } from './_lib.js';

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
    const { token, exp } = issueAdminToken();
    return res.status(200).json({ success: true, token, expiresAt: exp });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
