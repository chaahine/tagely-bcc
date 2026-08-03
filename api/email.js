// POST /api/email   header: Authorization: Bearer <token admin>
// body: { to, subject, html }
//
// Envoi d'email via Brevo (clé API côté serveur, jamais exposée au client).
// Remplace EmailJS (compte personnel de Chahine, quota partagé entre TOUS
// les clubs, nom d'expéditeur "BCC Stagely" codé en dur pour tout le monde) :
// chaque club envoie désormais sous son propre nom, résolu depuis le club_id
// du token — authentifié comme n'importe quelle autre écriture admin. Cette
// route était auparavant totalement ouverte (aucune vérification), un vrai
// relais d'envoi libre pour quiconque en connaissait l'URL.
//
// Choix produit (2026-08-02) : chaque club ne configure RIEN — on envoie
// depuis une adresse Stagely unique et déjà vérifiée, jamais depuis l'email
// personnel du club. Deux raisons : (1) zéro friction à l'inscription, pas
// d'étape de vérification bloquante ; (2) usurper une adresse @gmail.com
// (très courante chez les petits clubs) via un serveur tiers est souvent
// filtré par Gmail même avec autorisation — une seule adresse bien
// configurée (SPF/DKIM) délivre mieux. Le nom affiché = le club, et
// Reply-To = l'email réel du club (déjà en base, aucune config requise) :
// si l'humoriste répond, ça part directement chez le club, pas chez Stagely.

import { applyCors, sbAdmin, verifyAdminToken, sendTransactionalEmail } from './_lib.js';

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = verifyAdminToken(req);
  if (!auth) {
    return res.status(401).json({ error: 'Non autorisé — reconnecte-toi en admin' });
  }

  const { to, subject, html } = req.body || {};
  if (!to || !subject || !html) {
    return res.status(400).json({ error: 'Paramètres manquants' });
  }

  try {
    const rows = await sbAdmin('clubs', {
      params: `?id=eq.${encodeURIComponent(auth.club_id)}&select=name,admin_email`,
    });
    const club = Array.isArray(rows) && rows.length ? rows[0] : null;
    const clubName = club?.name || 'Stagely';

    // Reply-To = l'email réel du club, pour que les réponses de l'humoriste
    // arrivent directement chez le club plutôt que chez Stagely. Absent si
    // le club n'a pas encore d'admin_email renseigné (ne doit pas arriver en
    // usage normal, mais ne bloque jamais l'envoi si c'est le cas) — géré par
    // sendTransactionalEmail() elle-même (replyToEmail optionnel).
    const result = await sendTransactionalEmail({
      to, subject, html, senderName: clubName, replyToEmail: club?.admin_email, replyToName: clubName,
    });
    if (!result.success) return res.status(400).json({ success: false, error: result.error });
    return res.status(200).json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
