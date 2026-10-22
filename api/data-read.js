// POST /api/data-read
//   admin  : header Authorization: Bearer <token admin>, body { table, query }
//   portail: body { code, table, query }  ou  { code, lookup: 'comedian', email, name }
//
// Proxy de LECTURE — fin de la policy RLS « lecture publique » (2026-10).
// Jusqu'ici, index.html et portal.html lisaient Supabase directement avec la
// clé anon (visible dans le code de la page) et filtraient club_id CÔTÉ
// CLIENT. Rien n'empêchait donc quiconque d'ouvrir la console et de lire les
// fiches (noms, emails, téléphones), plannings et dispos de TOUS les clubs.
// Constaté et prouvé le 15/10/2026 : 125 humoristes de 2 clubs lisibles sans
// aucune connexion. Toutes les lectures passent désormais par ici, avec la clé
// service_role, et le club vient TOUJOURS du serveur :
//  - admin  : auth.active_club_id du token vérifié ;
//  - portail: re-résolution du code d'accès (même règle que portal-write.js).
// Un club_id fourni par le client n'est jamais lu.
//
// La requête n'est PAS un passe-plat PostgREST : le client envoie une
// description structurée (filtres, tri, pagination) que ce fichier traduit
// lui-même, colonne par colonne, depuis des listes fermées. Un params brut
// permettrait `select=*,autre_table(*)` (lecture d'une table liée) ou un
// `or=(...)` — ici, select est toujours forcé et seuls les opérateurs
// eq/gt/gte/lt existent.
//
// Le portail n'a qu'un accès réduit (pas d'auth forte, seulement le code du
// club, partagé à tous ses humoristes) : jamais la liste des humoristes avec
// leurs coordonnées, et les dispos seulement filtrées par comedian_id.

import { applyCors, sbAdmin, verifyAdminToken, clubOrFilter, resolveClubIdByPortalCode, isNonEmptyString } from './_lib.js';

const PAGE_MAX = 1000; // plafond PostgREST par défaut, cf. loadDisposPaginated()

// Colonnes filtrables (toutes tables confondues) et tris autorisés par table.
const FILTER_COLUMNS = new Set(['id', 'comedian_id', 'slot_key', 'created_at', 'active', 'dispo']);
const OPS = new Set(['eq', 'gt', 'gte', 'lt']);

const ADMIN_TABLES = {
  comedians: ['name'],
  assignments: ['id'],
  dispos: ['slot_key'],
  dispo_status: [],
  chat_messages: ['created_at', 'created_at.desc'],
  schedule_templates: ['weekday,time'],
  events: ['slot_key'],
  rooms: ['name'],
  planning_sends: ['month'],
};

// Portail : tables lisibles + filtre obligatoire éventuel.
const PORTAL_TABLES = {
  assignments: { order: ['id'], requires: null },
  schedule_templates: { order: ['weekday,time'], requires: null },
  dispos: { order: ['slot_key'], requires: 'comedian_id' },
};

function filterValue(v) {
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string' && v.length <= 200) return encodeURIComponent(v);
  return null;
}

// Traduit { filters: [{col, op, value}], order, limit, offset } en params
// PostgREST. Renvoie null si quoi que ce soit sort des listes fermées.
export function buildReadParams(query, allowedOrders, clubId) {
  const q = query && typeof query === 'object' ? query : {};
  const parts = ['select=*'];
  const filters = Array.isArray(q.filters) ? q.filters : [];
  if (filters.length > 6) return null;
  for (const f of filters) {
    if (!f || !FILTER_COLUMNS.has(f.col) || !OPS.has(f.op)) return null;
    const v = filterValue(f.value);
    if (v === null) return null;
    parts.push(`${f.col}=${f.op}.${v}`);
  }
  if (q.order !== undefined) {
    if (!allowedOrders.includes(q.order)) return null;
    parts.push(`order=${q.order}`);
  }
  if (q.limit !== undefined) {
    if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > PAGE_MAX) return null;
    parts.push(`limit=${q.limit}`);
  }
  if (q.offset !== undefined) {
    if (!Number.isInteger(q.offset) || q.offset < 0) return null;
    parts.push(`offset=${q.offset}`);
  }
  parts.push(clubOrFilter(clubId)); // toujours en dernier, jamais omis
  return '?' + parts.join('&');
}

// Mois courant à Paris, "YYYY-MM" (le serveur tourne en UTC).
export function parisMonth(now = new Date()) {
  return new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit' }).format(now);
}

// Portail : un humoriste ne voit ses dates d'un mois qu'une fois le planning
// de ce mois envoyé (« Envoyer le planning », table planning_sends). Les mois
// passés restent toujours visibles. Filtre ajouté à la requête PostgREST
// elle-même (et non après coup) pour que la pagination par offset de
// sbAll() reste juste. Renvoie '' si la table n'existe pas encore : on
// retombe sur l'ancien comportement plutôt que de vider le portail.
export function publishedSlotFilter(months, current) {
  const parts = [`slot_key.lt.${current}`];
  for (const m of months) if (/^\d{4}-\d{2}$/.test(m) && m >= current) parts.push(`slot_key.like.${m}-*`);
  return `or=(${parts.join(',')})`;
}

async function portalAssignmentFilter(clubId) {
  try {
    const rows = await sbAdmin('planning_sends', { params: `?${clubOrFilter(clubId)}&select=month` });
    const months = [...new Set((Array.isArray(rows) ? rows : []).map(r => r.month))];
    return publishedSlotFilter(months, parisMonth());
  } catch (e) {
    console.warn('planning_sends illisible, portail non filtré :', e && e.message);
    return '';
  }
}

const normalizeName = (s) => String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

// Connexion portail : retrouve UN humoriste du club, par email d'abord, puis
// par nom (fiches créées par l'admin sans email). Remplace le téléchargement
// de toute la liste du club dans le navigateur. Par nom, on ne renvoie ni
// email ni téléphone : connaître le nom de quelqu'un ne doit pas suffire à
// obtenir ses coordonnées.
async function lookupComedian(clubId, email, name) {
  if (isNonEmptyString(email, 200)) {
    const rows = await sbAdmin('comedians', {
      params: `?email=eq.${encodeURIComponent(email.trim().toLowerCase())}&${clubOrFilter(clubId)}&select=*&limit=1`,
    });
    if (Array.isArray(rows) && rows.length) return rows[0];
  }
  if (isNonEmptyString(name, 200)) {
    const target = normalizeName(name);
    const rows = await sbAdmin('comedians', { params: `?${clubOrFilter(clubId)}&select=id,name,prio,gender,duration,active` });
    const hit = Array.isArray(rows) ? rows.find(r => normalizeName(r.name) === target) : null;
    if (hit) return hit;
  }
  return null;
}

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  try {
    const auth = verifyAdminToken(req);
    if (auth) {
      const orders = ADMIN_TABLES[body.table];
      if (!orders) return res.status(403).json({ error: 'Table non autorisée' });
      const params = buildReadParams(body.query, orders, auth.active_club_id);
      if (!params) return res.status(400).json({ error: 'Requête invalide' });
      const rows = await sbAdmin(body.table, { params });
      return res.status(200).json(Array.isArray(rows) ? rows : []);
    }

    if (!isNonEmptyString(body.code, 40)) return res.status(401).json({ error: 'Non authentifié' });
    const clubId = await resolveClubIdByPortalCode(body.code);
    if (!clubId) return res.status(403).json({ error: 'Code d\'accès invalide' });

    if (body.lookup === 'comedian') {
      const comedian = await lookupComedian(clubId, body.email, body.name);
      return res.status(200).json({ comedian });
    }

    const spec = PORTAL_TABLES[body.table];
    if (!spec) return res.status(403).json({ error: 'Table non autorisée' });
    if (spec.requires) {
      const filters = Array.isArray(body.query?.filters) ? body.query.filters : [];
      if (!filters.some(f => f && f.col === spec.requires && f.op === 'eq' && isNonEmptyString(f.value, 200))) {
        return res.status(400).json({ error: `${spec.requires} requis` });
      }
    }
    let params = buildReadParams(body.query, spec.order, clubId);
    if (!params) return res.status(400).json({ error: 'Requête invalide' });
    if (body.table === 'assignments') {
      const extra = await portalAssignmentFilter(clubId);
      if (extra) params += `&${extra}`;
    }
    const rows = await sbAdmin(body.table, { params });
    return res.status(200).json(Array.isArray(rows) ? rows : []);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
