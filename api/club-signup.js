// POST /api/club-signup  { name, city, email, password }
//                    ou   { name, city }  + header Authorization: Bearer <token admin>
//
// Point d'entrée UNIQUE pour créer une ligne `clubs` — le navigateur n'a
// jamais accès à la clé service_role ni à la clé anon pour écrire
// directement dans Supabase.
//
// Chantier multitenant "multi-club-admin" : deux cas désormais gérés par la
// même route (register.html décide lequel envoyer selon qu'une session
// admin valide existe déjà en localStorage) :
//
//  - PAS de session active (comportement d'origine, étape F) : inscription
//    complète {name, city, email, password} → crée une ligne `admins`
//    (nouvelle table, découplée d'un club précis) + une ligne `clubs` + le
//    lien `admin_club_links` entre les deux. Émet un token auto-connecté.
//
//  - Session admin déjà active (Authorization: Bearer <token valide>) : un
//    admin existant AJOUTE un nouveau club à son compte. Pas besoin de
//    redemander email/mot de passe (déjà authentifié) — {name, city}
//    suffisent. Crée le club + le lien vers auth.admin_id, SANS créer de
//    nouvelle ligne `admins`. Émet un nouveau token avec ce club ajouté à
//    accessible_clubs et active_club_id pointant dessus (atterrissage direct
//    dans le nouveau club), en conservant la même durée de session
//    (remember-me, auth.remember) que le token d'origine.
//
// Dans les deux cas : génère un slug (dérivé du nom, retry sur collision) et
// un portal_code (aléatoire, retry sur collision), insère `clubs`
// (status='trial', essai 30 jours — l'application/expiration du trial est
// hors scope ici, volontairement) puis une salle par défaut ("Salle
// principale", même pattern que resolveDefaultRoomId() dans
// admin-write.js). Pas de grille pré-remplie : chaque club configure la
// sienne dans Réglages (schedule_templates).
//
// clubs.admin_email : ce chantier déplace l'IDENTITÉ DE CONNEXION vers la
// table `admins` (colonne déjà dépréciée pour l'auth, jamais relue par
// admin-login.js/switch-club.js). La colonne clubs.admin_email continue
// toutefois d'être renseignée ici — elle sert désormais uniquement de
// contact/Reply-To pour les emails du club (api/email.js,
// api/cron-dispo-reminders.js la lisent encore telle quelle) : ne plus la
// remplir casserait silencieusement le Reply-To pour tout nouveau club. Pour
// le chemin "ajouter un club à un compte connecté" (pas d'email dans le
// payload), on réutilise l'email du compte admin déjà authentifié. Voir la
// migration SQL (stagely-multi-club-admin-v3.sql) : la contrainte UNIQUE sur
// clubs.admin_email est retirée (un même admin peut désormais posséder
// plusieurs clubs, donc réutiliser le même email plusieurs fois), et
// admin_pwd_hash devient nullable (plus jamais écrit pour un nouveau club —
// seul admins.password_hash fait foi pour l'auth).

import crypto from 'crypto';
import {
  applyCors,
  sbAdmin,
  sha256Hex,
  issueAdminToken,
  verifyAdminToken,
  isNonEmptyString,
  isValidEmail,
  slugify,
  newId,
  computePlanAccess,
} from './_lib.js';

const TRIAL_DAYS = 30;
// Alphabet sans caractères ambigus (pas de 0/O, 1/I) — cohérent avec le
// format du code portail existant (ex. BCCD25 pour le BCC).
const PORTAL_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const PORTAL_CODE_LEN = 6;
const MAX_SLUG_ATTEMPTS = 25;
const MAX_CODE_ATTEMPTS = 15;

function generatePortalCode() {
  let out = '';
  for (let i = 0; i < PORTAL_CODE_LEN; i++) {
    out += PORTAL_CODE_CHARS[crypto.randomInt(PORTAL_CODE_CHARS.length)];
  }
  return out;
}

async function slugExists(slug) {
  const rows = await sbAdmin('clubs', { params: `?slug=eq.${encodeURIComponent(slug)}&select=id&limit=1` });
  return Array.isArray(rows) && rows.length > 0;
}

async function portalCodeExists(code) {
  const rows = await sbAdmin('clubs', { params: `?portal_code=eq.${encodeURIComponent(code)}&select=id&limit=1` });
  return Array.isArray(rows) && rows.length > 0;
}

async function resolveUniqueSlug(name) {
  const base = slugify(name);
  for (let i = 0; i < MAX_SLUG_ATTEMPTS; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    if (!(await slugExists(candidate))) return candidate;
  }
  // Repli extrême (25 collisions d'affilée est déjà hautement improbable) :
  // suffixe aléatoire pour ne jamais bloquer une inscription légitime.
  return `${base}-${crypto.randomInt(1000, 9999)}`;
}

async function resolveUniquePortalCode() {
  for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
    const candidate = generatePortalCode();
    if (!(await portalCodeExists(candidate))) return candidate;
  }
  throw new Error('portal_code: espace épuisé après plusieurs tentatives');
}

function cleanNameCity(body) {
  const { name, city } = body || {};
  if (!isNonEmptyString(name, 120)) return null;
  return {
    name: name.trim().slice(0, 120),
    city: typeof city === 'string' && city.trim() ? city.trim().slice(0, 120) : null,
  };
}

// Crée la ligne `clubs` + sa salle par défaut. Ne crée JAMAIS de ligne
// `admins` ni `admin_club_links` — ça reste à la charge de l'appelant selon
// le cas (nouvelle inscription vs ajout à un compte existant), pour que
// cette fonction reste commune aux deux chemins.
//
// contactEmail/contactPwdHash : voir la note en tête de fichier sur
// clubs.admin_email/admin_pwd_hash (dépréciées pour l'auth, admin_email
// encore utile comme Reply-To). contactPwdHash est optionnel (absent côté
// "ajouter un club à un compte connecté", où il n'y a pas de mot de passe à
// écrire — la colonne est nullable depuis la migration de ce chantier).
async function createClubAndRoom({ name, city, contactEmail, contactPwdHash }) {
  const slug = await resolveUniqueSlug(name);
  const portalCode = await resolveUniquePortalCode();
  const clubId = newId();
  const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const clubRow = {
    id: clubId,
    slug,
    portal_code: portalCode,
    name,
    city,
    admin_email: contactEmail || null,
    admin_pwd_hash: contactPwdHash || null,
    status: 'trial',
    trial_ends_at: trialEndsAt,
    // Palier par défaut d'un nouveau club (chantier gating plan, 2026-08).
    // Sans effet pendant l'essai (accès complet quel que soit `plan`, voir
    // computePlanAccess() dans _lib.js) — ne compte qu'à partir du jour où le
    // club passe status='active'.
    plan: 'essentiel',
  };
  try {
    await sbAdmin('clubs', { method: 'POST', body: [clubRow] });
  } catch (e) {
    // Repli si la colonne `plan` n'existe pas encore sur cet environnement
    // (migration pas encore appliquée) — ne doit jamais faire échouer une
    // inscription pour un champ non-critique (computePlanAccess() retombe de
    // toute façon sur 'essentiel' quand la colonne est absente en lecture).
    delete clubRow.plan;
    await sbAdmin('clubs', { method: 'POST', body: [clubRow] });
  }

  // Salle par défaut — non bloquant si ça échoue : resolveDefaultRoomId()
  // (api/admin-write.js) recrée une salle par défaut à la volée au premier
  // ajout de créneau si celle-ci manque, donc une erreur ici ne doit pas
  // faire échouer toute l'inscription (le club a déjà été créé).
  try {
    await sbAdmin('rooms', {
      method: 'POST',
      body: [{ id: newId(), club_id: clubId, name: 'Salle principale', active: true }],
    });
  } catch (e) {
    // volontairement silencieux — voir commentaire ci-dessus
  }

  return { clubId, slug, portalCode };
}

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.ADMIN_TOKEN_SECRET) {
    return res.status(500).json({ error: 'Configuration serveur incomplète (variable d\'environnement manquante)' });
  }

  const auth = verifyAdminToken(req);

  // ── Cas B : admin déjà connecté → ajoute un club à son compte existant ──
  if (auth) {
    const nc = cleanNameCity(req.body);
    if (!nc) {
      return res.status(400).json({ error: 'Le nom du club est requis' });
    }
    try {
      // Email de contact du club = celui du compte admin déjà authentifié
      // (voir note en tête de fichier — sert au Reply-To, pas à l'auth).
      // Non bloquant si la lecture échoue : la création du club ne doit
      // jamais dépendre de ce champ purement informatif.
      let contactEmail = null;
      try {
        const rows = await sbAdmin('admins', {
          params: `?id=eq.${encodeURIComponent(auth.admin_id)}&select=email&limit=1`,
        });
        contactEmail = Array.isArray(rows) && rows.length ? rows[0].email : null;
      } catch (e) { /* non bloquant */ }

      const { clubId, slug, portalCode } = await createClubAndRoom({ ...nc, contactEmail });
      try {
        await sbAdmin('admin_club_links', { method: 'POST', body: [{ admin_id: auth.admin_id, club_id: clubId }] });
      } catch (e) {
        return res.status(500).json({ error: 'Erreur serveur, réessaie plus tard' });
      }
      const accessibleClubs = [...auth.accessible_clubs, { id: clubId, name: nc.name }];
      const { token, exp } = issueAdminToken(auth.admin_id, accessibleClubs, clubId, auth.remember);
      // Club tout juste créé : status='trial' + plan='essentiel' toujours —
      // computePlanAccess() en déduit un accès complet (essai), cf. _lib.js.
      const planAccess = computePlanAccess({ status: 'trial', plan: 'essentiel' });
      return res.status(201).json({
        success: true,
        token,
        expiresAt: exp,
        club: {
          id: clubId, slug, name: nc.name, city: nc.city, portal_code: portalCode, dispo_deadline_day: 12,
          plan: planAccess.plan, status: planAccess.status, pro_features: planAccess.proFeatures,
        },
        accessible_clubs: accessibleClubs,
      });
    } catch (e) {
      return res.status(500).json({ error: 'Erreur serveur, réessaie plus tard' });
    }
  }

  // ── Cas A : pas de session → inscription complète (nouvel admin) ──
  const { email, password } = req.body || {};
  const nc = cleanNameCity(req.body);

  if (!nc) {
    return res.status(400).json({ error: 'Le nom du club est requis' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Adresse email invalide' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Le mot de passe doit faire au moins 6 caractères' });
  }

  const cleanEmail = email.trim().toLowerCase();

  try {
    const existing = await sbAdmin('admins', {
      params: `?email=eq.${encodeURIComponent(cleanEmail)}&select=id&limit=1`,
    });
    if (Array.isArray(existing) && existing.length) {
      return res.status(409).json({ error: 'Cette adresse a déjà un club associé' });
    }

    const adminId = newId();
    const pwdHash = sha256Hex(password);
    const adminRow = { id: adminId, email: cleanEmail, password_hash: pwdHash };
    try {
      await sbAdmin('admins', { method: 'POST', body: [adminRow] });
    } catch (e) {
      // Une contrainte UNIQUE (email) a pu être violée par une course avec
      // une autre inscription simultanée malgré la vérification ci-dessus —
      // on ne laisse jamais fuiter le texte SQL brut au client, jamais de
      // 500 générique non plus.
      const msg = String((e && e.message) || e);
      if (msg.includes('email')) {
        return res.status(409).json({ error: 'Cette adresse a déjà un club associé' });
      }
      return res.status(409).json({ error: 'Un conflit est survenu, réessaie dans quelques secondes' });
    }

    let clubId, slug, portalCode;
    try {
      ({ clubId, slug, portalCode } = await createClubAndRoom({ ...nc, contactEmail: cleanEmail, contactPwdHash: pwdHash }));
    } catch (e) {
      // Collision slug/portal_code avec une inscription simultanée (course),
      // malgré la résolution "unique" faite juste avant. La ligne `admins`
      // créée ci-dessus reste orpheline dans ce cas rare (pas de club lié) —
      // acceptable : l'admin peut retenter l'inscription, ou (plus tard)
      // ça peut faire l'objet d'un nettoyage périodique si ça s'avère
      // fréquent en pratique, ce qui n'a jamais été observé jusqu'ici avec
      // le même pattern de retry sur clubs seul (avant ce chantier).
      return res.status(409).json({ error: 'Un conflit est survenu, réessaie dans quelques secondes' });
    }

    try {
      await sbAdmin('admin_club_links', { method: 'POST', body: [{ admin_id: adminId, club_id: clubId }] });
    } catch (e) {
      return res.status(500).json({ error: 'Erreur serveur, réessaie plus tard' });
    }

    const accessibleClubs = [{ id: clubId, name: nc.name }];
    const { token, exp } = issueAdminToken(adminId, accessibleClubs, clubId);
    // Club tout juste créé : status='trial' + plan='essentiel' toujours —
    // computePlanAccess() en déduit un accès complet (essai), cf. _lib.js.
    const planAccess = computePlanAccess({ status: 'trial', plan: 'essentiel' });
    return res.status(201).json({
      success: true,
      token,
      expiresAt: exp,
      // city + dispo_deadline_day (repli 12 — la valeur métier par défaut,
      // cohérente avec la colonne clubs.dispo_deadline_day DEFAULT 12, pas
      // encore configurable à l'inscription) + plan/status/pro_features
      // ajoutés pour que register.html puisse stocker la même forme de
      // `club` que admin-login.js (gating de palier dès la 1ère session).
      club: {
        id: clubId, slug, name: nc.name, city: nc.city, portal_code: portalCode, dispo_deadline_day: 12,
        plan: planAccess.plan, status: planAccess.status, pro_features: planAccess.proFeatures,
      },
      accessible_clubs: accessibleClubs,
    });
  } catch (e) {
    return res.status(500).json({ error: 'Erreur serveur, réessaie plus tard' });
  }
}
