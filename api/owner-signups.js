// POST /api/owner-signups   header: Authorization: Bearer <token admin>
//
// Tableau de bord des inscrits (page /inscrits.html), réservé à Chahine :
// tous les clubs créés sur Stagely, leur statut d'essai/abonnement, le
// compte qui les a créés et leur nombre d'humoristes.
//
// Qui y a droit : le FONDATEUR du club BCC, c'est-à-dire le premier compte
// lié au BCC dans admin_club_links. Pas de nouvelle variable
// d'environnement ni de mot de passe à part : Chahine se connecte à Stagely
// comme d'habitude, et la page réutilise sa session. Une personne invitée
// plus tard à co-administrer le BCC (api/club-access.js) n'est PAS le
// premier lien et n'y a donc pas accès — cette page expose les emails de
// tous les clubs, pas seulement ceux du BCC.
//
// Comme partout ailleurs, l'appartenance est relue EN BASE à chaque appel,
// jamais déduite du seul accessible_clubs du token.

import { applyCors, sbAdmin, verifyAdminToken, BCC_CLUB_ID } from './_lib.js';

// Le premier lien vers le BCC désigne le propriétaire de Stagely.
export async function isOwner(adminId) {
  const links = await sbAdmin('admin_club_links', {
    params: `?club_id=eq.${encodeURIComponent(BCC_CLUB_ID)}&select=admin_id,created_at&order=created_at.asc&limit=1`,
  });
  return Array.isArray(links) && links.length > 0 && links[0].admin_id === adminId;
}

// Colonnes qui ne doivent jamais quitter le serveur, même vers le propriétaire.
const SECRET_COLUMNS = ['admin_pwd_hash', 'password_hash'];

function stripSecrets(row) {
  const out = { ...row };
  for (const k of SECRET_COLUMNS) delete out[k];
  return out;
}

// select=* plutôt qu'une liste de colonnes : created_at n'est pas garanti
// sur toutes les tables (schéma créé à la main dans Supabase), et une colonne
// absente ferait échouer toute la requête PostgREST.
export async function buildSignups() {
  const [clubs, admins, links, comedians] = await Promise.all([
    sbAdmin('clubs', { params: '?select=*' }),
    sbAdmin('admins', { params: '?select=*' }),
    sbAdmin('admin_club_links', { params: '?select=*' }),
    sbAdmin('comedians', { params: '?select=club_id' }),
  ]);

  const emailById = new Map((admins || []).map(a => [a.id, a.email]));
  const comediansByClub = new Map();
  for (const c of comedians || []) {
    comediansByClub.set(c.club_id, (comediansByClub.get(c.club_id) || 0) + 1);
  }

  const rows = (clubs || []).map(club => {
    const clubLinks = (links || [])
      .filter(l => l.club_id === club.id)
      .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
    return {
      ...stripSecrets(club),
      // Date d'inscription : la colonne du club si elle existe, sinon le
      // premier lien admin (créé dans la même requête que le club).
      signed_up_at: club.created_at || (clubLinks[0] && clubLinks[0].created_at) || null,
      admins: clubLinks.map(l => emailById.get(l.admin_id) || null).filter(Boolean),
      comedians: comediansByClub.get(club.id) || 0,
      is_bcc: club.id === BCC_CLUB_ID,
    };
  });

  rows.sort((a, b) => String(b.signed_up_at || '').localeCompare(String(a.signed_up_at || '')));
  return { clubs: rows, accounts: (admins || []).length };
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
    const data = await buildSignups();
    return res.status(200).json({ success: true, generated_at: new Date().toISOString(), ...data });
  } catch (e) {
    console.error('owner-signups:', e && e.message);
    return res.status(500).json({ error: 'Erreur serveur, réessaie plus tard' });
  }
}
