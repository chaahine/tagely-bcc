// POST /api/admin-write   header: Authorization: Bearer <token admin>
// body: { action, payload }
//
// Proxy d'écriture pour l'app admin (index.html). Remplace les appels directs
// du navigateur vers Supabase (clé anon) par des écritures serveur avec la clé
// service_role. Whitelist stricte des actions ci-dessous — tout le reste → 403.
//
// Actions :
//  - sync             : upsert comédiens / remplacement complet des assignments /
//                        upsert dispo_status / upsert dispos (reflète saveToSupabase()
//                        et saveHumoristeFiche() côté client — un seul point d'entrée
//                        pour toutes les sauvegardes "planning courant")
//  - deleteComedian   : supprime un comédien + toutes ses lignes liées
//  - clearAll         : vide entièrement les 4 tables (reset total, très destructif)
//  - chatSend         : insère un message admin dans chat_messages (alerte urgence)
//  - addScheduleSlot  : ajoute un créneau récurrent à la grille (schedule_templates),
//                        chantier multitenant étape D — remplace la mutation locale
//                        de DAYS_CONFIG par une écriture DB scopée au club
//  - removeScheduleSlot : supprime un créneau récurrent (par id)
//  - updateClub       : écrit clubs.name/city/dispo_deadline_day pour le club
//                        authentifié (bouton "Sauvegarder" de Réglages > Infos
//                        du club — jusqu'ici ce bouton ne faisait qu'un toast,
//                        rien n'était jamais persisté). dispo_deadline_day est
//                        best-effort : si la colonne n'existe pas encore sur cet
//                        environnement (migration pas encore appliquée), on
//                        retombe sur nom/ville seuls plutôt que de faire
//                        échouer toute la sauvegarde. SEULE action qui écrit
//                        dispo_deadline_day — pas d'action 'updateDeadline'
//                        séparée : le rappel automatique (api/cron-dispo-
//                        reminders.js) lit directement la colonne en base,
//                        aucune route dédiée nécessaire côté lecture non plus.

import { applyCors, sbAdmin, verifyAdminToken, isNonEmptyString, SLOT_KEY_RE, clubOrFilter, newId } from './_lib.js';

const MAX_BULK = 5000; // garde-fou anti-abus sur les upserts en masse

// aligné sur Date.getDay() (0=dimanche ... 6=samedi), même convention que
// schedule_templates.weekday (cf. stagely-multitenant-schema.sql) et que
// DAY_NAMES côté client (index.html/portal.html)
const TIME_RE = /^\d{2}:\d{2}$/;

// Un club (BCC compris) peut ne pas encore avoir de ligne `rooms` (ex. club
// migré avant que la notion de salle existe, ou tout juste créé). On ne
// bloque jamais l'ajout d'un créneau pour cette raison : on crée une salle
// par défaut à la volée plutôt que d'exposer ce détail interne à l'UI admin
// (qui n'a aujourd'hui aucun concept de "salle").
async function resolveDefaultRoomId(clubId) {
  const rows = await sbAdmin('rooms', {
    params: `?club_id=eq.${encodeURIComponent(clubId)}&active=eq.true&select=id&order=id&limit=1`,
  });
  if (Array.isArray(rows) && rows.length) return rows[0].id;
  const room = { id: newId(), club_id: clubId, name: 'Salle principale', active: true };
  await sbAdmin('rooms', { method: 'POST', body: [room] });
  return room.id;
}

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

  const auth = verifyAdminToken(req);
  if (!auth) {
    return res.status(401).json({ error: 'Non autorisé — reconnecte-toi en admin' });
  }
  // Chantier "multi-club-admin" : le token porte désormais accessible_clubs
  // (tous les clubs de l'admin) + active_club_id (celui sélectionné dans
  // cette session, via /api/switch-club) — c'est TOUJOURS active_club_id qui
  // scope les écritures, jamais l'ensemble accessible_clubs.
  const clubId = auth.active_club_id;
  const scope = clubOrFilter(clubId); // cf. api/_lib.js — club_id=eq.<id>, plus de repli IS NULL depuis le backfill de l'étape C

  const { action, payload } = req.body || {};

  try {
    switch (action) {
      case 'sync': {
        const p = payload || {};
        const out = {};

        if (Array.isArray(p.comedians)) {
          const rows = p.comedians.map(sanitizeComedian).filter(Boolean).slice(0, MAX_BULK)
            .map(r => ({ ...r, club_id: clubId }));
          if (rows.length) await sbAdmin('comedians', { method: 'POST', params: '?on_conflict=id', body: rows });
          out.comedians = rows.length;
        }

        if (Array.isArray(p.assignments)) {
          // Remplacement complet — même comportement que saveToSupabase() côté client :
          // on vide la table puis on réinsère l'état courant (y compris si vide = planning reset).
          // Scopé au club authentifié uniquement — avant ce correctif, ce DELETE n'avait
          // aucun filtre (?id=gte.0) et effaçait TOUTE la table, tous clubs confondus.
          await sbAdmin('assignments', { method: 'DELETE', params: `?${scope}` });
          const rows = p.assignments.map(sanitizeAssignment).filter(Boolean).slice(0, MAX_BULK)
            .map(r => ({ ...r, club_id: clubId }));
          if (rows.length) await sbAdmin('assignments', { method: 'POST', body: rows });
          out.assignments = rows.length;
        }

        if (Array.isArray(p.dispoStatus)) {
          const rows = p.dispoStatus.map(sanitizeDispoStatus).filter(Boolean).slice(0, MAX_BULK)
            .map(r => ({ ...r, club_id: clubId }));
          if (rows.length) await sbAdmin('dispo_status', { method: 'POST', params: '?on_conflict=comedian_id', body: rows });
          out.dispoStatus = rows.length;
        }

        if (Array.isArray(p.dispos)) {
          const rows = p.dispos.map(sanitizeDispo).filter(Boolean).slice(0, MAX_BULK)
            .map(r => ({ ...r, club_id: clubId }));
          if (rows.length) await sbAdmin('dispos', { method: 'POST', params: '?on_conflict=comedian_id,slot_key', body: rows });
          out.dispos = rows.length;
        }

        return res.status(200).json({ success: true, ...out });
      }

      case 'deleteComedian': {
        const id = payload?.id;
        if (!isNonEmptyString(id, 100)) return res.status(400).json({ error: 'id requis' });
        const eid = encodeURIComponent(id);
        // Filtré par club_id en plus de l'id : empêche un admin d'un club de
        // supprimer, même par erreur ou en devinant un id, un comédien d'un autre club.
        await sbAdmin('comedians', { method: 'DELETE', params: `?id=eq.${eid}&${scope}` });
        await sbAdmin('dispos', { method: 'DELETE', params: `?comedian_id=eq.${eid}&${scope}` });
        await sbAdmin('dispo_status', { method: 'DELETE', params: `?comedian_id=eq.${eid}&${scope}` });
        await sbAdmin('assignments', { method: 'DELETE', params: `?comedian_id=eq.${eid}&${scope}` });
        return res.status(200).json({ success: true });
      }

      case 'clearAll': {
        // Scopé au club authentifié — avant ce correctif, ces 4 DELETE n'avaient
        // aucun filtre club (juste un ?xxx=neq.null bidon pour satisfaire l'exigence
        // Supabase d'un filtre) et vidaient les tables pour TOUS les clubs.
        await sbAdmin('assignments', { method: 'DELETE', params: `?${scope}` });
        await sbAdmin('dispos', { method: 'DELETE', params: `?${scope}` });
        await sbAdmin('dispo_status', { method: 'DELETE', params: `?${scope}` });
        await sbAdmin('comedians', { method: 'DELETE', params: `?${scope}` });
        return res.status(200).json({ success: true });
      }

      case 'addScheduleSlot': {
        const p = payload || {};
        const weekday = Number(p.weekday);
        const time = p.time;
        if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
          return res.status(400).json({ error: 'weekday requis (0-6)' });
        }
        if (typeof time !== 'string' || !TIME_RE.test(time)) {
          return res.status(400).json({ error: 'time requis au format HH:MM' });
        }
        const label = isNonEmptyString(p.label, 100) ? String(p.label).slice(0, 100) : null;

        // Idempotent : un créneau déjà présent (même jour + heure, même club)
        // n'est pas dupliqué — renvoie la ligne existante. L'UI admin fait
        // déjà cette vérification côté client (DAYS_CONFIG[di].slots.includes),
        // mais on ne fait jamais confiance au client seul pour l'intégrité DB.
        const existing = await sbAdmin('schedule_templates', {
          params: `?weekday=eq.${weekday}&time=eq.${encodeURIComponent(time)}&${scope}&select=id,club_id,room_id,weekday,time,label,active&limit=1`,
        });
        if (Array.isArray(existing) && existing.length) {
          return res.status(200).json({ success: true, alreadyExists: true, template: existing[0] });
        }

        const roomId = await resolveDefaultRoomId(clubId);
        const row = { id: newId(), club_id: clubId, room_id: roomId, weekday, time, label, active: true };
        await sbAdmin('schedule_templates', { method: 'POST', body: [row] });
        return res.status(200).json({ success: true, template: row });
      }

      case 'removeScheduleSlot': {
        const id = payload?.id;
        if (!isNonEmptyString(id, 100)) return res.status(400).json({ error: 'id requis' });
        // Scopé au club authentifié — empêche un admin d'un club de supprimer
        // (même en devinant un id) un créneau d'un autre club.
        await sbAdmin('schedule_templates', {
          method: 'DELETE',
          params: `?id=eq.${encodeURIComponent(id)}&${scope}`,
        });
        return res.status(200).json({ success: true });
      }

      case 'updateClub': {
        const p = payload || {};
        const name = isNonEmptyString(p.name, 120) ? String(p.name).trim().slice(0, 120) : null;
        if (!name) return res.status(400).json({ error: 'Le nom du club est requis' });
        const city = typeof p.city === 'string' ? (p.city.trim().slice(0, 120) || null) : null;

        let deadline = null;
        if (p.dispo_deadline_day !== undefined && p.dispo_deadline_day !== null && p.dispo_deadline_day !== '') {
          const d = Number(p.dispo_deadline_day);
          if (!Number.isInteger(d) || d < 1 || d > 28) {
            return res.status(400).json({ error: 'Deadline dispos : jour du mois entre 1 et 28' });
          }
          deadline = d;
        }

        // Scopé par id=eq.<clubId authentifié> (clubId vient du token vérifié,
        // jamais du payload) — un admin ne peut modifier que sa propre ligne clubs.
        const params = `?id=eq.${encodeURIComponent(clubId)}`;
        const baseUpdate = { name, city };
        let deadlineSaved = false;
        if (deadline !== null) {
          try {
            await sbAdmin('clubs', { method: 'PATCH', params, body: { ...baseUpdate, dispo_deadline_day: deadline } });
            deadlineSaved = true;
          } catch (e) {
            // Repli : colonne dispo_deadline_day pas encore migrée sur cet
            // environnement — on sauvegarde au moins nom/ville, jamais bloquant.
            await sbAdmin('clubs', { method: 'PATCH', params, body: baseUpdate });
          }
        } else {
          await sbAdmin('clubs', { method: 'PATCH', params, body: baseUpdate });
        }

        return res.status(200).json({
          success: true,
          club: { id: clubId, name, city, dispo_deadline_day: deadlineSaved ? deadline : undefined },
        });
      }

      case 'chatSend': {
        const text = payload?.text;
        if (!isNonEmptyString(text, 2000)) return res.status(400).json({ error: 'text requis' });
        await sbAdmin('chat_messages', {
          method: 'POST',
          body: { sender: 'ADMIN', sender_id: 'admin', text: String(text).slice(0, 2000), club_id: clubId },
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
