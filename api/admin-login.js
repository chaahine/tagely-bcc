// POST /api/admin-login  { email, password }
// Vérifie l'email + le mot de passe admin côté serveur (hash SHA-256 comparé
// à clubs.admin_pwd_hash, jamais en clair ni en dur dans le code client) et
// retourne un token signé (HMAC-SHA256, 12h) à utiliser en header
// Authorization: Bearer <token> sur les routes d'écriture admin.
//
// Chantier multitenant, étape F : le club n'est plus résolu en dur sur
// slug='bcc' (repli temporaire posé à l'étape C) — chaque club a son propre
// admin_email unique en base, c'est lui qui identifie le club à la connexion,
// exactement comme l'inscription self-service (api/club-signup.js) l'a créé.
//
// Sécurité : la réponse est volontairement identique (même statut HTTP, même
// message générique) que l'email soit inconnu OU que le mot de passe soit
// faux — ne jamais laisser un attaquant déduire qu'un email existe. Pour ne
// pas non plus laisser fuiter cette info par le TEMPS de réponse, un hash
// bidon est comparé (avec la même fonction constant-time) même quand aucun
// club ne correspond à l'email.

import { applyCors, sbAdmin, verifyPasswordHash, issueAdminToken } from './_lib.js';

const GENERIC_ERROR = 'Email ou mot de passe incorrect';
// Hash sha256 valide (64 caractères hex) mais qui ne correspond à aucun mot
// de passe réel — sert uniquement à occuper le même temps de calcul que la
// comparaison réelle quand l'email n'existe pas en base.
const DUMMY_HASH = '0'.repeat(64);

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.ADMIN_TOKEN_SECRET) {
    return res.status(500).json({ error: 'Configuration serveur incomplète (variable d\'environnement manquante)' });
  }

  const { email, password, rememberMe } = req.body || {};
  if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email et mot de passe requis' });
  }

  const emailFilter = `admin_email=eq.${encodeURIComponent(email.trim().toLowerCase())}`;

  try {
    // Correctif identité club (bug critique) : jusqu'ici cette réponse ne
    // renvoyait QUE le token — rien côté client ne chargeait jamais la
    // vraie ligne `clubs` (nom, ville, portal_code) du club connecté. Le
    // lien portail copié depuis Réglages restait alors codé en dur sur
    // 'BCCD25' (le code du BCC) pour TOUS les clubs, envoyant les dispos de
    // n'importe quel autre club dans les données du BCC. On renvoie donc
    // ces champs ici, dans la même requête, comme club-signup.js le fait
    // déjà pour l'inscription.
    //
    // dispo_deadline_day est sélectionné à part avec repli : cette colonne
    // vient d'un chantier Réglages séparé et peut ne pas encore exister sur
    // cet environnement tant que sa migration SQL n'a pas tourné — la
    // connexion admin ne doit JAMAIS dépendre de ce champ optionnel.
    let rows;
    try {
      rows = await sbAdmin('clubs', {
        params: `?${emailFilter}&select=id,status,admin_pwd_hash,name,city,portal_code,dispo_deadline_day`,
      });
    } catch (e) {
      rows = await sbAdmin('clubs', {
        params: `?${emailFilter}&select=id,status,admin_pwd_hash,name,city,portal_code`,
      });
    }
    const club = Array.isArray(rows) && rows.length ? rows[0] : null;

    // Toujours exécuter la comparaison (contre le hash réel si le club
    // existe, contre un hash bidon sinon) pour garder un temps de réponse
    // homogène entre "email inconnu" et "email connu, mauvais mot de passe".
    const passwordOk = verifyPasswordHash(password, club ? club.admin_pwd_hash : DUMMY_HASH);
    if (!club || !passwordOk) {
      return res.status(401).json({ error: GENERIC_ERROR });
    }
    if (club.status === 'suspended') {
      return res.status(403).json({ error: 'Ce club est suspendu' });
    }

    const { token, exp } = issueAdminToken(club.id, rememberMe === true);
    return res.status(200).json({
      success: true,
      token,
      expiresAt: exp,
      club: {
        id: club.id,
        name: club.name,
        city: club.city,
        portal_code: club.portal_code,
        dispo_deadline_day: Number.isFinite(club.dispo_deadline_day) ? club.dispo_deadline_day : 15,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
