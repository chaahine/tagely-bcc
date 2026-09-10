// POST /api/accept-invite   (route PUBLIQUE — pas de session admin requise)
// body: { action: 'preview' | 'accept', token, password? }
//
// Deuxième moitié du chantier "plusieurs personnes par club" : consomme le
// lien d'invitation émis par api/club-access.js (action 'invite'). Le token
// est signé (issueInviteToken/verifyInviteToken, api/_lib.js) et porte le
// club et l'adresse email — aucune table d'invitation, donc aucune migration
// SQL à appliquer.
//
// 'preview' sert à l'affichage de rejoindre.html (nom du club, email
// concerné) AVANT de demander un mot de passe : personne ne remplit un
// formulaire sans savoir ce qu'il rejoint.
//
// ── Point de sécurité, à ne pas défaire ──
// Si l'adresse invitée possède DÉJÀ un compte Stagely, le mot de passe fourni
// ici est ignoré et le compte n'est jamais modifié : on crée uniquement le
// lien vers le club, et la personne se connecte comme d'habitude. Sans cette
// règle, inviter une adresse existante reviendrait à pouvoir en réinitialiser
// le mot de passe — n'importe quel club pourrait prendre le contrôle du
// compte d'un autre en l'invitant. C'est aussi pourquoi accept-invite ne
// renvoie JAMAIS de token de session pour un compte préexistant.

import {
  applyCors, sbAdmin, sha256Hex, newId, verifyInviteToken,
  issueAdminToken, computePlanAccess,
} from './_lib.js';

async function findAdminByEmail(email) {
  const rows = await sbAdmin('admins', {
    params: `?email=eq.${encodeURIComponent(email)}&select=id&limit=1`,
  });
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function loadClub(clubId) {
  const rows = await sbAdmin('clubs', {
    params: `?id=eq.${encodeURIComponent(clubId)}&select=id,name,city,slug,portal_code,dispo_deadline_day,status,plan&limit=1`,
  });
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { action, token, password } = req.body || {};
  const invite = verifyInviteToken(token);
  if (!invite) {
    return res.status(400).json({ error: 'Ce lien est invalide ou a expiré. Demande une nouvelle invitation.' });
  }

  try {
    const club = await loadClub(invite.club_id);
    if (!club) {
      return res.status(404).json({ error: "Ce club n'existe plus" });
    }

    if (action === 'preview') {
      return res.status(200).json({
        success: true,
        email: invite.email,
        club: { name: club.name, city: club.city || null },
        // Dit au formulaire s'il doit demander un mot de passe (compte à
        // créer) ou simplement inviter à se connecter (compte existant).
        existingAccount: !!(await findAdminByEmail(invite.email)),
      });
    }

    if (action !== 'accept') {
      return res.status(400).json({ error: 'Action inconnue' });
    }

    const existingAdmin = await findAdminByEmail(invite.email);

    // Compte préexistant : on lie, on ne touche à rien d'autre (voir en-tête).
    if (existingAdmin) {
      await sbAdmin('admin_club_links', {
        method: 'POST', body: [{ admin_id: existingAdmin.id, club_id: club.id }],
      });
      return res.status(200).json({
        success: true,
        linked: true,
        existingAccount: true,
        message: `Ton compte a maintenant accès à ${club.name}. Connecte-toi avec ton mot de passe habituel.`,
      });
    }

    if (typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ error: 'Le mot de passe doit faire au moins 6 caractères' });
    }

    const adminId = newId();
    try {
      await sbAdmin('admins', {
        method: 'POST',
        body: [{ id: adminId, email: invite.email, password_hash: sha256Hex(password) }],
      });
    } catch (e) {
      // Course possible : le compte a pu être créé entre findAdminByEmail() et
      // ici (inscription self-service en parallèle, ou double clic sur le lien).
      // On ne renvoie jamais le SQL brut, et on réoriente vers la connexion —
      // surtout pas vers un écrasement de mot de passe.
      const again = await findAdminByEmail(invite.email);
      if (again) {
        await sbAdmin('admin_club_links', {
          method: 'POST', body: [{ admin_id: again.id, club_id: club.id }],
        });
        return res.status(200).json({
          success: true, linked: true, existingAccount: true,
          message: `Ton compte a maintenant accès à ${club.name}. Connecte-toi avec ton mot de passe habituel.`,
        });
      }
      return res.status(409).json({ error: 'Un conflit est survenu, réessaie dans quelques secondes' });
    }

    await sbAdmin('admin_club_links', {
      method: 'POST', body: [{ admin_id: adminId, club_id: club.id }],
    });

    // Compte fraîchement créé par CETTE invitation : on ouvre directement la
    // session, la personne arrive dans son club sans repasser par le login.
    // rememberMe reste à false — c'est une première connexion, pas un choix
    // explicite de l'utilisateur.
    const { token: sessionToken, exp } = issueAdminToken(
      adminId, [{ id: club.id, name: club.name }], club.id, false,
    );
    const planAccess = computePlanAccess(club);
    return res.status(201).json({
      success: true,
      linked: true,
      existingAccount: false,
      token: sessionToken,
      expiresAt: exp,
      club: {
        id: club.id, slug: club.slug, name: club.name, city: club.city,
        portal_code: club.portal_code, dispo_deadline_day: club.dispo_deadline_day,
        plan: planAccess.plan, status: planAccess.status, pro_features: planAccess.proFeatures,
      },
    });
  } catch (e) {
    console.error('accept-invite:', e && e.message);
    return res.status(500).json({ error: 'Erreur serveur, réessaie plus tard' });
  }
}
