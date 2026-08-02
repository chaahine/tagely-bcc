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

import { applyCors, sbAdmin, verifyAdminToken } from './_lib.js';

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
      params: `?id=eq.${encodeURIComponent(auth.club_id)}&select=name`,
    });
    const clubName = Array.isArray(rows) && rows.length && rows[0].name ? rows[0].name : 'Stagely';

    const response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender: { name: clubName, email: 'chahinedjadel@gmail.com' },
        to: [{ email: to }],
        subject,
        htmlContent: html,
      }),
    });

    const data = await response.json();
    if (data.code) return res.status(400).json({ success: false, error: data.message });
    return res.status(200).json({ success: true });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
