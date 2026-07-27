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

// ── Repli mono-club (chantier multitenant, étape B) ──
// Tant que la table `clubs` n'a pas de vraies données (étape C — migration
// réelle — pas encore faite), un seul club existe : le Beer Comedy Club.
// Cet uuid fixe deviendra l'id réel de la ligne `clubs` (slug='bcc') créée à
// l'étape C — choisi à l'avance pour qu'aucune donnée déjà écrite avec ce
// club_id n'ait besoin d'être réécrite au moment de la bascule.
// TODO(étape C) : une fois `clubs` peuplée, ce repli disparaît des points
// d'entrée (admin-login.js, portal-write.js) qui liront alors la vraie table.
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

// ── Filtre de scoping club, avec repli legacy tant que le backfill (étape C)
// n'a pas eu lieu ──
// Les 5 tables existantes ont une colonne club_id NULLABLE (ajoutée à l'étape
// A) : toutes les lignes actuelles ont club_id = NULL puisque le backfill ne
// se fait qu'à l'étape C. Pour ne rien casser pour le BCC pendant cette
// fenêtre, le scope "BCC" doit aussi matcher club_id IS NULL — ces lignes
// NULL ne peuvent aujourd'hui appartenir qu'au BCC (seul club existant).
// Un vrai 2ᵉ club (club_id réel, jamais BCC_CLUB_ID) ne matche lui QUE ses
// propres lignes : aucune ambiguïté, aucune fuite cross-tenant possible via
// ce repli, qui ne s'applique qu'au cas particulier BCC_CLUB_ID.
// TODO(étape C) : une fois le backfill fait (plus aucune ligne club_id NULL),
// supprimer le cas particulier et ne garder que `club_id=eq.<id>` pour tous.
export function clubOrFilter(clubId) {
  const eid = encodeURIComponent(clubId);
  if (clubId === BCC_CLUB_ID) {
    return `or=(club_id.eq.${eid},club_id.is.null)`;
  }
  return `club_id=eq.${eid}`;
}

export function checkPassword(candidate) {
  const expected = (process.env.ADMIN_PWD_HASH || '').trim().toLowerCase();
  if (!expected || typeof candidate !== 'string' || !candidate) return false;
  const got = sha256Hex(candidate).toLowerCase();
  return timingSafeEqualStr(got, expected);
}

// ── Validateurs communs ──
export const SLOT_KEY_RE = /^\d{4}-\d{2}-\d{2}-\d{2}h\d{2}$/i;

export function isNonEmptyString(v, max = 300) {
  return typeof v === 'string' && v.trim().length > 0 && v.length <= max;
}

// Même algorithme que le client (portal.html / index.html) pour dériver un id
// stable à partir d'un email, afin que les enregistrements créés côté serveur
// restent compatibles avec les recherches déjà en place.
export function idFromEmail(email) {
  return String(email).toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 50);
}
