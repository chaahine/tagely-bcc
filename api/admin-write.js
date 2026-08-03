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
//                        pour toutes les sauvegardes "planning courant"). Les comédiens
//                        peuvent porter cachet_amount (montant fixe/passage, chantier
//                        "cachet") — voir sanitizeComedian()/requireProAccess() plus bas.
//  - deleteComedian   : supprime un comédien + toutes ses lignes liées
//  - clearAll         : vide entièrement les 4 tables (reset total, très destructif)
//  - chatSend         : insère un message admin dans chat_messages (alerte urgence)
//  - addScheduleSlot  : ajoute un créneau récurrent à la grille (schedule_templates),
//                        chantier multitenant étape D — remplace la mutation locale
//                        de DAYS_CONFIG par une écriture DB scopée au club
//  - removeScheduleSlot : supprime un créneau récurrent (par id)
//  - updateClub       : écrit clubs.name/city/dispo_deadline_day/payment_mode pour le
//                        club authentifié (bouton "Sauvegarder" de Réglages > Infos
//                        du club — jusqu'ici ce bouton ne faisait qu'un toast,
//                        rien n'était jamais persisté). dispo_deadline_day et
//                        payment_mode sont chacun best-effort : si la colonne
//                        n'existe pas encore sur cet environnement (migration pas
//                        encore appliquée), on retombe sur les champs qui existent
//                        plutôt que de faire échouer toute la sauvegarde. SEULE
//                        action qui écrit ces deux colonnes — pas d'action dédiée
//                        séparée (même raisonnement que dispo_deadline_day avant ce
//                        chantier : un seul point d'entrée suffit).
//  - addEvent         : ajoute une date ponctuelle hors grille (table `events`,
//                        source='manual') — mode tournée, chantier 2026-08. Gatée
//                        Pro (voir requireProAccess() plus bas) : un club au palier
//                        Essentiel (hors essai) reçoit un 403, quel que soit ce
//                        qu'affiche le client (jamais fait confiance à
//                        hasProAccess() côté client seul).
//  - removeEvent      : retire une date ponctuelle créée via addEvent (par id,
//                        scopée club + source='manual' — ne touche jamais une
//                        éventuelle ligne events de type 'template', qui sert
//                        à annuler ponctuellement une occurrence de grille,
//                        mécanique distincte non pilotée par cette route).
//                        Pas de gating palier ici à dessein : un club qui
//                        redescend au palier Essentiel doit pouvoir nettoyer
//                        des dates déjà créées, seul l'AJOUT est verrouillé.
//  - saveChapeauEntry : upsert (par club_id+slot_key) une recette de soirée dans
//                        chapeau_entries — Pro (voir requireProAccess()).
//  - getChapeauEntries: lit toutes les entrées chapeau du club authentifié —
//                        volontairement PAS exposé via sbFetch (clé anon) comme le
//                        reste des lectures : donnée financière, on préfère payer le
//                        coût d'un aller-retour serveur plutôt que de la rendre
//                        lisible par n'importe qui connaissant club_id (sbFetch n'a
//                        qu'une policy RLS "lecture publique", cf. stagely-rls-fix.sql).
//                        Pro (voir requireProAccess()).
//  - deleteChapeauEntry : supprime une entrée chapeau (par slot_key). Pro.
//
// ── Gating de palier (chantier 2026-08, mis à jour chantier "cachet + export
//    comptable") ──
// Le mode tournée (addEvent) ET le chapeau (désormais une vraie persistance
// serveur, table chapeau_entries — ce n'était pas le cas jusqu'ici : index.html
// le stockait entièrement dans localStorage, clé 'stagely_chapeau', jamais
// envoyé au backend, ni multitenant-safe ni exportable proprement) sont gatés
// par palier. Le cachet (comedians.cachet_amount) l'est également, écrit via
// l'action 'sync' existante. Toutes ces actions/champs Pro appellent
// requireProAccess(clubId) (voir plus bas) et refusent l'écriture/lecture
// (403) si le club n'a pas accès — jamais une confiance au client, exactement
// le même réflexe que clubId/scope pour l'isolation multitenant.

import { applyCors, sbAdmin, verifyAdminToken, isNonEmptyString, SLOT_KEY_RE, clubOrFilter, newId, computePlanAccess } from './_lib.js';

const MAX_BULK = 5000; // garde-fou anti-abus sur les upserts en masse

// aligné sur Date.getDay() (0=dimanche ... 6=samedi), même convention que
// schedule_templates.weekday (cf. stagely-multitenant-schema.sql) et que
// DAY_NAMES côté client (index.html/portal.html)
const TIME_RE = /^\d{2}:\d{2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Une date calendaire réelle (rejette "2026-02-30" par ex.) — Date() de JS
// "corrige" silencieusement les dates hors bornes (30 février -> 2 mars),
// donc une simple regex ne suffit pas à garantir un slot_key cohérent.
function isValidCalendarDate(dateStr) {
  if (typeof dateStr !== 'string' || !DATE_RE.test(dateStr)) return false;
  const [y, mo, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// "20:15" -> "20H15", même conversion que timeToSuffix() côté client
// (index.html) — le format du suffixe de slot_key ne doit JAMAIS diverger
// entre les deux, sous peine de rendre les dates ponctuelles invisibles/
// orphelines côté planning (règle métier : ne jamais changer ce format).
function timeToSlotSuffix(time) {
  return String(time).replace(':', 'H').toUpperCase();
}

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

// ── Gate Pro (mode tournée/chapeau/cachet/export comptable, chantier 2026-08) ──
// Relit le club EN BASE à chaque écriture/lecture gatée — jamais une
// confiance au plan/status embarqués dans le token admin (issueAdminToken()
// ne les porte de toute façon pas, cf. _lib.js) ni à quoi que ce soit fourni
// par le client. Même philosophie que le reste du fichier : `clubId` vient
// TOUJOURS de auth.active_club_id (token vérifié), jamais du payload.
async function requireProAccess(clubId) {
  const rows = await sbAdmin('clubs', {
    params: `?id=eq.${encodeURIComponent(clubId)}&select=id,status,plan&limit=1`,
  });
  const club = Array.isArray(rows) && rows.length ? rows[0] : null;
  return computePlanAccess(club).proFeatures;
}

function sanitizeComedian(row) {
  if (!row || typeof row !== 'object') return null;
  if (!isNonEmptyString(row.id, 100) || !isNonEmptyString(row.name, 200)) return null;
  const out = {
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
  // cachet_amount (chantier "cachet", 2026-08) : montant fixe par passage,
  // nullable. La clé n'est incluse dans la ligne sortante QUE si le client
  // l'a explicitement fournie (nombre >=0 pour la régler, `null` pour
  // l'effacer) — absente du payload (undefined, cas de tous les appelants
  // qui ne touchent pas ce champ, ex. addH() à la création d'un comédien) =
  // colonne non touchée par cet upsert. Voir handler() plus bas : le gate
  // Pro ne s'applique QUE quand une valeur numérique positive est proposée
  // (jamais quand elle est absente ou remise à null — effacer un cachet
  // n'a besoin d'être bloqué pour personne).
  if (row.cachet_amount === null) {
    out.cachet_amount = null;
  } else if (typeof row.cachet_amount === 'number' && Number.isFinite(row.cachet_amount) && row.cachet_amount >= 0) {
    out.cachet_amount = row.cachet_amount;
  }
  return out;
}

// chapeau_entries — une ligne par soirée (unique sur club_id+slot_key, voir
// SQL). amount_total est calculé ici plutôt que côté DB (pas de colonne
// GENERATED) : reproduit exactement la règle déjà en place côté client avant
// ce chantier (especes+cb, avec repli sur un montant "par personne" saisi
// seul si especes/cb sont à zéro tous les deux).
function sanitizeChapeauEntry(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (!SLOT_KEY_RE.test(payload.slot_key || '')) return null;
  const especes = Number.isFinite(payload.amount_especes) && payload.amount_especes >= 0 ? payload.amount_especes : 0;
  const cb = Number.isFinite(payload.amount_cb) && payload.amount_cb >= 0 ? payload.amount_cb : 0;
  const fallbackTotal = Number.isFinite(payload.amount_total) && payload.amount_total >= 0 ? payload.amount_total : 0;
  const total = (especes + cb) || fallbackTotal;
  if (!total) return null; // un montant est requis (même garde que saveChapeau() côté client avant ce chantier)
  return {
    slot_key: String(payload.slot_key),
    amount_especes: especes,
    amount_cb: cb,
    amount_total: total,
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
          let rows = p.comedians.map(sanitizeComedian).filter(Boolean).slice(0, MAX_BULK)
            .map(r => ({ ...r, club_id: clubId }));
          // Gate Pro sur cachet_amount — voir requireProAccess() plus haut. Ne
          // se déclenche (coût d'un aller-retour DB) que si au moins une ligne
          // propose réellement une VALEUR (nombre) à enregistrer ; remettre le
          // champ à `null` (effacement) ou ne pas le toucher du tout ne coûte
          // jamais cet aller-retour. Un club non-Pro qui tenterait quand même
          // de régler un cachet (requête forgée, ou session dégradée après un
          // downgrade de palier) voit la clé simplement retirée de sa ligne —
          // jamais écrasée à null : une valeur déjà enregistrée avant un
          // éventuel downgrade n'est jamais effacée par un sync ultérieur,
          // cohérent avec le reste du gating (qui masque, ne détruit rien).
          const touchesCachet = rows.some(r => typeof r.cachet_amount === 'number');
          if (touchesCachet && !(await requireProAccess(clubId))) {
            rows = rows.map(r => {
              if (typeof r.cachet_amount !== 'number') return r;
              const { cachet_amount, ...rest } = r;
              return rest;
            });
          }
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

      // ── Mode tournée (palier Pro, chantier 2026-08) ──────────────────────
      case 'addEvent': {
        const p = payload || {};
        const date = p.date;
        const time = p.time;
        if (!isValidCalendarDate(date)) {
          return res.status(400).json({ error: 'date requise, format YYYY-MM-DD (date calendaire valide)' });
        }
        if (typeof time !== 'string' || !TIME_RE.test(time)) {
          return res.status(400).json({ error: 'time requis au format HH:MM' });
        }
        const label = isNonEmptyString(p.label, 100) ? String(p.label).trim().slice(0, 100) : null;

        // Gate Pro/Réseau — voir requireProAccess() plus haut (lit le plan réel
        // en base, jamais le client ni un vieux token).
        if (!(await requireProAccess(clubId))) {
          return res.status(403).json({ error: 'Le mode tournée (dates ponctuelles hors grille) est réservé au palier Pro' });
        }

        const slotKey = `${date}-${timeToSlotSuffix(time)}`;
        if (!SLOT_KEY_RE.test(slotKey)) return res.status(400).json({ error: 'Créneau invalide' });

        // Idempotent — même réflexe que addScheduleSlot : une date déjà
        // ajoutée (même club, même slot_key, pas annulée) n'est pas dupliquée.
        const existing = await sbAdmin('events', {
          params: `?slot_key=eq.${encodeURIComponent(slotKey)}&source=eq.manual&cancelled=eq.false&${scope}&select=id,club_id,room_id,slot_key,source,cancelled,label&limit=1`,
        });
        if (Array.isArray(existing) && existing.length) {
          return res.status(200).json({ success: true, alreadyExists: true, event: existing[0] });
        }

        // room_id fourni par le client (sélecteur multi-salle) : vérifié
        // comme appartenant à CE club avant d'être fait confiance — sinon
        // ignoré silencieusement et remplacé par la salle par défaut, jamais
        // fait confiance en l'état (empêcherait sinon un club de rattacher
        // une date à la salle d'un autre club en devinant un id).
        let roomId = isNonEmptyString(p.room_id, 100) ? p.room_id : null;
        if (roomId) {
          const roomRows = await sbAdmin('rooms', { params: `?id=eq.${encodeURIComponent(roomId)}&${scope}&select=id&limit=1` });
          if (!Array.isArray(roomRows) || !roomRows.length) roomId = null;
        }
        if (!roomId) roomId = await resolveDefaultRoomId(clubId);

        const row = { id: newId(), club_id: clubId, room_id: roomId, slot_key: slotKey, source: 'manual', cancelled: false, label };
        await sbAdmin('events', { method: 'POST', body: [row] });
        return res.status(200).json({ success: true, event: row });
      }

      case 'removeEvent': {
        const id = payload?.id;
        if (!isNonEmptyString(id, 100)) return res.status(400).json({ error: 'id requis' });
        // Scopé club + source='manual' : ne retire jamais une éventuelle
        // ligne 'template' (mécanique distincte d'annulation ponctuelle d'un
        // créneau de grille) — cette action ne touche que les dates ajoutées
        // via addEvent ci-dessus. Pas de gate palier ici (voir commentaire
        // en tête de fichier) : un club redescendu au palier Essentiel doit
        // pouvoir nettoyer ses dates déjà créées.
        await sbAdmin('events', {
          method: 'DELETE',
          params: `?id=eq.${encodeURIComponent(id)}&source=eq.manual&${scope}`,
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

        // payment_mode (chantier "cachet", 2026-08) : 'chapeau' | 'cachet'
        // uniquement. Pas de gate Pro ici — la valeur est inerte pour un club
        // non-Pro (hasProAccess() masque chapeau ET cachet côté client quel
        // que soit payment_mode), même raisonnement que dispo_deadline_day
        // qui n'a jamais été gaté non plus.
        let paymentMode = null;
        if (p.payment_mode !== undefined && p.payment_mode !== null && p.payment_mode !== '') {
          if (p.payment_mode !== 'chapeau' && p.payment_mode !== 'cachet') {
            return res.status(400).json({ error: "payment_mode : 'chapeau' ou 'cachet' uniquement" });
          }
          paymentMode = p.payment_mode;
        }

        // Scopé par id=eq.<clubId authentifié> (clubId vient du token vérifié,
        // jamais du payload) — un admin ne peut modifier que sa propre ligne clubs.
        const params = `?id=eq.${encodeURIComponent(clubId)}`;
        const baseUpdate = { name, city };
        const extra = {};
        if (deadline !== null) extra.dispo_deadline_day = deadline;
        if (paymentMode !== null) extra.payment_mode = paymentMode;

        let saved = {};
        if (Object.keys(extra).length) {
          try {
            await sbAdmin('clubs', { method: 'PATCH', params, body: { ...baseUpdate, ...extra } });
            saved = extra;
          } catch (e) {
            // Repli : au moins une des colonnes optionnelles (dispo_deadline_day
            // et/ou payment_mode) n'existe pas encore sur cet environnement
            // (migration pas encore appliquée) — on sauve ce qu'on peut colonne
            // par colonne plutôt que de tout perdre d'un coup.
            for (const [k, v] of Object.entries(extra)) {
              try {
                await sbAdmin('clubs', { method: 'PATCH', params, body: { ...baseUpdate, [k]: v } });
                saved[k] = v;
              } catch (e2) { /* colonne indisponible sur cet environnement, ignorée */ }
            }
            if (!Object.keys(saved).length) {
              await sbAdmin('clubs', { method: 'PATCH', params, body: baseUpdate });
            }
          }
        } else {
          await sbAdmin('clubs', { method: 'PATCH', params, body: baseUpdate });
        }

        return res.status(200).json({
          success: true,
          club: {
            id: clubId, name, city,
            dispo_deadline_day: Number.isFinite(saved.dispo_deadline_day) ? saved.dispo_deadline_day : undefined,
            payment_mode: typeof saved.payment_mode === 'string' ? saved.payment_mode : undefined,
          },
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

      // ── Chapeau (chantier "cachet + export comptable", 2026-08) — vraie
      // persistance serveur, table chapeau_entries, scopée club_id +
      // gatée Pro (voir requireProAccess() plus haut). Remplace l'ancien
      // stockage localStorage 'stagely_chapeau' (voir commentaire en tête de
      // fichier) : les entrées déjà saisies sur la machine de Bruce avant ce
      // déploiement restent dans le localStorage de SON navigateur (pas
      // récupérables depuis le serveur, aucune API n'y avait jamais accès) —
      // limite connue, documentée, pas bloquante (historique très récent,
      // ressaisie triviale si besoin).
      case 'saveChapeauEntry': {
        if (!(await requireProAccess(clubId))) {
          return res.status(403).json({ error: 'Le chapeau est une fonctionnalité Pro' });
        }
        const row = sanitizeChapeauEntry(payload);
        if (!row) return res.status(400).json({ error: 'slot_key valide et montant requis' });
        await sbAdmin('chapeau_entries', {
          method: 'POST',
          params: '?on_conflict=club_id,slot_key',
          body: [{ ...row, club_id: clubId, updated_at: new Date().toISOString() }],
        });
        return res.status(200).json({ success: true, entry: { ...row, club_id: clubId } });
      }

      case 'getChapeauEntries': {
        if (!(await requireProAccess(clubId))) {
          return res.status(403).json({ error: 'Le chapeau est une fonctionnalité Pro' });
        }
        const rows = await sbAdmin('chapeau_entries', {
          params: `?${scope}&select=id,slot_key,amount_especes,amount_cb,amount_total,created_at&order=slot_key.desc`,
        });
        return res.status(200).json({ success: true, entries: Array.isArray(rows) ? rows : [] });
      }

      case 'deleteChapeauEntry': {
        if (!(await requireProAccess(clubId))) {
          return res.status(403).json({ error: 'Le chapeau est une fonctionnalité Pro' });
        }
        const slotKey = payload?.slot_key;
        if (!SLOT_KEY_RE.test(slotKey || '')) return res.status(400).json({ error: 'slot_key valide requis' });
        await sbAdmin('chapeau_entries', {
          method: 'DELETE',
          params: `?slot_key=eq.${encodeURIComponent(slotKey)}&${scope}`,
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
