// POST /api/club-signup  { name, city, email, password }
// Inscription self-service d'un nouveau club (chantier multitenant, étape F).
// Point d'entrée UNIQUE pour créer une ligne `clubs` — le navigateur n'a
// jamais accès à la clé service_role ni à la clé anon pour écrire
// directement dans Supabase (contrairement à un brouillon antérieur,
// stagely-register.html, jamais branché en prod).
//
// Étapes : valide les champs → vérifie l'unicité de l'email → génère un slug
// (dérivé du nom, retry sur collision) et un portal_code (aléatoire, retry
// sur collision) → hash le mot de passe (même algo que admin-login.js) →
// insère `clubs` (status='trial', essai 30 jours — l'application/expiration
// du trial est hors scope ici, volontairement) → insère une salle par défaut
// ("Salle principale", même pattern que resolveDefaultRoomId() dans
// admin-write.js) → émet un token admin pour auto-connecter le nouveau club
// dans son dashboard, sans repasser par l'écran de login.
//
// Pas de grille pré-remplie : chaque club configure la sienne dans Réglages
// (schedule_templates, chantier étape D, déjà fonctionnel).

import crypto from 'crypto';
import {
  applyCors,
  sbAdmin,
  sha256Hex,
  issueAdminToken,
  isNonEmptyString,
  isValidEmail,
  slugify,
  newId,
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

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.ADMIN_TOKEN_SECRET) {
    return res.status(500).json({ error: 'Configuration serveur incomplète (variable d\'environnement manquante)' });
  }

  const { name, city, email, password } = req.body || {};

  if (!isNonEmptyString(name, 120)) {
    return res.status(400).json({ error: 'Le nom du club est requis' });
  }
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: 'Adresse email invalide' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Le mot de passe doit faire au moins 6 caractères' });
  }

  const cleanName = name.trim().slice(0, 120);
  const cleanCity = typeof city === 'string' && city.trim() ? city.trim().slice(0, 120) : null;
  const cleanEmail = email.trim().toLowerCase();

  try {
    const existing = await sbAdmin('clubs', {
      params: `?admin_email=eq.${encodeURIComponent(cleanEmail)}&select=id&limit=1`,
    });
    if (Array.isArray(existing) && existing.length) {
      return res.status(409).json({ error: 'Cette adresse a déjà un club associé' });
    }

    const slug = await resolveUniqueSlug(cleanName);
    const portalCode = await resolveUniquePortalCode();
    const clubId = newId();
    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString();

    const clubRow = {
      id: clubId,
      slug,
      portal_code: portalCode,
      name: cleanName,
      city: cleanCity,
      admin_email: cleanEmail,
      admin_pwd_hash: sha256Hex(password),
      status: 'trial',
      trial_ends_at: trialEndsAt,
    };

    try {
      await sbAdmin('clubs', { method: 'POST', body: [clubRow] });
    } catch (e) {
      // Une contrainte UNIQUE (email/slug/portal_code) a pu être violée par
      // une course avec une autre inscription simultanée malgré les
      // vérifications ci-dessus — on ne laisse jamais fuiter le texte SQL
      // brut au client, jamais de 500 générique non plus.
      const msg = String((e && e.message) || e);
      if (msg.includes('admin_email')) {
        return res.status(409).json({ error: 'Cette adresse a déjà un club associé' });
      }
      return res.status(409).json({ error: 'Un conflit est survenu, réessaie dans quelques secondes' });
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

    const { token, exp } = issueAdminToken(clubId);
    return res.status(201).json({
      success: true,
      token,
      expiresAt: exp,
      club: { id: clubId, slug, name: cleanName, portal_code: portalCode },
    });
  } catch (e) {
    return res.status(500).json({ error: 'Erreur serveur, réessaie plus tard' });
  }
}
