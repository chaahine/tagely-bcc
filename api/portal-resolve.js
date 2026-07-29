// POST /api/portal-resolve   body: { code }
// Réponse : { success: true, club_id } ou 403 si code invalide/club suspendu.
//
// Chantier multitenant, étape D — le portail humoriste (portal.html) n'a pas
// de token admin, seulement le "code" d'accès lu dans l'URL. Jusqu'ici, ce
// code n'était résolu en club_id que côté serveur au moment d'une ÉCRITURE
// (api/portal-write.js) — les LECTURES directes vers Supabase (clé anon)
// n'étaient filtrées par aucun club_id, sans risque tant qu'un seul club
// existait. Cette route, publique et strictement en lecture, permet au
// portail de récupérer son club_id une fois au chargement pour scoper
// ensuite toutes ses lectures directes (comedians, assignments, dispos,
// schedule_templates) — voir sb()/getClubId() dans portal.html.
//
// Volontairement minimal : ne retourne que l'id, jamais le reste de la ligne
// clubs (admin_pwd_hash notamment). Réutilise la même résolution que
// portal-write.js (voir resolveClubIdByPortalCode() dans _lib.js) pour ne
// jamais faire diverger la définition de "code valide" entre les deux
// routes.

import { applyCors, resolveClubIdByPortalCode } from './_lib.js';

export default async function handler(req, res) {
  applyCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const code = (req.body || {}).code;

  try {
    const clubId = await resolveClubIdByPortalCode(code);
    if (!clubId) {
      return res.status(403).json({ error: 'Code d\'accès invalide' });
    }
    return res.status(200).json({ success: true, club_id: clubId });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
