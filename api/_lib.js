// ── Utilitaires partagés par les routes API Stagely ──
// Préfixe "_" : Vercel ne traite pas ce fichier comme une route/fonction.
//
// Contient : l'appel Supabase authentifié en service_role (jamais exposé au
// navigateur), la signature/vérification du token admin (HMAC-SHA256, sans
// dépendance JWT externe), et de petits validateurs réutilisés par les routes
// d'écriture pour assainir les payloads reçus du client.

import crypto from 'crypto';

const SUPABASE_URL = 'https://dvdwfxytdsvwjtirxncz.supabase.co';

// ── Appel Supabase avec la clé service_role (bypass RLS, jamais exposée au client) ──
export async function sbAdmin(table, { method = 'GET', params = '', body } = {}) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!key) throw new Error('SUPABASE_SERVICE_KEY manquante côté serveur');
  const headers = {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
  if (method === 'POST') headers['Prefer'] = 'resolution=merge-duplicates,return=minimal';
  if (method === 'DELETE') headers['Prefer'] = 'return=minimal';
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${params}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase ${method} ${table} → ${res.status} ${text}`);
  }
  if (method === 'GET') return res.json();
  return true;
}

export function applyCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export function sha256Hex(str) {
  return crypto.createHash('sha256').update(String(str), 'utf8').digest('hex');
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ── Token admin signé — HMAC-SHA256(ADMIN_TOKEN_SECRET), expiration 12h ──
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

// ── Club BCC (chantier multitenant, étape C) ──
// Depuis l'étape C, la table `clubs` a une vraie ligne (slug='bcc') dont
// l'id EST cette constante — choisie à l'avance à l'étape B pour qu'aucune
// donnée déjà écrite avec ce club_id n'ait eu besoin d'être réécrite au
// moment du backfill. admin-login.js et portal-write.js ne s'appuient plus
// sur cette constante pour émettre un token/résoudre un code — ils lisent la
// table `clubs` en base — mais elle reste utilisée par verifyAdminToken()
// (repli pour un très vieux token émis avant l'étape B, sans club_id dans son
// payload) et par les tests.
export const BCC_CLUB_ID = '00000000-0000-4000-a000-0000000000bc';

export function issueAdminToken(clubId) {
  const secret = process.env.ADMIN_TOKEN_SECRET;
  if (!secret) throw new Error('ADMIN_TOKEN_SECRET manquante côté serveur');
  const exp = Date.now() + TOKEN_TTL_MS;
  const payload = Buffer.from(JSON.stringify({ role: 'admin', club_id: clubId, exp })).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return { token: `${payload}.${sig}`, exp };
}

// Retourne les claims décodées { role, club_id, exp } si le token est valide
// (signature correcte, non expiré), sinon null. Comme null est falsy, le
// pattern d'appel existant `if (!verifyAdminToken(req))` continue de
// fonctionner tel quel pour les appelants qui n'ont besoin que du booléen ;
// ceux qui ont besoin du club_id (routes d'écriture scopées) lisent
// directement la propriété sur l'objet retourné.
export function verifyAdminToken(req) {
  const secret = process.env.ADMIN_TOKEN_SECRET;
  if (!secret) return null;
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (!timingSafeEqualStr(sig, expectedSig)) return null;
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!data || data.role !== 'admin' || typeof data.exp !== 'number') return null;
  if (Date.now() > data.exp) return null;
  // Repli : un token émis juste avant ce déploiement (TTL max 12h) n'a pas
  // encore de club_id dans son payload — on le traite comme le club BCC.
  const club_id = typeof data.club_id === 'string' && data.club_id ? data.club_id : BCC_CLUB_ID;
  return { role: data.role, club_id, exp: data.exp };
}

// ── Filtre de scoping club ──
// Depuis l'étape C, le backfill a donné un club_id non-NULL à toutes les
// lignes existantes (voir stagely-migrate-bcc.sql) : il n'y a plus de ligne
// club_id IS NULL en base, donc plus aucune ambiguïté à couvrir. Le repli
// legacy `or=(club_id.eq.<id>,club_id.is.null)` qui existait le temps de la
// fenêtre entre l'étape B (scoping serveur) et l'étape C (backfill réel) a
// été retiré : chaque club, BCC compris, ne matche plus que ses propres
// lignes.
export function clubOrFilter(clubId) {
  return `club_id=eq.${encodeURIComponent(clubId)}`;
}

// Compare un mot de passe candidat à un hash sha256 hex attendu (constant-time).
// Prend le hash en paramètre plutôt que de le lire depuis une variable
// d'environnement globale : depuis l'étape C, chaque club a son propre
// admin_pwd_hash en base (colonne clubs.admin_pwd_hash), ce qui n'a plus de
// sens dans un monde multi-club où plusieurs clubs coexistent (l'ancien
// chemin par variable d'environnement ADMIN_PWD_HASH, à un seul mot de passe
// pour toute l'app, a été retiré à l'étape F).
export function verifyPasswordHash(candidate, expectedHash) {
  const expected = (expectedHash || '').trim().toLowerCase();
  if (!expected || typeof candidate !== 'string' || !candidate) return false;
  const got = sha256Hex(candidate).toLowerCase();
  return timingSafeEqualStr(got, expected);
}

// ── Validateurs communs ──
export const SLOT_KEY_RE = /^\d{4}-\d{2}-\d{2}-\d{2}h\d{2}$/i;

export function isNonEmptyString(v, max = 300) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(v) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= 200 && EMAIL_RE.test(v.trim());
}

// Dérive un identifiant URL-safe (slug) à partir d'un nom libre — utilisé à
// l'inscription self-service (étape F) pour générer clubs.slug à partir du
// nom du club. Ne garantit PAS l'unicité : l'appelant (api/club-signup.js)
// vérifie/retente en cas de collision.
export function slugify(str, maxLen = 40) {
  const base = String(str || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // retire les accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLen)
    .replace(/-+$/g, '');
  return base || 'club';
}

// Même algorithme que le client (portal.html / index.html) pour dériver un id
// stable à partir d'un email, afin que les enregistrements créés côté serveur
// restent compatibles avec les recherches déjà en place.
export function idFromEmail(email) {
  return String(email).toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 50);
}

// Génère un id aléatoire pour les lignes créées côté serveur (rooms,
// schedule_templates, ...) qui n'ont pas d'id "naturel" comme les comédiens
// (idFromEmail). crypto.randomUUID() est disponible nativement sur le
// runtime Node des fonctions Vercel, pas de dépendance supplémentaire.
export function newId() {
  return crypto.randomUUID();
}

// ── Résolution code portail → club (chantier multitenant, étape C/D) ──
// Partagée par api/portal-write.js (écritures) et api/portal-resolve.js
// (lecture seule, étape D) : un seul endroit qui décide ce qu'est un code
// d'accès valide, pour ne jamais laisser diverger les deux routes. Le
// portail n'a pas de token admin : chaque appel envoie le "code" d'accès
// (le même que celui affiché/QR côté admin — CLUB_CODE dans index.html,
// aujourd'hui 'BCCD25'). Le serveur ne fait JAMAIS confiance à un club_id
// envoyé par le client : il re-résout le code à chaque appel, par une
// lecture de clubs.portal_code. Un code inconnu, ou un club suspendu, est
// rejeté — pas de repli permissif.
export async function resolveClubIdByPortalCode(code) {
  if (typeof code !== 'string' || !code.trim()) return null;
  const rows = await sbAdmin('clubs', {
    params: `?portal_code=eq.${encodeURIComponent(code.trim().toUpperCase())}&select=id,status`,
  });
  const club = Array.isArray(rows) && rows.length ? rows[0] : null;
  if (!club || club.status === 'suspended') return null;
  return club.id;
}
