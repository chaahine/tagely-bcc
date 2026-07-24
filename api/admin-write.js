// POST /api/admin-write   header: Authorization: Bearer <token admin>
// body: { action, payload }
//
// Proxy d'écriture pour l'app admin (index.html). Remplace les appels directs
// du navigateur vers Supabase (clé anon) par des écritures serveur avec la clé
// service_role. Whitelist stricte des actions ci-dessous — tout le reste → 403.
//
// Actions :
//  - sync          : upsert comédiens / remplacement complet des assignments /
//                     upsert dispo_status / upsert dispos (reflète saveToSupabase()
//                     et saveHumoristeFiche() côté client — un seul point d'entrée
//                     pour toutes les sauvegardes "planning courant")
//  - deleteComedian: supprime un comédien + toutes ses lignes liées
//  - clearAll      : vide entièrement les 4 tables (reset total, très destructif)
//  - chatSend      : insère un message admin dans chat_messages (alerte urgence)

import { applyCors, sbAdmin, verifyAdminToken, isNonEmptyString, SLOT_KEY_RE } from './_lib.js';

const MAX_BULK = 5000; // garde-fou anti-abus sur les upserts en masse

function sanitizeComedian(row) {
  if (!row || typeof row !== 'object') return null;
  if (!isNonEmptyString(row.id, 100) || !isNonEmptyString(row.name, 200)) return null;
  return {
    id: String(row.id),
    name: String(row.name),
    prio: isNonEmptyString(row.prio, 20) ? row.prio : 'new',
    presence: Number.isFinite(row.presence) ? row.presence : 100,
    gender: row.gender === 'f' ? 'f' : 'm',
    duration: Number.isFinite(row.duration) ? row.duration : 10,
    phone: typeof row.phone === 'string' ? row.phone.slice(0, 40) : '',
    email: typeof row.email === 'string' ? row.email.slice(0, 200) : '',
    notes: typeof row.notes === 'string' ? row.notes.slice(0, 2000) : '',
    active: row.active !== false,
  };
}

function sanitizeAssignment(row) {
  if (!row || typeof row !== 'object') return null;
  if (!isNonEmptyString(row.comedian_id, 100) || !SLOT_KEY_RE.test(row.slot_key || '')) return null;
  return { comedian_id: String(row.comedian_id), slot_key: String(row.slot_key) };
}

function sanitizeDispoStatus(row) {
  if (!row || typeof row !== 'object') return null;
  if (!isNonEmptyString(row.comedian_id, 100)) return null;
  return {
    comedian_id: String(row.comedian_id),
    status: isNonEmptyString(row.status, 30) ? row.status : 'replied',
  };
}

function sanitizeDispo(row) {
  if (!row || typeof row !== 'object') return null;
  if (!isNonEmptyString(row.comedian_id, 100) || !SLOT_KEY_RE.test(row.slot_key || '')) return null;
  return {
    comedian_id: String(row.comedian_id),
    slot_key: String(row.slot_key),
    dispo: row.dispo === true,
    mc: row.mc === true,
  };
}

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!verifyAdminToken(req)) {
    return res.status(401).json({ error: 'Non autorisé — reconnecte-toi en admin' });
  }

  const { action, payload } = req.body || {};

  try {
    switch (action) {
      case 'sync': {
        const p = payload || {};
        const out = {};

        if (Array.isArray(p.comedians)) {
          const rows = p.comedians.map(sanitizeComedian).filter(Boolean).slice(0, MAX_BULK);
          if (rows.length) await sbAdmin('comedians', { method: 'POST', params: '?on_conflict=id', body: rows });
          out.comedians = rows.length;
        }

        if (Array.isArray(p.assignments)) {
          // Remplacement complet — même comportement que saveToSupabase() côté client :
          // on vide la table puis on réinsère l'état courant (y compris si vide = planning reset).
          await sbAdmin('assignments', { method: 'DELETE', params: '?id=gte.0' });
          const rows = p.assignments.map(sanitizeAssignment).filter(Boolean).slice(0, MAX_BULK);
          if (rows.length) await sbAdmin('assignments', { method: 'POST', body: rows });
          out.assignments = rows.length;
        }

        if (Array.isArray(p.dispoStatus)) {
          const rows = p.dispoStatus.map(sanitizeDispoStatus).filter(Boolean).slice(0, MAX_BULK);
          if (rows.length) await sbAdmin('dispo_status', { method: 'POST', params: '?on_conflict=comedian_id', body: rows });
          out.dispoStatus = rows.length;
        }

        if (Array.isArray(p.dispos)) {
          const rows = p.dispos.map(sanitizeDispo).filter(Boolean).slice(0, MAX_BULK);
          if (rows.length) await sbAdmin('dispos', { method: 'POST', params: '?on_conflict=comedian_id,slot_key', body: rows });
          out.dispos = rows.length;
        }

        return res.status(200).json({ success: true, ...out });
      }

      case 'deleteComedian': {
        const id = payload?.id;
        if (!isNonEmptyString(id, 100)) return res.status(400).json({ error: 'id requis' });
        const eid = encodeURIComponent(id);
        await sbAdmin('comedians', { method: 'DELETE', params: `?id=eq.${eid}` });
        await sbAdmin('dispos', { method: 'DELETE', params: `?comedian_id=eq.${eid}` });
        await sbAdmin('dispo_status', { method: 'DELETE', params: `?comedian_id=eq.${eid}` });
        await sbAdmin('assignments', { method: 'DELETE', params: `?comedian_id=eq.${eid}` });
        return res.status(200).json({ success: true });
      }

      case 'clearAll': {
        await sbAdmin('assignments', { method: 'DELETE', params: '?comedian_id=neq.null' });
        await sbAdmin('dispos', { method: 'DELETE', params: '?comedian_id=neq.null' });
        await sbAdmin('dispo_status', { method: 'DELETE', params: '?comedian_id=neq.null' });
        await sbAdmin('comedians', { method: 'DELETE', params: '?id=neq.null' });
        return res.status(200).json({ success: true });
      }

      case 'chatSend': {
        const text = payload?.text;
        if (!isNonEmptyString(text, 2000)) return res.status(400).json({ error: 'text requis' });
        await sbAdmin('chat_messages', {
          method: 'POST',
          body: { sender: 'ADMIN', sender_id: 'admin', text: String(text).slice(0, 2000) },
        });
        return res.status(200).json({ success: true });
      }

      default:
        return res.status(403).json({ error: 'Action non autorisée' });
    }
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
