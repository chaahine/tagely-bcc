// POST /api/admin-login  { email, password, rememberMe }
// Vérifie l'email + le mot de passe admin côté serveur (hash SHA-256 comparé
// à admins.password_hash, jamais en clair ni en dur dans le code client) et
// retourne un token signé (HMAC-SHA256, 12h — 30 jours si rememberMe) à
// utiliser en header Authorization: Bearer <token> sur les routes d'écriture
// admin.
//
// Chantier multitenant "multi-club-admin" : l'identité de connexion n'est
// plus une ligne `clubs` (1 email = 1 club, ancien modèle où clubs.admin_email
// était UNIQUE) mais une ligne `admins`, découplée d'un club précis. Un même
// admin peut posséder plusieurs clubs (table de liaison `admin_club_links`) —
// le token émis embarque la LISTE des clubs accessibles (accessible_clubs,
// forme légère {id,name} pour peupler le sélecteur côté client sans requête
// supplémentaire) et un active_club_id (le premier de la liste au login ;
// /api/switch-club permet ensuite de changer de club actif sans se
// reconnecter).
//
// La réponse renvoie AUSSI le détail complet du club ACTIF — { id, name,
// city, portal_code, dispo_deadline_day } — exactement comme avant ce
// chantier (correctif identité club, v210/v211) : c'est ce que
// applyClubInfo() (index.html) lit pour ne plus jamais afficher l'identité
// du BCC pour un autre club. Ne pas casser cette forme.
//
// Sécurité : la réponse est volontairement identique (même statut HTTP, même
// message générique) que l'email soit inconnu OU que le mot de passe soit
// faux — ne jamais laisser un attaquant déduire qu'un email existe. Pour ne
// pas non plus laisser fuiter cette info par le TEMPS de réponse, un hash
// bidon est comparé (avec la même fonction constant-time) même quand aucun
// admin ne correspond à l'email.

import { applyCors, sbAdmin, verifyPasswordHash, issueAdminToken, computePlanAccess, resolvePaymentMode } from './_lib.js';

const GENERIC_ERROR = 'Email ou mot de passe incorrect';
// Hash sha256 valide (64 caractères hex) mais qui ne correspond à aucun mot
// de passe réel — sert uniquement à occuper le même temps de calcul que la
// comparaison réelle quand l'email n'existe pas en base.
const DUMMY_HASH = '0'.repeat(64);

async function fetchAdminByEmail(email) {
  const rows = await sbAdmin('admins', {
    params: `?email=eq.${encodeURIComponent(email)}&select=id,password_hash`,
  });
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

// Résout les clubs accessibles à un admin via admin_club_links, en deux
// requêtes simples (pas d'embedding PostgREST, pour rester explicite et ne
// pas dépendre de la détection de la relation FK par le schema cache) — même
// approche que resolveClubIdByPortalCode() dans _lib.js.
//
// dispo_deadline_day/plan/trial_ends_at/payment_mode sont sélectionnés avec
// repli : ces colonnes viennent de chantiers séparés et peuvent ne pas toutes
// exister sur cet environnement tant que leur migration SQL n'a pas tourné —
// la connexion admin ne doit JAMAIS dépendre de ces champs optionnels (même
// garde qu'avant ce chantier). "plan" alimente le gating de palier (chapeau +
// cachet + dashboard financier + export comptable) — voir computePlanAccess()
// dans _lib.js ; si la colonne manque encore, le repli ci-dessous ne la
// sélectionne pas et computePlanAccess() retombe sur 'essentiel' par défaut
// (jamais un accès Pro accordé par erreur). "payment_mode" (chantier
// "cachet", 2026-08) suit le même repli — si absente, resolvePaymentMode()
// (_lib.js) retombe sur 'chapeau', le comportement historique.
async function fetchAccessibleClubs(adminId) {
  const links = await sbAdmin('admin_club_links', {
    params: `?admin_id=eq.${encodeURIComponent(adminId)}&select=club_id`,
  });
  const clubIds = Array.isArray(links) ? links.map((l) => l.club_id) : [];
  if (!clubIds.length) return [];
  const idsFilter = clubIds.map((id) => encodeURIComponent(id)).join(',');
  let rows;
  try {
    rows = await sbAdmin('clubs', {
      params: `?id=in.(${idsFilter})&select=id,status,name,city,portal_code,dispo_deadline_day,plan,trial_ends_at,payment_mode`,
    });
  } catch (e) {
    try {
      rows = await sbAdmin('clubs', {
        params: `?id=in.(${idsFilter})&select=id,status,name,city,portal_code,dispo_deadline_day,plan,trial_ends_at`,
      });
    } catch (e2) {
      rows = await sbAdmin('clubs', {
        params: `?id=in.(${idsFilter})&select=id,status,name,city,portal_code`,
      });
    }
  }
  return Array.isArray(rows) ? rows : [];
}

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

  try {
    const admin = await fetchAdminByEmail(email.trim().toLowerCase());

    // Toujours exécuter la comparaison (contre le hash réel si l'admin
    // existe, contre un hash bidon sinon) pour garder un temps de réponse
    // homogène entre "email inconnu" et "email connu, mauvais mot de passe".
    const passwordOk = verifyPasswordHash(password, admin ? admin.password_hash : DUMMY_HASH);
    if (!admin || !passwordOk) {
      return res.status(401).json({ error: GENERIC_ERROR });
    }

    const allClubs = await fetchAccessibleClubs(admin.id);
    if (!allClubs.length) {
      // Compte admin existant mais sans aucun club lié — ne devrait pas
      // arriver en usage normal (chaque inscription crée le lien), mais un
      // état incohérent ne doit jamais planter en 500 ni émettre un token
      // sans club actif (issueAdminToken l'exigerait de toute façon).
      return res.status(403).json({ error: 'Aucun club associé à ce compte' });
    }
    // Un club suspendu n'est jamais accessible, même avec le bon mot de
    // passe — même sémantique qu'avant ce chantier, appliquée ici par club
    // plutôt que globalement au compte (un admin multi-club peut avoir un
    // club actif et un club suspendu en parallèle).
    const activeClubs = allClubs.filter((c) => c.status !== 'suspended');
    if (!activeClubs.length) {
      return res.status(403).json({ error: 'Ce club est suspendu' });
    }

    const accessibleClubs = activeClubs.map((c) => ({ id: c.id, name: c.name }));
    const activeClub = activeClubs[0];
    const { token, exp } = issueAdminToken(admin.id, accessibleClubs, activeClub.id, rememberMe === true);
    // plan/status relus EN BASE à l'instant du login (jamais devinés/mis en
    // cache côté client) — c'est la seule source de vérité pour le gating de
    // palier (chapeau + dashboard financier). Voir computePlanAccess() /_lib.js.
    const planAccess = computePlanAccess(activeClub);
    return res.status(200).json({
      success: true,
      token,
      expiresAt: exp,
      club: {
        id: activeClub.id,
        name: activeClub.name,
        city: activeClub.city,
        portal_code: activeClub.portal_code,
        dispo_deadline_day: Number.isFinite(activeClub.dispo_deadline_day) ? activeClub.dispo_deadline_day : 12,
        plan: planAccess.plan,
        status: planAccess.status,
        pro_features: planAccess.proFeatures,
        trial_ends_at: activeClub.trial_ends_at || null,
        payment_mode: resolvePaymentMode(activeClub),
      },
      accessible_clubs: accessibleClubs,
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
