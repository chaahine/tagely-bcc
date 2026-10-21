// POST /api/owner-login   { password }
//
// Connexion de /projets.html : un seul champ, le mot de passe du compte du
// fondateur du BCC (le même que pour se connecter à Stagely). Pas d'email à
// saisir : ce tableau de bord n'a qu'un utilisateur possible, celui que
// isOwner() reconnaît.
//
// Renvoie un token admin ordinaire (30 jours), accepté par owner-signups,
// owner-fairytails et owner-emails. Même réponse générique qu'admin-login.js
// en cas d'échec.

import { applyCors, sbAdmin, verifyPasswordHash, issueAdminToken, BCC_CLUB_ID } from './_lib.js';

const GENERIC_ERROR = 'Mot de passe incorrect';
const DUMMY_HASH = '0'.repeat(64);

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { password } = req.body || {};
  if (typeof password !== 'string' || !password) return res.status(400).json({ error: 'Mot de passe requis' });

  try {
    const first = await sbAdmin('admin_club_links', {
      params: `?club_id=eq.${encodeURIComponent(BCC_CLUB_ID)}&select=admin_id,created_at&order=created_at.asc&limit=1`,
    });
    const ownerId = Array.isArray(first) && first.length ? first[0].admin_id : null;
    const rows = ownerId ? await sbAdmin('admins', {
      params: `?id=eq.${encodeURIComponent(ownerId)}&select=id,password_hash&limit=1`,
    }) : [];
    const owner = Array.isArray(rows) && rows.length ? rows[0] : null;

    // Comparaison faite même sans propriétaire trouvé, pour un temps de
    // réponse identique.
    const ok = verifyPasswordHash(password, owner ? owner.password_hash : DUMMY_HASH);
    if (!owner || !ok) return res.status(401).json({ error: GENERIC_ERROR });

    const links = await sbAdmin('admin_club_links', {
      params: `?admin_id=eq.${encodeURIComponent(owner.id)}&select=club_id`,
    });
    const ids = (Array.isArray(links) ? links : []).map(l => l.club_id);
    const clubs = ids.length ? await sbAdmin('clubs', {
      params: `?id=in.(${ids.map(encodeURIComponent).join(',')})&select=id,name`,
    }) : [];
    const accessible = (Array.isArray(clubs) ? clubs : []).map(c => ({ id: c.id, name: c.name }));
    const active = accessible.find(c => c.id === BCC_CLUB_ID) || accessible[0];
    if (!active) return res.status(401).json({ error: GENERIC_ERROR });

    const { token, exp } = issueAdminToken(owner.id, accessible, active.id, true);
    return res.status(200).json({ success: true, token, expiresAt: exp });
  } catch (e) {
    console.error('owner-login:', e && e.message);
    return res.status(500).json({ error: 'Erreur serveur, réessaie plus tard' });
  }
}
