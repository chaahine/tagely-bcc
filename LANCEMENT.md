# Stagely — checklist de mise en ligne

État au 11 septembre 2026. Remplace la version du 29 août, dont plusieurs
constats étaient devenus faux (voir « Corrections » en bas).

---

## La grille tarifaire

| | Essentiel | Pro | Réseau |
|---|---|---|---|
| | **39,90 €/mois** | **69,90 €/mois** | **99,90 €/mois** |
| Planning, dispos, portail humoriste, MC | ✅ | ✅ | ✅ |
| Humoristes | 30 | 150 | illimité |
| Personnes par club | 3 | 6 | illimité |
| Mode tournée | ✗ | ✅ | ✅ |
| Chapeau ou cachet + tableau de bord financier | ✗ | ✅ | ✅ |
| Export comptable (CSV) | ✗ | ✗ | ✅ |

**Source unique de vérité : `PLAN_CAPS` dans `api/_lib.js`.** Changer un
plafond ou déplacer une fonctionnalité d'un palier à l'autre = éditer une
ligne. Aucune route ne teste le nom d'un palier, toutes lisent les capacités.
`null` signifie illimité.

Pendant l'essai (`clubs.status = 'trial'`), un club a toujours les capacités du
palier le plus haut — on ne bride jamais une démonstration de valeur.

Tous les plafonds ne freinent que **l'ajout** : un club qui descend de palier
garde ses fiches et ses accès, il ne peut simplement plus en créer. Sans cette
nuance, un changement de palier bloquerait toute sauvegarde du club.

**La facturation est par club** (`clubs.stripe_customer_id`). Trois salles en
Pro = 209,70 €/mois. Ne jamais vendre un forfait « clubs illimités » : il
rapporterait moins que la somme des clubs.

---

## Ce qui est fait

| Sujet | État |
|---|---|
| Politique de confidentialité, CGU | ✅ `/privacy.html`, `/terms.html` |
| Suppression de compte depuis l'app (Apple 5.1.1(v)) | ✅ Réglages → Zone dangereuse |
| Fonctionnalités natives (Apple 4.2) | ✅ rappels locaux, partage, retour Android, barre d'état |
| Code de facturation Stripe | ✅ complet, 26 tests |
| Sortie de l'essai expiré | ✅ écran de réactivation au login |
| Projets natifs iOS / Android | ✅ générés, 5 plugins synchronisés |
| Chapeau, cachet, finances, export comptable, mode tournée | ✅ construits et gatés |
| Plafonds par palier | ✅ serveur, 11 tests |
| Plusieurs personnes par club | ✅ invitation, retrait, `/rejoindre.html`, 27 tests |
| Tests | ✅ 295/295 |

---

## Ce qu'il reste — Stripe (le seul vrai bloquant)

Le code est en place et **inactif** tant que les variables ne sont pas posées :
`/api/billing-config` répond `enabled: false`, aucun bouton d'abonnement ne
s'affiche, rien ne casse en attendant.

### 1. Créer les trois produits dans Stripe

Un produit par palier, en prix **récurrent mensuel**, devise EUR :

| Produit | Montant | Variable où coller le price id |
|---|---|---|
| Stagely Essentiel | 3990 centimes | `STRIPE_PRICE_ESSENTIEL` |
| Stagely Pro | 6990 centimes | `STRIPE_PRICE_PRO` |
| Stagely Réseau | 9990 centimes | `STRIPE_PRICE_RESEAU` |

Le price id ressemble à `price_1A2b3C...`. C'est **lui** qu'il faut copier, pas
l'id du produit (`prod_...`).

Un palier dont la variable reste vide n'est simplement pas proposé à l'achat —
pas d'erreur, pas de prix inventé.

### 2. Appliquer la migration Stripe dans Supabase

Coller **`stagely-stripe-schema.sql`** dans l'éditeur SQL de Supabase. Toutes
les instructions sont idempotentes, les relancer ne casse rien.

Sans elle, le lien club ↔ client Stripe est perdu : le portail de facturation
ne peut plus s'ouvrir, et un second paiement créerait un client en double.

*(Le chantier « plusieurs personnes par club » ne demande, lui, aucune
migration — l'invitation est un token signé, pas une table.)*

### 3. Poser les variables sur Vercel (production)

| Variable | Rôle |
|---|---|
| `STRIPE_SECRET_KEY` | clé secrète (`sk_live_…`) |
| `STRIPE_WEBHOOK_SECRET` | secret du webhook (`whsec_…`) |
| `STRIPE_PRICE_ESSENTIEL` | price id du palier Essentiel |
| `STRIPE_PRICE_PRO` | price id du palier Pro |
| `STRIPE_PRICE_RESEAU` | price id du palier Réseau |
| `STAGELY_PUBLIC_URL` | *(optionnel)* force le domaine des URLs de retour |

### 4. Déclarer le webhook dans Stripe

URL : `https://<domaine>/api/stripe-webhook`
Événements : `checkout.session.completed`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`.

### 5. Tester en mode test

Carte `4242 4242 4242 4242`, puis vérifier dans Supabase que `clubs.status`
passe à `active` et que `clubs.plan` correspond au palier acheté.

---

## Ce qu'il reste — le domaine

Aucun domaine Stagely n'est acheté (`vercel domains ls` ne liste que
`fairytails.fr`). L'app pointe en dur sur `https://tagely-bcc.vercel.app`
(`capacitor.config.json`, et `buildPortalLink()` dans `index.html`).

Ce n'est **pas** bloquant pour Stripe : `publicOrigin()` (`api/_stripe.js`)
retombe sur `VERCEL_URL`, et l'URL du webhook se change en dix secondes.

Ça l'est en revanche pour l'app mobile : `server.url` est gelée dans le
binaire, la changer après publication impose une nouvelle review.

Candidats vérifiés libres au 10/09/2026 : `stagely.club` (6,99 $ la 1re année
puis 18,46 $), `stagely.fr` (Vercel ne vend pas de `.fr` — passer par OVH),
`stagely.io` (30 $ puis 46 $). `stagely.com` est parké chez GoDaddy depuis
2011. **Vercel refuse l'achat de domaine par un agent** : l'achat doit être
fait à la main sur vercel.com/dashboard/domains.

---

## Ce qu'il reste — les stores (si un jour)

Rien n'a bougé depuis le 29 août :

- [ ] Compte Apple Developer (99 $/an) et Google Play Console (25 $)
- [ ] **Xcode complet** — seuls les Command Line Tools sont installés,
      `xcodebuild` est indisponible, aucune archive iOS possible
- [ ] **Java + Android Studio** — aucun runtime Java sur cette machine,
      Gradle ne peut pas démarrer
- [ ] Icône source en 1024 × 1024 (`assets/icon.png` fait 512)
- [ ] Captures d'écran, textes de fiche, `signingConfigs` Android, keystore
- [ ] Compte de démonstration pour les reviewers

**Rappel utile** : les stores ne sont pas obligatoires. `manifest.json` et
`sw.js` existent déjà — un club peut installer Stagely depuis son navigateur
(« Ajouter à l'écran d'accueil ») et obtenir l'icône et le plein écran, sans
compte développeur ni review.

---

## Décisions prises et closes

- **Le nom reste Stagely.** Un rebrand a été exploré puis écarté : le nom est
  dans l'app, les CGU, les emails et le code. ~70 domaines testés au whois,
  tous les mots métier français et le jargon stand-up sont pris.
- **Le multi-salles (deux salles dans un même lieu) n'est pas construit et ne
  sera pas vendu.** `room_id` n'existe que sur les créneaux ; `assignments`,
  `dispos` et `chapeau_entries` s'indexent sur `slot_key`, qui n'encode aucune
  salle. Deux shows en parallèle partageraient dispos et recette. Le rendre
  réel = 4 tables + contraintes d'unicité + migration + les deux UI (2-3 jours).
  Le multi-**lieux**, lui, marche déjà : un club par lieu, facturé séparément.
- **Le portail humoriste ne sera jamais gaté.** C'est le seul canal viral : un
  humoriste qui passe dans trois clubs et n'a le portail que dans un seul le
  réclamera aux deux autres.

---

## Corrections apportées à la version du 29 août

- « Le cachet, l'export comptable et le mode tournée n'existent pas encore » :
  **faux**, les quatre fonctionnalités Pro sont construites (voir le
  commentaire de `PRO_PLANS` dans `api/_lib.js`).
- « Changer le domaine après publication oblige à repasser en review » : vrai
  pour l'app mobile uniquement, pas pour Stripe ni pour le web.
- Le palier Pro n'est plus à 99 € mais à 69,90 €, et la grille compte
  désormais trois formules réellement distinctes.

---

## Points de vigilance pour une review App Store

**Apple 4.2 — Minimum Functionality.** L'app charge le site en ligne dans une
WebView : motif de rejet le plus probable. Réponses en place : rappels
programmés sur l'appareil, partage système, bouton retour Android, barre d'état
native (`native.js`). Présenter Stagely comme un outil professionnel de gestion
destiné à des structures, pas comme une app grand public.

À prévoir : avec `server.url` distant, une coupure réseau affiche l'erreur du
navigateur, pas `www/index.html`. Apple teste souvent en conditions dégradées.

**Apple 3.1.1 — achats intégrés.** Aucun paiement n'a lieu dans l'app, les
abonnements passent par Stripe hors application — autorisé pour un outil de
gestion vendu à des entreprises. Ne pas ajouter de bouton d'achat côté iOS sans
revoir ce point.

**Mentions légales.** `/terms.html` et `/privacy.html` mentionnent « Chahine
Djadel, entrepreneur individuel ». Si une société est créée, compléter avec la
forme juridique, le SIRET et l'adresse du siège — obligatoire pour un service
payant en France.
