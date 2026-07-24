// POST /api/portal-write   body: { action, payload }
//
// Proxy d'écriture pour le portail humoriste (portal.html). Pas de vrai compte
// authentifié à ce jour (chantier multitenant plus large, hors scope ici) : ce
// proxy ne fait donc PAS d'auth forte, seulement une réduction de surface —
// whitelist stricte des tables/colonnes atteignables et validation des payloads.
//
// Actions :
//  - ensureComedian : appelée à la connexion (doLogin) — cherche un comédien
//                      existant par email, sinon en crée un (auto-inscription,
//                      nécessaire au 1er login). N'écrit que si le comédien
//                      n'existe pas déjà.
//  - submitDispos   : enregistre les dispos + statut d'un comédien déjà connu
//                      (comedianId doit correspondre à un comédien existant).
//  - cancelDates    : supprime une ou plusieurs assignations du comédien
//                      concerné et notifie l'admin via chat_messages.
//
// Compromis assumé : ces actions touchent bien "comedians" (ensureComedian) et
// "assignments" (cancelDates), ce qui dépasse la restriction initialement
// envisagée (dispos/dispo_status/chat_messages uniquement). Voir le rapport
// livré avec ce chantier pour le détail — sans ces écritures, l'auto-inscription
// et l'auto-retrait de date (fonctionnalités déjà en prod) casseraient. Aucune
// de ces routes ne vérifie l'identité de l'appelant au-delà de la forme des
// données : ce n'est pas une authentification, seulement une réduction de la
// surface d'écriture par rapport à l'accès direct Supabase (anon) actuel.

import { applyCors, sbAdmin, isNonEmptyString, SLOT_KEY_RE, idFromEmail } from './_lib.js';

const MAX_ROWS = 500;

async function findComedianById(id) {
  const rows = await sbAdmin('comedians', { params: `?id=eq.${encodeURIComponent(id)}&select=id,name` });
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function findComedianByEmail(email) {
  const rows = await sbAdmin('comedians', {
    params: `?email=eq.${encodeURIComponent(email.toLowerCase())}&select=id,name`,
  });
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

function sanitizeDispoRow(row, comedianId) {
  if (!row || typeof row !== 'object') return null;
  if (!SLOT_KEY_RE.test(row.slot_key || '')) return null;
  return {
    comedian_id: comedianId,
    slot_key: String(row.slot_key),
    dispo: row.dispo === true,
    mc: row.mc === true,
  };
}

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, payload } = req.body || {};

  try {
    switch (action) {
      case 'ensureComedian': {
        const nc = payload?.newComedian;
        if (!nc || !isNonEmptyString(nc.name, 200) || !isNonEmptyString(nc.email, 200) || !isNonEmptyString(nc.phone, 40)) {
          return res.status(400).json({ error: 'name, email, phone requis' });
        }
        const email = nc.email.trim().toLowerCase();
        let comedian = await findComedianByEmail(email);
        let created = false;
        if (!comedian) {
          const comedianId = idFromEmail(email);
          const row = {
            id: comedianId,
            name: String(nc.name).slice(0, 200),
            prio: 'new',
            presence: 100,
            gender: nc.gender === 'f' ? 'f' : 'm',
            duration: Number.isFinite(nc.duration) ? nc.duration : 10,
            phone: String(nc.phone).slice(0, 40),
            email,
            active: true,
          };
          await sbAdmin('comedians', { method: 'POST', params: '?on_conflict=id', body: [row] });
          comedian = row;
          created = true;
        }
        return res.status(200).json({ success: true, created, comedian });
      }

      case 'submitDispos': {
        const p = payload || {};
        const comedianId = isNonEmptyString(p.comedianId, 100) ? String(p.comedianId) : null;
        if (!comedianId) return res.status(400).json({ error: 'comedianId requis' });
        const comedian = await findComedianById(comedianId);
        if (!comedian) return res.status(404).json({ error: 'Comédien introuvable — reconnecte-toi' });

        const dispoRows = Array.isArray(p.dispoRows)
          ? p.dispoRows.map((r) => sanitizeDispoRow(r, comedianId)).filter(Boolean).slice(0, MAX_ROWS)
          : [];

        if (dispoRows.length) {
          await sbAdmin('dispos', { method: 'POST', params: '?on_conflict=comedian_id,slot_key', body: dispoRows });
        }
        await sbAdmin('dispo_status', {
          method: 'POST',
          params: '?on_conflict=comedian_id',
          body: [{ comedian_id: comedianId, status: 'replied' }],
        });

        return res.status(200).json({ success: true, comedianId, comedianName: comedian.name, dispoCount: dispoRows.length });
      }

      case 'cancelDates': {
        const p = payload || {};
        const comedianId = p.comedianId;
        const comedianName = p.comedianName;
        if (!isNonEmptyString(comedianId, 100) || !isNonEmptyString(comedianName, 200)) {
          return res.status(400).json({ error: 'comedianId et comedianName requis' });
        }
        const comedian = await findComedianById(comedianId);
        if (!comedian) return res.status(404).json({ error: 'Comédien introuvable' });

        const slotKeys = Array.isArray(p.slotKeys)
          ? p.slotKeys.filter((k) => SLOT_KEY_RE.test(k || '')).slice(0, 50)
          : [];
        if (!slotKeys.length) return res.status(400).json({ error: 'slotKeys requis' });

        for (const key of slotKeys) {
          await sbAdmin('assignments', {
            method: 'DELETE',
            params: `?slot_key=eq.${encodeURIComponent(key)}&comedian_id=eq.${encodeURIComponent(comedianId)}`,
          });
        }

        const reason = isNonEmptyString(p.reason, 500) ? String(p.reason).slice(0, 500) : '';
        // "details" est un résumé lisible construit côté client (ex: "Mardi 12 août à 20:15") —
        // simple mise en forme, pas de donnée sensible. Repli sur les clés brutes si absent.
        const details = isNonEmptyString(p.details, 500) ? String(p.details).slice(0, 500) : slotKeys.join(', ');
        const text =
          p.mode === 'modify'
            ? `📝 MODIFICATION — ${comedianName} a retiré ${slotKeys.length} date${slotKeys.length > 1 ? 's' : ''} : ${details}`
            : `🚨 ANNULATION — ${comedianName} ne peut plus assurer ${details}${reason ? ' : ' + reason : ''}`;

        await sbAdmin('chat_messages', {
          method: 'POST',
          body: { sender: comedianName, sender_id: comedianId, text: text.slice(0, 2000) },
        });

        return res.status(200).json({ success: true, removed: slotKeys.length });
      }

      default:
        return res.status(403).json({ error: 'Action non autorisée' });
    }
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
