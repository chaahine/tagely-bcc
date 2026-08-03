// GET /api/cron-dispo-reminders — déclenché par Vercel Cron (voir vercel.json,
// crons: [{ path: "/api/cron-dispo-reminders", schedule: "0 8 * * *" }]).
//
// Contexte : sendDispos() (index.html) reste le déclenchement MANUEL (bouton
// admin) qui existait déjà — inchangé. Cette route ajoute un rappel
// AUTOMATIQUE, sans action admin, aux comédiens qui n'ont toujours pas
// répondu, envoyé les 1er, 5 et 8 de chaque mois (deadline par défaut le 12,
// configurable par club — clubs.dispo_deadline_day, écrite par l'action
// "updateClub" dans admin-write.js, cf. Réglages > Infos du club côté
// index.html. Ce cron lit la colonne directement en base — pas de route de
// lecture dédiée, une seule façon d'écrire/lire ce réglage. Voir
// ~/Downloads/stagely-add-dispo-deadline-day.sql pour la migration).
//
// ── Fréquence Vercel Cron — Hobby vs Pro ──
// Le plan Hobby limite les Cron Jobs à au plus une invocation HTTP par jour
// (pas de granularité horaire) et à 2 cron jobs par projet. Un schedule du
// type "0 8 1,5,8 * *" (qui ne déclenche que 3 jours précis par mois, jamais
// plus d'une fois le même jour) respecterait techniquement cette limite —
// mais pour ne dépendre d'AUCUNE règle de plan (y compris si le projet change
// de plan plus tard) et rester la solution la plus simple à raisonner, ce
// cron tourne TOUS LES JOURS à 8h UTC et décide en interne s'il doit agir
// (voir isTargetDay ci-dessous) : c'est un no-op quasi instantané les jours
// qui ne sont ni le 1er, ni le 5, ni le 8 du mois. Fonctionne identiquement
// sur Hobby et sur Pro.
//
// ── Mois cible ──
// Ce projet n'a PAS de règle "après le 20 du mois → mois prochain" ailleurs
// dans le code. La convention réellement utilisée partout (sendDispos(),
// getDisposTargetMonthPrefix()/getDispoTargetMonth() dans index.html,
// portal.html) est plus simple et volontairement indépendante du jour
// d'exécution : le mois cible est TOUJOURS le mois calendaire suivant. On
// reproduit exactement cette règle ici (targetMonth()) pour rester cohérent
// avec le reste de l'app plutôt que d'inventer un seuil au 20 qui n'existe
// nulle part ailleurs.
//
// ── "N'a pas répondu" ──
// Il n'y a pas de statut "replied" par mois en base : dispo_status.status est
// une seule valeur par comédien (dernière campagne). Le code client calcule
// donc un statut "effectif" — effectiveDispoStatus()/hasRepliedForTargetMonth()
// dans index.html — en vérifiant s'il existe au moins une ligne `dispos` avec
// dispo=true pour le mois cible. On reproduit la même logique ici (a-t-il au
// moins une ligne dispos avec dispo=true dont slot_key tombe dans le mois
// cible), plutôt que de se fier à dispo_status.status seul, qui peut être
// "replied" pour un mois passé et donc trompeur pour le mois cible actuel.
//
// ── Sécurité ──
// Réservé à Vercel Cron : vérifie l'en-tête Authorization: Bearer
// <CRON_SECRET> que Vercel ajoute automatiquement à chaque invocation
// programmée quand la variable d'environnement CRON_SECRET est définie côté
// projet (Vercel Dashboard → Settings → Environment Variables — à créer,
// jamais en dur dans ce fichier). Sans cette variable définie, la route
// refuse toute exécution : pas de repli permissif sur une route qui envoie
// des emails en masse à tous les clubs.

import { sbAdmin, sendTransactionalEmail } from './_lib.js';

const MOIS_FULL = ['janvier','février','mars','avril','mai','juin','juillet','août','septembre','octobre','novembre','décembre'];

// 1er, 5 ou 8 du mois — voir la note "Fréquence Vercel Cron" en tête de fichier.
export function isTargetDay(date) {
  const d = date.getDate();
  return d === 1 || d === 5 || d === 8;
}

// Même convention que getDispoTargetMonth() côté client (index.html) : le
// mois cible est toujours le mois calendaire suivant, quel que soit le jour.
export function targetMonth(now) {
  const year = now.getMonth() === 11 ? now.getFullYear() + 1 : now.getFullYear();
  const month = (now.getMonth() + 1) % 12; // 0-indexé
  return { year, month };
}

function pad2(n) { return String(n).padStart(2, '0'); }

// Bornes [from, to) sur slot_key (format "YYYY-MM-DD-HHhMM", trie
// lexicographique = trie chronologique) — même approche que
// getDisposDateFrom()/getDisposDateTo() côté client.
function monthRange({ year, month }) {
  const from = `${year}-${pad2(month + 1)}-01`;
  const nextMonth = month + 1;
  const to = nextMonth > 11 ? `${year + 1}-01-01` : `${year}-${pad2(nextMonth + 1)}-01`;
  return { from, to };
}

// Logique métier isolée de l'auth/HTTP — appelée par le handler avec
// now = new Date() en prod, et directement par les tests avec une date
// injectée (déterministe, indépendant du jour réel d'exécution des tests).
export async function runDispoReminders(now) {
  const tm = targetMonth(now);
  const { from, to } = monthRange(tm);
  const monthLabel = `${MOIS_FULL[tm.month]} ${tm.year}`;
  const currentMonthLabel = `${MOIS_FULL[now.getMonth()]} ${now.getFullYear()}`;

  // Tous les clubs actifs — un club "suspended" ne doit recevoir aucune
  // sollicitation (cohérent avec resolveClubIdByPortalCode()/admin-login.js
  // qui bloquent déjà l'accès à un club suspendu).
  const clubs = await sbAdmin('clubs', {
    params: '?status=neq.suspended&select=id,name,admin_email,portal_code,dispo_deadline_day',
  });

  const report = [];
  for (const club of clubs || []) {
    const deadlineDay = Number.isInteger(club.dispo_deadline_day) ? club.dispo_deadline_day : 12;
    const comedians = await sbAdmin('comedians', {
      params: `?club_id=eq.${encodeURIComponent(club.id)}&active=eq.true&select=id,name,email`,
    });

    let sent = 0, alreadyReplied = 0, noEmail = 0, failed = 0;
    for (const c of comedians || []) {
      if (!c.email) { noEmail++; continue; }

      const replies = await sbAdmin('dispos', {
        params: `?comedian_id=eq.${encodeURIComponent(c.id)}&slot_key=gte.${from}&slot_key=lt.${to}&dispo=eq.true&select=slot_key&limit=1`,
      });
      if (Array.isArray(replies) && replies.length) { alreadyReplied++; continue; }

      const firstName = (c.name || '').split(' ')[0] || '';
      const subject = `🎤 ${club.name || 'Stagely'} — Rappel : tes disponibilités ${monthLabel}`;
      const html = `
        <p>Salut ${firstName},</p>
        <p>Petit rappel : merci de renseigner tes disponibilités pour <strong>${monthLabel}</strong> avant le <strong>${deadlineDay} ${currentMonthLabel}</strong>.</p>
        ${club.portal_code ? `<p>Code d'accès au portail : <strong>${club.portal_code}</strong></p>` : ''}
        <p>${club.name || 'L’équipe'}</p>
      `;
      const result = await sendTransactionalEmail({
        to: c.email,
        subject,
        html,
        senderName: club.name || 'Stagely',
        replyToEmail: club.admin_email,
        replyToName: club.name,
      });
      if (result.success) sent++; else failed++;
    }

    report.push({ clubId: club.id, comedians: (comedians || []).length, sent, alreadyReplied, noEmail, failed });
  }

  return { targetMonth: `${tm.year}-${pad2(tm.month + 1)}`, clubs: report.length, report };
}

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: 'CRON_SECRET manquant côté serveur — route désactivée par sécurité' });
  }
  const authHeader = req.headers['authorization'] || '';
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  const now = new Date();
  if (!isTargetDay(now)) {
    return res.status(200).json({ skipped: true, reason: 'pas un jour de rappel (1, 5 ou 8 du mois)' });
  }

  try {
    const result = await runDispoReminders(now);
    return res.status(200).json({ success: true, ...result });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
