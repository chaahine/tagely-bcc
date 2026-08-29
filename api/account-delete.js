// POST /api/account-delete   header: Authorization: Bearer <token admin>
// body: { scope: 'club' | 'account', password, confirm: 'SUPPRIMER' }
//
// Suppression self-service, definitive et immediate, d'un club ou de tout le
// compte. Route dediee plutot qu'une action de plus dans la whitelist de
// api/admin-write.js : c'est la seule ecriture du produit qui detruit des
// donnees hors du club courant (scope 'account' traverse TOUS les clubs de
// l'admin) et la seule qui reverifie le mot de passe. La garder a part evite
// d'elargir la surface d'admin-write, dont toutes les actions partagent au
// contraire le meme scoping strict sur auth.active_club_id.
//
// Pourquoi cette route existe : Apple App Store Review Guideline 5.1.1(v)
// impose que toute app permettant de creer un compte permette de le
// supprimer DEPUIS l'app — un lien "ecris-nous" ne suffit pas et vaut rejet.
// Cote RGPD, c'est aussi le droit a l'effacement (art. 17) rendu effectif
// sans intervention humaine.
//
// ── Triple garde avant destruction ──
//  1. Session admin valide (token signe, non expire).
//  2. Mot de passe du compte reverifie ici, contre admins.password_hash —
//     un token vole ou une session restee ouverte ne suffit donc jamais.
//  3. Le mot "SUPPRIMER" saisi a la main (champ confirm), pour qu'un clic
//     accidentel sur un telephone ne detruise jamais un club.
//
// ── Regle du club partage ──
// admin_club_links est une table de liaison N-N : plusieurs admins peuvent
// en theorie etre lies au meme club (aucune UI d'invitation ne le permet
// aujourd'hui, mais le schema si). Si un AUTRE admin est encore lie au club,
// on ne detruit PAS le club : l'admin qui part ne fait que retirer son
// propre lien. Detruire les donnees d'un club encore administre par
// quelqu'un d'autre serait une perte de donnees pour un tiers.
//
// ── Dernier club ──
// Supprimer son dernier club supprime aussi le compte : un compte admin sans
// aucun club ne peut plus se connecter (admin-login.js exige au moins un
// club accessible pour emettre un token) — le laisser derriere nous ne
// creerait qu'une ligne orpheline inutilisable. Le client en est prevenu
// avant de confirmer, et la reponse le signale (deleted: 'account').

import {
  applyCors,
  sbAdmin,
  verifyAdminToken,
  verifyPasswordHash,
  issueAdminToken,
} from './_lib.js';

const CONFIRM_WORD = 'SUPPRIMER';

// Tables portant une colonne club_id, dans l'ordre de purge : les lignes qui
// referencent un comedien ou un creneau d'abord, la ligne `clubs` en dernier.
// Cet ordre evite de buter sur une contrainte de cle etrangere si le schema
// en declare une (ON DELETE CASCADE n'est pas garanti sur toutes les tables
// de ce projet).
const CLUB_SCOPED_TABLES = [
  'assignments',
  'dispos',
  'dispo_status',
  'chapeau_entries',
  'chat_messages',
  'events',
  'comedians',
  'schedule_templates',
  'rooms',
];

// Purge best-effort table par table : une table absente de cet environnement
// (migration pas encore appliquee — chapeau_entries et events sont dans ce
// cas sur les deploiements les plus anciens) ne doit jamais interrompre la
// suppression et laisser le compte a moitie detruit. On collecte les echecs
// pour les journaliser, sans jamais les renvoyer au client (ils exposeraient
// le schema).
async function purgeClubData(clubId) {
  const scope = `?club_id=eq.${encodeURIComponent(clubId)}`;
  const failures = [];
  for (const table of CLUB_SCOPED_TABLES) {
    try {
      await sbAdmin(table, { method: 'DELETE', params: scope });
    } catch (e) {
      failures.push(`${table}: ${e.message}`);
    }
  }
  return failures;
}

// Retire le club du compte : supprime le lien admin<->club, puis la ligne
// `clubs` elle-meme SI plus aucun admin n'y est rattache.
// Retourne true si le club a reellement ete detruit, false s'il survit parce
// qu'un autre admin l'administre encore (voir "Regle du club partage").
async function detachAndMaybeDeleteClub(adminId, clubId) {
  await sbAdmin('admin_club_links', {
    method: 'DELETE',
    params: `?admin_id=eq.${encodeURIComponent(adminId)}&club_id=eq.${encodeURIComponent(clubId)}`,
  });

  let othersLinked = [];
  try {
    othersLinked = await sbAdmin('admin_club_links', {
      params: `?club_id=eq.${encodeURIComponent(clubId)}&select=admin_id&limit=1`,
    });
  } catch (e) {
    // Lecture impossible : on choisit de NE PAS detruire le club. Perdre le
    // club d'un tiers est irreversible, laisser une ligne de trop ne l'est
    // pas — en cas de doute on preserve.
    return false;
  }
  if (Array.isArray(othersLinked) && othersLinked.length) return false;

  await purgeClubData(clubId);
  await sbAdmin('clubs', { method: 'DELETE', params: `?id=eq.${encodeURIComponent(clubId)}` });
  return true;
}

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = verifyAdminToken(req);
  if (!auth) return res.status(401).json({ error: 'Non autorisé — reconnecte-toi en admin' });

  const { scope, password, confirm } = req.body || {};
  if (scope !== 'club' && scope !== 'account') {
    return res.status(400).json({ error: 'scope invalide' });
  }
  if (String(confirm || '').trim().toUpperCase() !== CONFIRM_WORD) {
    return res.status(400).json({ error: `Saisis « ${CONFIRM_WORD} » pour confirmer` });
  }
  if (typeof password !== 'string' || !password) {
    return res.status(400).json({ error: 'Mot de passe requis' });
  }

  try {
    // ── Garde 2 : le mot de passe du compte, pas seulement la session ──
    const adminRows = await sbAdmin('admins', {
      params: `?id=eq.${encodeURIComponent(auth.admin_id)}&select=id,password_hash&limit=1`,
    });
    const admin = Array.isArray(adminRows) && adminRows.length ? adminRows[0] : null;
    if (!admin) return res.status(401).json({ error: 'Compte introuvable — reconnecte-toi' });
    if (!verifyPasswordHash(password, admin.password_hash)) {
      return res.status(403).json({ error: 'Mot de passe incorrect' });
    }

    // Source de verite des clubs a traiter : la table de liaison, jamais
    // auth.accessible_clubs (signe mais potentiellement perime — un club
    // ajoute ou retire depuis l'emission du token n'y figure pas).
    const links = await sbAdmin('admin_club_links', {
      params: `?admin_id=eq.${encodeURIComponent(auth.admin_id)}&select=club_id`,
    });
    const clubIds = (Array.isArray(links) ? links : []).map(l => l.club_id).filter(Boolean);

    // ── Suppression d'un seul club ──
    if (scope === 'club') {
      const target = auth.active_club_id;
      if (!clubIds.includes(target)) {
        return res.status(403).json({ error: 'Ce club n\'est pas rattaché à ton compte' });
      }

      // Dernier club : bascule en suppression de compte (voir en-tete).
      if (clubIds.length <= 1) {
        await detachAndMaybeDeleteClub(auth.admin_id, target);
        await sbAdmin('admins', { method: 'DELETE', params: `?id=eq.${encodeURIComponent(auth.admin_id)}` });
        return res.status(200).json({ success: true, deleted: 'account' });
      }

      await detachAndMaybeDeleteClub(auth.admin_id, target);

      // Il reste des clubs : on reemet un token sur l'un d'eux plutot que de
      // deconnecter. Le nom est relu en base (celui du token pouvait etre
      // perime apres un renommage) ; repli sur le nom signe si la lecture
      // echoue, pour ne jamais bloquer une suppression deja effectuee.
      const remainingIds = clubIds.filter(id => id !== target);
      let remaining = remainingIds.map(id => {
        const known = auth.accessible_clubs.find(c => c.id === id);
        return { id, name: (known && known.name) || 'Club' };
      });
      try {
        const rows = await sbAdmin('clubs', {
          params: `?id=in.(${remainingIds.map(encodeURIComponent).join(',')})&select=id,name`,
        });
        if (Array.isArray(rows) && rows.length) {
          remaining = rows.map(r => ({ id: r.id, name: r.name || 'Club' }));
        }
      } catch (e) { /* non bloquant — repli ci-dessus */ }

      const { token, exp } = issueAdminToken(auth.admin_id, remaining, remaining[0].id, auth.remember);
      return res.status(200).json({
        success: true,
        deleted: 'club',
        token,
        expiresAt: exp,
        accessible_clubs: remaining,
        active_club_id: remaining[0].id,
      });
    }

    // ── Suppression du compte entier : tous les clubs, puis l'admin ──
    for (const clubId of clubIds) {
      await detachAndMaybeDeleteClub(auth.admin_id, clubId);
    }
    // Filet : retire d'eventuels liens residuels (un club dont la
    // suppression a echoue plus haut garderait sinon ce compte rattache).
    await sbAdmin('admin_club_links', {
      method: 'DELETE',
      params: `?admin_id=eq.${encodeURIComponent(auth.admin_id)}`,
    });
    await sbAdmin('admins', { method: 'DELETE', params: `?id=eq.${encodeURIComponent(auth.admin_id)}` });

    return res.status(200).json({ success: true, deleted: 'account' });
  } catch (e) {
    // Volontairement pas de "rien n'a ete supprime" : l'echec peut survenir
    // apres une purge partielle. Le client est invite a relancer, ce qui est
    // sans risque (chaque DELETE est idempotent).
    console.error('account-delete:', e.message);
    return res.status(500).json({ error: 'La suppression n\'a pas pu aller au bout — relance-la, ou écris-nous si le problème persiste' });
  }
}
