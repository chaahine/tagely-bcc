// GET /api/cron-dispo-reminders — déclenché par Vercel Cron (voir vercel.json,
// crons: [{ path: "/api/cron-dispo-reminders", schedule: "0 8 * * *" }]).
//
// Contexte : sendDispos() (index.html) reste le déclenchement MANUEL (bouton
// admin) qui existait déjà — inchangé. Cette route ajoute un rappel
// AUTOMATIQUE, sans action admin, aux comédiens qui n'ont toujours pas
// répondu — déclenché par club, à des jours calculés PAR RAPPORT à la
// deadline propre à CE club (clubs.dispo_deadline_day, écrite par l'action
// "updateClub" dans admin-write.js, cf. Réglages > Infos du club côté
// index.html. Ce cron lit la colonne directement en base — pas de route de
// lecture dédiée, une seule façon d'écrire/lire ce réglage. Voir
// ~/Downloads/stagely-add-dispo-deadline-day.sql pour la migration).
//
// ── Jours de rappel relatifs à la deadline, PAS des jours calendaires fixes ──
// Version initiale de ce cron : jours fixes (1, 5, 8 de chaque mois), pensés
// pour la deadline par défaut (12) mais qui ne s'adaptaient pas si un club
// choisissait une autre date — un club avec deadline au 3 du mois aurait pu
// recevoir un rappel le 5 ou le 8, APRÈS sa propre deadline. Corrigé : les
// rappels sont maintenant calculés par club, à REMINDER_OFFSETS_DAYS avant sa
// deadline (mêmes écarts que l'espacement initial 12→1/5/8, soit -11/-7/-4
// jours), voir reminderDaysForDeadline() ci-dessous. Un club qui n'a jamais
// touché ce réglage (deadline=12) reçoit donc ses rappels exactement aux
// mêmes jours qu'avant (1, 5, 8) — comportement inchangé pour le cas par
// défaut, corrigé pour tout club ayant configuré une deadline différente.
//
// ── Fréquence Vercel Cron — Hobby vs Pro ──
// Le plan Hobby limite les Cron Jobs à au plus une invocation HTTP par jour
// (pas de granularité horaire) et à 2 cron jobs par projet. Ce cron tourne
// TOUS LES JOURS à 8h UTC et décide, PAR CLUB, s'il doit agir aujourd'hui
// (voir isReminderDayForClub ci-dessous) : c'est un no-op quasi instantané
// pour un club dont aujourd'hui ne correspond à aucun de ses jours de rappel.
// Fonctionne identiquement sur Hobby et sur Pro, et reste indépendant de tout
// nombre fixe de déclenchements par mois puisque chaque club peut avoir des
// jours de rappel différents des autres.
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

// Écarts (en jours AVANT la deadline) auxquels envoyer un rappel — reproduit
// l'espacement initial pensé pour une deadline au 12 (rappels 1, 5, 8) :
// 12-11=1, 12-7=5, 12-4=8. Appliqué à la deadline RÉELLE de chaque club.
const REMINDER_OFFSETS_DAYS = [11, 7, 4];

// Jours du mois (1-28) où un rappel doit partir pour un club dont la deadline
// est `deadlineDay`. Filtre les écarts qui tomberaient avant le 1er du mois
// (deadline très tôt dans le mois, ex. deadline=3 → 3-11 est négatif, ignoré)
// — et garantit TOUJOURS au moins un jour de rappel (repli sur le 1er du
// mois) plutôt que de laisser un club avec une deadline très précoce sans
// aucun rappel automatique.
export function reminderDaysForDeadline(deadlineDay) {
  const days = REMINDER_OFFSETS_DAYS
    .map((offset) => deadlineDay - offset)
    .filter((day) => day >= 1 && day < deadlineDay);
  const unique = [...new Set(days)].sort((a, b) => a - b);
  return unique.length ? unique : [1];
}

// Un club donné doit-il recevoir un rappel aujourd'hui, compte tenu de SA
// propre deadline (pas un jour calendaire global identique pour tous) ?
export function isReminderDayForClub(date, deadlineDay) {
  return reminderDaysForDeadline(deadlineDay).includes(date.getDate());
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

    // Chaque club a ses propres jours de rappel, calculés à partir de SA
    // deadline — un club dont aujourd'hui ne correspond à aucun de ses jours
    // de rappel est ignoré silencieusement (pas une erreur, juste "pas son
    // tour aujourd'hui"), sans bloquer le traitement des autres clubs.
    if (!isReminderDayForClub(now, deadlineDay)) {
      report.push({ clubId: club.id, skipped: true, reason: 'pas un jour de rappel pour ce club aujourd\'hui', deadlineDay });
      continue;
    }

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
  // Plus de sortie anticipée globale ici : le filtrage "est-ce mon jour de
  // rappel ?" se fait maintenant PAR CLUB dans runDispoReminders(), puisque
  // chaque club peut avoir une deadline différente donc des jours de rappel
  // différents. Cette route tourne tous les jours et fait potentiellement
  // un no-op pour certains clubs, un vrai envoi pour d'autres, le même jour.

  try {
    const result = await runDispoReminders(now);
    return res.status(200).json({ success: true, ...result });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
