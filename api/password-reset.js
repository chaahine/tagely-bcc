// POST /api/password-reset
//   { action: 'request', email }            → envoie un lien par email
//   { action: 'confirm', token, password }  → enregistre le nouveau mot de passe
//
// Mot de passe oublié pour les comptes admin (table `admins`). Le lien pointe
// vers /mot-de-passe.html?token=… et vaut 1 heure, une seule fois (voir
// issueResetToken() dans _lib.js).
//
// 'request' répond TOUJOURS la même chose, que l'adresse existe ou non : même
// règle qu'admin-login.js, on ne laisse jamais deviner qu'un email a un
// compte.

import {
  applyCors, sbAdmin, isValidEmail, sha256Hex,
  issueResetToken, verifyResetToken, passwordFingerprint, sendTransactionalEmail,
} from './_lib.js';
import { publicOrigin } from './_stripe.js';

const GENERIC_OK = 'Si un compte existe pour cette adresse, un lien vient de partir par email.';
const INVALID_LINK = 'Ce lien a expiré ou a déjà servi. Refais une demande.';

function resetEmailHtml(url) {
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;line-height:1.6;color:#1a1a1a">
    <p>Tu as demandé à changer ton mot de passe Stagely. Clique sur le bouton pour en choisir un nouveau :</p>
    <p style="margin:24px 0"><a href="${url}" style="background:#f97316;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600">Choisir un nouveau mot de passe</a></p>
    <p style="color:#666;font-size:13px">Ce lien est valable 1 heure et ne sert qu'une fois. Si tu n'as rien demandé, ignore cet email : ton mot de passe actuel reste valable.</p>
  </div>`;
}

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, email, token, password } = req.body || {};

  try {
    if (action === 'request') {
      if (!isValidEmail(email)) return res.status(400).json({ error: 'Adresse email invalide' });
      const clean = email.trim().toLowerCase();
      const rows = await sbAdmin('admins', {
        params: `?email=eq.${encodeURIComponent(clean)}&select=id,password_hash&limit=1`,
      });
      const admin = Array.isArray(rows) && rows.length ? rows[0] : null;
      if (admin) {
        const url = `${publicOrigin(req)}/mot-de-passe.html?token=${encodeURIComponent(issueResetToken(admin.id, admin.password_hash).token)}`;
        const sent = await sendTransactionalEmail({
          to: clean,
          subject: 'Ton nouveau mot de passe Stagely',
          html: resetEmailHtml(url),
          senderName: 'Stagely',
        });
        // Journalisé sans l'adresse : un échec Brevo ne doit pas passer
        // inaperçu, mais la réponse au navigateur reste la même.
        if (!sent || !sent.success) console.error('password-reset: envoi échoué', sent && sent.error);
      }
      return res.status(200).json({ success: true, message: GENERIC_OK });
    }

    if (action === 'confirm') {
      const claims = verifyResetToken(token);
      if (!claims) return res.status(400).json({ error: INVALID_LINK });
      if (typeof password !== 'string' || password.length < 6) {
        return res.status(400).json({ error: 'Le mot de passe doit faire au moins 6 caractères' });
      }
      const rows = await sbAdmin('admins', {
        params: `?id=eq.${encodeURIComponent(claims.admin_id)}&select=id,email,password_hash&limit=1`,
      });
      const admin = Array.isArray(rows) && rows.length ? rows[0] : null;
      if (!admin || passwordFingerprint(admin.password_hash) !== claims.ph) {
        return res.status(400).json({ error: INVALID_LINK });
      }
      await sbAdmin('admins', {
        method: 'PATCH',
        params: `?id=eq.${encodeURIComponent(admin.id)}`,
        body: { password_hash: sha256Hex(password) },
      });
      return res.status(200).json({ success: true, email: admin.email });
    }

    return res.status(400).json({ error: 'Action inconnue' });
  } catch (e) {
    console.error('password-reset:', e && e.message);
    return res.status(500).json({ error: 'Erreur serveur, réessaie plus tard' });
  }
}
