// GET /api/cron-trial-expiration — déclenché par Vercel Cron (voir
// vercel.json, crons: [{ path: "/api/cron-trial-expiration", schedule: "0 9
// * * *" }]).
//
// Contexte (audit de cohérence multitenant) : clubs.trial_ends_at est écrit à
// l'inscription self-service (api/club-signup.js, essai 30 jours) mais
// n'était vérifié nulle part — un club en essai gardait un accès illimité de
// fait, le blocage `status === 'suspended'` (déjà en place et fonctionnel,
// cf. admin-login.js et resolveClubIdByPortalCode() dans _lib.js) ne se
// déclenchant jamais tout seul. Cette route ajoute le déclencheur manquant :
// elle tourne tous les jours, repère les clubs `status = 'trial'` dont
// l'essai est dépassé depuis plus de GRACE_DAYS jours, et les passe à
// `status = 'suspended'` — même statut, même mécanisme de blocage que celui
// qui existe déjà pour une suspension manuelle.
//
// Volontairement PAS de nouveau statut ('trial_grace', 'expired', ...) : la
// grâce de 3 jours (décision produit actée) est un simple décalage de date
// dans la condition (isExpired ci-dessous), pas un état à part — on reste
// strictement sur les 3 valeurs déjà utilisées ailleurs dans le code
// (trial/active/suspended).
//
// Un club déjà passé à 'active' (paiement / activation manuelle par Chahine)
// n'est JAMAIS concerné : le filtre `status=eq.trial` l'exclut d'office, quel
// que soit son trial_ends_at (qui peut être une vieille date jamais nettoyée
// après l'activation — sans importance, elle n'est plus lue une fois que
// status != 'trial'). Le club BCC est `status = 'active'` depuis l'étape C,
// donc jamais concerné non plus.
//
// Hors scope volontairement : pas de vraie facturation (Stripe), pas d'email
// d'avertissement avant/pendant la grâce — juste le garde-fou d'accès qui
// manquait. À construire plus tard si besoin.
//
// Sécurité : même garde que cron-dispo-reminders.js — CRON_SECRET réutilisé
// tel quel (pas de nouvelle variable d'environnement), pas de repli permissif
// si la variable est absente.

import { sbAdmin } from './_lib.js';

// Marge après trial_ends_at avant suspension effective — décision produit
// déjà actée (voir doc de tarification), pour ne jamais couper l'accès pile
// à J+30 sans avertissement.
export const GRACE_DAYS = 3;

// Logique métier isolée de l'auth/HTTP — appelée par le handler avec
// now = new Date() en prod, et directement par les tests avec une date
// injectée (déterministe, indépendant du jour réel d'exécution des tests).
export function isExpired(club, now) {
  if (!club || club.status !== 'trial' || !club.trial_ends_at) return false;
  const trialEndMs = new Date(club.trial_ends_at).getTime();
  if (Number.isNaN(trialEndMs)) return false;
  const cutoffMs = now.getTime() - GRACE_DAYS * 24 * 60 * 60 * 1000;
  return trialEndMs <= cutoffMs;
}

export async function runTrialExpiration(now) {
  // Uniquement les clubs encore en essai — un club 'active' ou déjà
  // 'suspended' n'est jamais touché par ce cron.
  const clubs = await sbAdmin('clubs', {
    params: '?status=eq.trial&select=id,name,trial_ends_at',
  });

  const suspended = [];
  for (const club of clubs || []) {
    if (!isExpired(club, now)) continue;
    await sbAdmin('clubs', {
      method: 'PATCH',
      params: `?id=eq.${encodeURIComponent(club.id)}`,
      body: { status: 'suspended' },
    });
    suspended.push({ id: club.id, name: club.name, trial_ends_at: club.trial_ends_at });
  }

  return { checked: (clubs || []).length, suspendedCount: suspended.length, suspended };
}

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: 'CRON_SECRET manquant côté serveur — route désactivée par sécurité' });
  }
  const authHeader = req.headers['authorization'] || '';
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Non autorisé' });
  }

  try {
    const result = await runTrialExpiration(new Date());
    return res.status(200).json({ success: true, ...result });
  } catch (e) {
    return res.status(500).json({ success: false, error: e.message });
  }
}
