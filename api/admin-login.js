// POST /api/admin-login  { password }
// Vérifie le mot de passe admin côté serveur (hash SHA-256 comparé à
// clubs.admin_pwd_hash, jamais en clair ni en dur dans le code client) et
// retourne un token signé (HMAC-SHA256, 12h) à utiliser en header
// Authorization: Bearer <token> sur les routes d'écriture admin.

import { applyCors, sbAdmin, verifyPasswordHash, issueAdminToken } from './_lib.js';

// ── Résolution du club à la connexion (chantier multitenant, étape C) ──
// Le formulaire de login (index.html) n'a pas encore de sélecteur de club —
// ce sera l'étape F (inscription self-service). Un seul club existe pour
// l'instant : on résout donc sur slug='bcc' en dur ici, mais le mot de passe
// est désormais vérifié contre la colonne clubs.admin_pwd_hash lue en base
// (peuplée par la migration de l'étape C), plus contre la variable
// d'environnement ADMIN_PWD_HASH.
// TODO(étape F) : remplacer 'bcc' par un slug/email envoyé par le formulaire.
const LOGIN_CLUB_SLUG = 'bcc';

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.ADMIN_TOKEN_SECRET) {
    return res.status(500).json({ error: 'Configuration serveur incomplète (variable d\'environnement manquante)' });
  }

  const { password } = req.body || {};
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Mot de passe requis' });
  }

  try {
    const rows = await sbAdmin('clubs', {
      params: `?slug=eq.${encodeURIComponent(LOGIN_CLUB_SLUG)}&select=id,status,admin_pwd_hash`,
    });
    const club = Array.isArray(rows) && rows.length ? rows[0] : null;
    if (!club) {
      // La table `clubs` n'a pas (encore) la ligne BCC — la migration de
      // l'étape C n'a pas été exécutée. Pas de repli silencieux vers l'env
      // var ici : un login qui échoue bruyamment est préférable à un login
      // qui semble marcher contre la mauvaise source de vérité.
      return res.status(500).json({ error: 'Club introuvable en base — migration étape C non exécutée' });
    }
    if (club.status === 'suspended') {
      return res.status(403).json({ error: 'Ce club est suspendu' });
    }
    if (!verifyPasswordHash(password, club.admin_pwd_hash)) {
      return res.status(401).json({ error: 'Mot de passe incorrect' });
    }

    const { token, exp } = issueAdminToken(club.id);
    return res.status(200).json({ success: true, token, expiresAt: exp });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
