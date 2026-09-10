// POST /api/club-access   header: Authorization: Bearer <token admin>
// body: { action: 'list' | 'invite' | 'revoke', ... }
//
// Chantier "plusieurs personnes par club" (2026-09). Jusqu'ici, un club était
// administré par exactement un compte : `admin_club_links` était pourtant
// déjà une table many-to-many (clé primaire composite (admin_id, club_id)) et
// api/account-delete.js gérait déjà le cas de plusieurs admins sur un club —
// mais AUCUNE route ne créait jamais un second lien. Donner l'accès à une
// deuxième personne demandait un INSERT à la main dans Supabase.
//
// Trois actions, toutes scopées sur le club ACTIF de la session
// (auth.active_club_id), jamais sur un club_id fourni par le client :
//   - list   : qui a accès à ce club aujourd'hui.
//   - invite : donne l'accès à une adresse email. Si elle a déjà un compte
//              Stagely, le lien est créé immédiatement ; sinon un lien
//              d'invitation signé (7 jours) part par email et le compte se
//              crée à l'acceptation (voir api/accept-invite.js).
//   - revoke : retire l'accès d'une autre personne.
//
// Comme /api/switch-club, l'appartenance de l'admin au club est REVÉRIFIÉE en
// base à chaque appel : le token porte bien accessible_clubs, mais ce tableau
// signé ne suffit jamais à autoriser une écriture — un accès révoqué doit
// cesser d'agir immédiatement, sans attendre l'expiration de la session.

import {
  applyCors, sbAdmin, verifyAdminToken, isValidEmail,
  issueInviteToken, sendTransactionalEmail, resolveClubCaps,
} from './_lib.js';
// publicOrigin() vit dans _stripe.js (elle y a été écrite pour les URLs de
// retour de Checkout) : réutilisée telle quelle plutôt que dupliquée, pour
// qu'un jour STAGELY_PUBLIC_URL n'ait à être respectée qu'à un seul endroit.
import { publicOrigin } from './_stripe.js';

// Vérifie EN BASE que cet admin a bien accès à ce club. Ne se fie jamais au
// seul accessible_clubs du token (voir en-tête).
async function adminHasClub(adminId, clubId) {
  const rows = await sbAdmin('admin_club_links', {
    params: `?admin_id=eq.${encodeURIComponent(adminId)}&club_id=eq.${encodeURIComponent(clubId)}&select=admin_id&limit=1`,
  });
  return Array.isArray(rows) && rows.length > 0;
}

// Les personnes ayant accès au club, avec leur email. Deux requêtes plutôt
// qu'une jointure : PostgREST sait embarquer les relations, mais seulement si
// une clé étrangère est déclarée dans le sens attendu — deux lectures simples
// restent lisibles et ne dépendent d'aucune configuration du schéma.
async function listClubAdmins(clubId) {
  const links = await sbAdmin('admin_club_links', {
    params: `?club_id=eq.${encodeURIComponent(clubId)}&select=admin_id,created_at&order=created_at`,
  });
  if (!Array.isArray(links) || !links.length) return [];
  const ids = links.map(l => l.admin_id);
  const admins = await sbAdmin('admins', {
    params: `?id=in.(${ids.map(encodeURIComponent).join(',')})&select=id,email`,
  });
  const emailById = new Map((Array.isArray(admins) ? admins : []).map(a => [a.id, a.email]));
  return links.map(l => ({
    admin_id: l.admin_id,
    email: emailById.get(l.admin_id) || null,
    since: l.created_at || null,
  }));
}

function inviteEmailHtml({ clubName, url, existingAccount }) {
  const intro = existingAccount
    ? `Ton compte Stagely a désormais accès au club <strong>${clubName}</strong>. Il apparaîtra dans ton sélecteur de club à ta prochaine connexion.`
    : `Tu as été invité à co-administrer le club <strong>${clubName}</strong> sur Stagely. Choisis ton mot de passe pour activer ton accès :`;
  const button = existingAccount
    ? `<p style="margin:24px 0"><a href="${url}" style="background:#f97316;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600">Ouvrir Stagely</a></p>`
    : `<p style="margin:24px 0"><a href="${url}" style="background:#f97316;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:600">Activer mon accès</a></p>
       <p style="color:#666;font-size:13px">Ce lien est valable 7 jours.</p>`;
  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;line-height:1.6;color:#1a1a1a">
    <p>${intro}</p>
    ${button}
    <p style="color:#666;font-size:13px">Si tu n'attendais pas cette invitation, ignore simplement cet email — aucun accès n'est ouvert tant que tu ne cliques pas.</p>
  </div>`;
}

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = verifyAdminToken(req);
  if (!auth) return res.status(401).json({ error: 'Non autorisé — reconnecte-toi en admin' });

  const clubId = auth.active_club_id;
  const { action, payload } = req.body || {};

  try {
    if (!(await adminHasClub(auth.admin_id, clubId))) {
      return res.status(403).json({ error: "Tu n'as pas accès à ce club" });
    }

    switch (action) {
      case 'list': {
        const admins = await listClubAdmins(clubId);
        return res.status(200).json({
          success: true,
          // is_self permet à l'UI de griser le bouton "retirer" sur sa propre
          // ligne sans redeviner qui est connecté.
          admins: admins.map(a => ({ ...a, is_self: a.admin_id === auth.admin_id })),
        });
      }

      case 'invite': {
        // Plafond de personnes du palier — voir PLAN_CAPS dans _lib.js (3 en
        // Essentiel, 6 en Pro, illimité en Réseau et pendant l'essai).
        // Seul l'AJOUT est plafonné — 'list' et 'revoke' restent ouverts à tous
        // les paliers, pour qu'un club descendu de palier continue de voir qui
        // a accès à ses données et puisse retirer quelqu'un. Même philosophie
        // que le plafond d'humoristes : on freine la croissance, on ne retire
        // jamais un accès déjà accordé, et on n'enferme jamais un club dans une
        // situation qu'il ne peut plus corriger lui-même.
        const caps = await resolveClubCaps(clubId);
        if (caps.maxClubAdmins !== null) {
          const current = (await listClubAdmins(clubId)).length;
          if (current >= caps.maxClubAdmins) {
            return res.status(403).json({
              error: `Ton palier permet à ${caps.maxClubAdmins} personnes d'administrer un club. Passe au palier supérieur pour en ajouter davantage.`,
              code: 'plan_limit_club_access',
              limit: caps.maxClubAdmins,
              current,
            });
          }
        }
        const rawEmail = (payload && payload.email) || '';
        if (!isValidEmail(rawEmail)) return res.status(400).json({ error: 'Adresse email invalide' });
        const email = rawEmail.trim().toLowerCase();

        const clubRows = await sbAdmin('clubs', {
          params: `?id=eq.${encodeURIComponent(clubId)}&select=name&limit=1`,
        });
        const clubName = (Array.isArray(clubRows) && clubRows.length && clubRows[0].name) || 'ton club';

        const existing = await sbAdmin('admins', {
          params: `?email=eq.${encodeURIComponent(email)}&select=id&limit=1`,
        });
        const existingAdmin = Array.isArray(existing) && existing.length ? existing[0] : null;

        if (existingAdmin) {
          if (await adminHasClub(existingAdmin.id, clubId)) {
            return res.status(409).json({ error: 'Cette personne a déjà accès à ce club' });
          }
          // Compte déjà existant : le lien est créé tout de suite. Pas de
          // token d'invitation — la personne connaît déjà son mot de passe, un
          // détour par un formulaire n'ajouterait rien.
          await sbAdmin('admin_club_links', {
            method: 'POST', body: [{ admin_id: existingAdmin.id, club_id: clubId }],
          });
        }

        const origin = publicOrigin(req);
        const url = existingAdmin
          ? `${origin}/`
          : `${origin}/rejoindre.html?token=${encodeURIComponent(issueInviteToken(clubId, email).token)}`;

        // L'email est un confort, pas la condition du succès : pour un compte
        // existant l'accès est DÉJÀ ouvert quand on arrive ici, et un échec
        // Brevo ne doit pas laisser croire que l'invitation a échoué. Le
        // champ `emailed` dit la vérité à l'UI.
        let emailed = false;
        try {
          const sent = await sendTransactionalEmail({
            to: email,
            subject: existingAdmin ? `Accès au club ${clubName} sur Stagely` : `Invitation à administrer ${clubName} sur Stagely`,
            html: inviteEmailHtml({ clubName, url, existingAccount: !!existingAdmin }),
            senderName: 'Stagely',
          });
          emailed = !!(sent && sent.success);
        } catch (e) { /* non bloquant — voir ci-dessus */ }

        return res.status(200).json({
          success: true,
          emailed,
          linked: !!existingAdmin,
          // Renvoyé UNIQUEMENT pour une invitation à un compte inexistant, afin
          // que l'admin puisse transmettre le lien lui-même si l'email n'est
          // pas parti. Jamais un secret de session : ce lien ne vaut que pour
          // cette adresse et ce club.
          url: existingAdmin ? undefined : url,
          admins: (await listClubAdmins(clubId)).map(a => ({ ...a, is_self: a.admin_id === auth.admin_id })),
        });
      }

      case 'revoke': {
        const targetId = (payload && payload.admin_id) || '';
        if (typeof targetId !== 'string' || !targetId) {
          return res.status(400).json({ error: 'admin_id requis' });
        }
        // Se retirer soi-même est refusé : c'est le seul garde-fou nécessaire
        // pour qu'un club conserve toujours au moins un administrateur. Un
        // départ définitif passe par la suppression de compte
        // (api/account-delete.js), qui gère déjà le transfert et la purge.
        if (targetId === auth.admin_id) {
          return res.status(400).json({ error: 'Tu ne peux pas retirer ton propre accès' });
        }
        if (!(await adminHasClub(targetId, clubId))) {
          return res.status(404).json({ error: "Cette personne n'a pas accès à ce club" });
        }
        await sbAdmin('admin_club_links', {
          method: 'DELETE',
          params: `?admin_id=eq.${encodeURIComponent(targetId)}&club_id=eq.${encodeURIComponent(clubId)}`,
        });
        return res.status(200).json({
          success: true,
          admins: (await listClubAdmins(clubId)).map(a => ({ ...a, is_self: a.admin_id === auth.admin_id })),
        });
      }

      default:
        return res.status(400).json({ error: 'Action inconnue' });
    }
  } catch (e) {
    console.error('club-access:', e && e.message);
    return res.status(500).json({ error: 'Erreur serveur, réessaie plus tard' });
  }
}
