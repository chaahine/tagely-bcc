// POST /api/owner-emails   header: Authorization: Bearer <token admin>
//
// Bloc « Emails » de /projets.html : ce que Brevo sait des emails envoyés par
// Stagely sur les 30 derniers jours (rappels de dispos, invitations, mots de
// passe oubliés...) — envoyés, délivrés, ouverts, cliqués, rebonds — et le
// dernier état connu de chaque email récent.
//
// Brevo ne voit PAS les réponses : elles partent directement dans la boîte du
// Reply-To (l'email du club, ou stagely.prog@gmail.com par défaut, voir
// sendTransactionalEmail() dans _lib.js).
//
// Même garde qu'owner-signups.js : réservé au fondateur du BCC.

import { applyCors, verifyAdminToken } from './_lib.js';
import { isOwner } from './owner-signups.js';

const BREVO = 'https://api.brevo.com/v3/smtp/statistics';
const DAYS = 30;

// Ordre de progression d'un email : on garde l'état le plus avancé atteint.
// Un rebond ou un blocage l'emporte sur tout le reste.
const RANK = { requests: 1, delivered: 2, opened: 3, clicks: 4 };
const FAILURES = new Set(['hardBounces', 'softBounces', 'blocked', 'invalid', 'spam', 'error', 'deferred']);

async function brevo(path) {
  const r = await fetch(`${BREVO}${path}`, {
    headers: { 'api-key': process.env.BREVO_API_KEY, accept: 'application/json' },
  });
  if (!r.ok) throw new Error(`Brevo ${path.split('?')[0]} → ${r.status}`);
  return r.json();
}

// Un email = un messageId ; Brevo renvoie une ligne par événement.
export function summarizeEvents(events) {
  const byId = new Map();
  for (const e of events || []) {
    const id = e.messageId || `${e.email}|${e.subject}|${e.date}`;
    const cur = byId.get(id) || { email: e.email, subject: e.subject, date: e.date, status: 'requests', failure: null };
    if (new Date(e.date) < new Date(cur.date)) cur.date = e.date;
    if (FAILURES.has(e.event)) cur.failure = e.event;
    else if ((RANK[e.event] || 0) > (RANK[cur.status] || 0)) cur.status = e.event;
    byId.set(id, cur);
  }
  return [...byId.values()]
    .map(m => ({ email: m.email, subject: m.subject, date: m.date, status: m.failure || m.status }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = verifyAdminToken(req);
  if (!auth) return res.status(401).json({ error: 'Non autorisé — reconnecte-toi en admin' });

  try {
    if (!(await isOwner(auth.admin_id))) {
      return res.status(403).json({ error: 'Page réservée au propriétaire de Stagely' });
    }
    if (!process.env.BREVO_API_KEY) return res.status(500).json({ error: 'BREVO_API_KEY manquante côté serveur' });

    const [report, ev] = await Promise.all([
      brevo(`/aggregatedReport?days=${DAYS}`),
      brevo(`/events?days=${DAYS}&limit=300&sort=desc`),
    ]);
    return res.status(200).json({
      success: true,
      days: DAYS,
      totals: {
        sent: report.requests || 0,
        delivered: report.delivered || 0,
        opened: report.uniqueOpens || 0,
        clicked: report.uniqueClicks || 0,
        bounced: (report.hardBounces || 0) + (report.softBounces || 0),
        blocked: (report.blocked || 0) + (report.invalid || 0),
        spam: report.spamReports || 0,
      },
      recent: summarizeEvents(ev.events).slice(0, 40),
    });
  } catch (e) {
    console.error('owner-emails:', e && e.message);
    return res.status(502).json({ error: 'Brevo ne répond pas' });
  }
}
