// POST /api/switch-club  header: Authorization: Bearer <token admin>
// body: { club_id }
//
// Change le club "actif" de la session courante SANS re-demander email/mot
// de passe (sélecteur multi-club façon "workspace switcher") — chantier
// multitenant "multi-club-admin". Émet un NOUVEAU token portant le même
// admin_id/accessible_clubs que le token actuel, mais un active_club_id
// différent — et la MÊME durée de session (remember-me) que le token
// d'origine (auth.remember, cf. commentaire d'issueAdminToken dans _lib.js) :
// switcher de club ne doit jamais dégrader silencieusement une session
// "se souvenir de moi" en session courte de 12h.
//
// Renvoie aussi le détail complet du nouveau club actif — { id, name, city,
// portal_code, dispo_deadline_day }, même forme que /api/admin-login — pour
// que applyClubInfo() (index.html) s'applique directement après un switch,
// sans requête supplémentaire ni repasser par l'écran de login.
//
// Sécurité : ne fait JAMAIS confiance uniquement au token pour autoriser le
// switch, même si `club_id` apparaît déjà dans `accessible_clubs` (signé,
// donc non falsifiable côté client). On revérifie systématiquement contre
// admin_club_links EN BASE : ça protège du cas où un accès a été révoqué
// (suppression du lien, ou club suspendu) après l'émission du token mais
// avant son expiration (jusqu'à 30 jours avec remember-me) — sans cette
// revérification, un token déjà émis continuerait de permettre le switch
// vers un club dont l'accès a été retiré entre-temps. Même philosophie de
// défiance que le reste du projet (cf. resolveClubIdByPortalCode() dans
// api/_lib.js).

import { applyCors, sbAdmin, verifyAdminToken, issueAdminToken, isNonEmptyString } from './_lib.js';

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = verifyAdminToken(req);
  if (!auth) {
    return res.status(401).json({ error: 'Non autorisé — reconnecte-toi en admin' });
  }

  const { club_id } = req.body || {};
  if (!isNonEmptyString(club_id, 100)) {
    return res.status(400).json({ error: 'club_id requis' });
  }

  // Premier filtre, bon marché : le club demandé doit déjà figurer dans la
  // liste accessible du token actuel (déjà signée/vérifiée ci-dessus).
  const inToken = auth.accessible_clubs.some((c) => c.id === club_id);
  if (!inToken) {
    return res.status(403).json({ error: 'Ce club n\'est pas accessible depuis ce compte' });
  }

  try {
    // Deuxième filtre, celui qui compte réellement : re-vérification EN BASE
    // que le lien existe toujours (jamais une confiance aveugle au token).
    const links = await sbAdmin('admin_club_links', {
      params: `?admin_id=eq.${encodeURIComponent(auth.admin_id)}&club_id=eq.${encodeURIComponent(club_id)}&select=club_id&limit=1`,
    });
    if (!Array.isArray(links) || !links.length) {
      return res.status(403).json({ error: 'Ce club n\'est pas accessible depuis ce compte' });
    }

    // Un club peut être devenu suspendu après l'émission du token courant, ou
    // ses infos ont changé depuis — on relit toujours la ligne fraîche plutôt
    // que de réutiliser le nom déjà présent dans accessible_clubs.
    let rows;
    try {
      rows = await sbAdmin('clubs', {
        params: `?id=eq.${encodeURIComponent(club_id)}&select=id,status,name,city,portal_code,dispo_deadline_day&limit=1`,
      });
    } catch (e) {
      rows = await sbAdmin('clubs', {
        params: `?id=eq.${encodeURIComponent(club_id)}&select=id,status,name,city,portal_code&limit=1`,
      });
    }
    const club = Array.isArray(rows) && rows.length ? rows[0] : null;
    if (!club || club.status === 'suspended') {
      return res.status(403).json({ error: 'Ce club est suspendu' });
    }

    const { token, exp } = issueAdminToken(auth.admin_id, auth.accessible_clubs, club_id, auth.remember);
    return res.status(200).json({
      success: true,
      token,
      expiresAt: exp,
      club: {
        id: club.id,
        name: club.name,
        city: club.city,
        portal_code: club.portal_code,
        dispo_deadline_day: Number.isFinite(club.dispo_deadline_day) ? club.dispo_deadline_day : 12,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
