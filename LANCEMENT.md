# Stagely — checklist de mise en ligne

État au 29 août 2026, après le chantier de conformité v225–v229.

Ce document remplace la section « ce qu'il reste à faire » de
`MOBILE_SETUP.md`, qui décrivait l'état du dépôt avant ce chantier.

---

## Ce qui est fait

| Sujet | État |
|---|---|
| Politique de confidentialité publique | ✅ `/privacy.html` |
| Conditions générales | ✅ `/terms.html` |
| Suppression de compte depuis l'app (Apple 5.1.1(v)) | ✅ Réglages → Zone dangereuse |
| Fonctionnalités natives (Apple 4.2) | ✅ rappels locaux, partage, retour Android, barre d'état |
| Facturation et résiliation | ✅ Stripe Checkout + portail client |
| Sortie de l'essai expiré | ✅ écran de réactivation au login |
| Dé-branding du club pilote | ✅ plus aucun « BCC » en dur |
| Projets natifs iOS / Android | ✅ générés, 5 plugins synchronisés |
| Tests | ✅ 252/252 |

---

## Ce qu'il reste — par ordre de blocage

### 1. Comptes et outils (aucun contournement possible)

- [ ] **Compte Apple Developer** — 99 $/an, comptez 24–48 h de validation.
- [ ] **Compte Google Play Console** — 25 $ une fois.
- [ ] **Xcode complet** depuis le Mac App Store. Seuls les Command Line
      Tools sont installés : `xcodebuild` est indisponible, donc aucune
      compilation ni archive iOS n'est possible aujourd'hui.
- [ ] **Java + Android Studio** — aucun runtime Java n'est installé sur
      cette machine (`java -version` échoue) : Gradle ne peut pas démarrer.
      Android Studio installe les deux.

### 2. Stripe — avant de pouvoir encaisser

Le code est en place et inactif tant que les variables ne sont pas posées :
`/api/billing-config` répond `enabled: false` et aucun bouton d'abonnement
ne s'affiche. Rien ne casse en attendant.

1. Créer les produits et les prix mensuels dans le tableau de bord Stripe
   (le palier Pro est annoncé à 99 €/mois dans l'app — à confirmer, et les
   tarifs Essentiel et Réseau restent à décider).
2. Appliquer la migration **`stagely-stripe-schema.sql`** dans l'éditeur SQL
   de Supabase. Sans elle, le lien club ↔ client Stripe est perdu : le
   portail de facturation ne peut plus s'ouvrir et un second paiement
   créerait un client en double.
3. Poser les variables d'environnement sur Vercel (production) :

   | Variable | Rôle |
   |---|---|
   | `STRIPE_SECRET_KEY` | clé secrète (`sk_live_…`) |
   | `STRIPE_WEBHOOK_SECRET` | secret du webhook (`whsec_…`) |
   | `STRIPE_PRICE_PRO` | price id du palier Pro |
   | `STRIPE_PRICE_RESEAU` | price id du palier Réseau |
   | `STRIPE_PRICE_ESSENTIEL` | *(optionnel)* — non renseigné = palier non vendu en ligne |
   | `STAGELY_PUBLIC_URL` | *(optionnel)* — force le domaine des URLs de retour |

4. Déclarer le webhook dans Stripe : URL `https://<domaine>/api/stripe-webhook`,
   événements `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`.
5. Tester en mode test avec la carte `4242 4242 4242 4242`, puis vérifier
   dans Supabase que `clubs.status` passe bien à `active`.

### 3. Domaine — à faire AVANT la première soumission

L'app native pointe en dur sur `https://tagely-bcc.vercel.app`
(`capacitor.config.json`, `server.url`). Changer cette URL après publication
oblige à soumettre un nouveau binaire et à repasser en review.

- [ ] Acheter le domaine et le brancher sur Vercel.
- [ ] Mettre à jour `server.url` dans `capacitor.config.json`, puis
      `npx cap sync`.
- [ ] Renseigner `STAGELY_PUBLIC_URL` sur Vercel.

Même remarque pour le **bundle ID** `com.stagely.app` : modifiable jusqu'à
la première soumission, définitif ensuite.

### 4. Icône et captures

- [ ] **Icône source en 1024 × 1024**, sans transparence. La source actuelle
      (`assets/icon.png`) ne fait que 512 × 512 : l'icône App Store est un
      upscale, fonctionnel mais peu net. Remplacer le fichier puis :
      `npx capacitor-assets generate && npx cap sync`.
- [ ] Captures d'écran : iPhone 6.9″ et 6.5″, Android téléphone et tablette.
- [ ] Textes de fiche : description courte et longue, mots-clés, catégorie
      (Productivité ou Affaires), URL de support.

### 5. Android — publication

1. Générer la clé de signature — **à sauvegarder précieusement, la perdre
   interdit toute mise à jour future** :
   ```bash
   keytool -genkey -v -keystore stagely-release.keystore \
     -alias stagely -keyalg RSA -keysize 2048 -validity 10000
   ```
   Activer **Play App Signing** en parallèle : Google conserve alors la clé
   finale et le risque de perte disparaît.
2. Ajouter `signingConfigs` + `buildTypes.release` dans
   `android/app/build.gradle`. Ni le keystore ni son mot de passe ne doivent
   être commités — `local.properties` est déjà exclu par `.gitignore`.
3. Créer l'app dans Play Console avec l'`applicationId` `com.stagely.app`.
4. Remplir la fiche, le questionnaire de classification et la section
   **Sécurité des données** — s'appuyer sur `/privacy.html`, qui liste
   exactement ce qui est collecté et transmis.
5. Compiler et publier :
   ```bash
   npx cap sync android
   cd android && ./gradlew bundleRelease
   ```
   Le `.aab` sort dans `android/app/build/outputs/bundle/release/`. Passer
   par un canal interne, puis fermé, avant la production.

### 6. iOS — publication

1. Ouvrir `ios/App/App.xcodeproj` dans Xcode, onglet **Signing &
   Capabilities**, sélectionner l'équipe et laisser la signature
   automatique.
2. Créer l'app dans App Store Connect avec le même bundle ID.
3. Remplir **App Privacy** — même source que pour Google : `/privacy.html`.
4. `npx cap sync ios`, puis *Product → Archive → Distribute App*.
5. Dans les notes pour la review, joindre **un compte de démonstration**
   (email + mot de passe d'un club de test avec des données) : sans ça, un
   reviewer bloqué sur l'écran de connexion rejette l'app.

---

## Points de vigilance pour la review

**Apple 4.2 — Minimum Functionality.** L'app charge le site en ligne dans
une WebView. C'est le motif de rejet le plus probable. Ce qui a été mis en
place pour y répondre : rappels programmés sur l'appareil, partage système,
bouton retour Android, barre d'état native (voir `native.js`). Dans les
notes de review, présenter Stagely comme un **outil professionnel de gestion
destiné à des structures**, pas comme une app grand public — c'est la
catégorie pour laquelle Apple accepte ce pattern. Si un rejet survient
malgré tout, la réponse la plus efficace est d'ajouter de vraies
notifications push serveur (Firebase pour Android, APNs pour iOS).

**Apple 3.1.1 — achats intégrés.** Aucun paiement n'a lieu dans l'app : les
abonnements passent par Stripe hors application, ce qui est autorisé pour un
outil de gestion vendu à des entreprises. Ne pas ajouter de bouton d'achat
ni de lien de paiement dans la version iOS sans revoir ce point.

**Mentions légales.** `/terms.html` et `/privacy.html` mentionnent
« Chahine Djadel, entrepreneur individuel ». Si une société est créée,
compléter avec la forme juridique, le SIRET et l'adresse du siège — ces
mentions sont obligatoires pour un service payant en France.

---

## Variables d'environnement — récapitulatif

| Variable | Statut | Rôle |
|---|---|---|
| `SUPABASE_SERVICE_KEY` | déjà posée | accès base de données |
| `ADMIN_TOKEN_SECRET` | déjà posée | signature des sessions admin |
| `BREVO_API_KEY` | déjà posée | emails transactionnels |
| `STRIPE_SECRET_KEY` | **à poser** | facturation |
| `STRIPE_WEBHOOK_SECRET` | **à poser** | vérification des webhooks |
| `STRIPE_PRICE_PRO` | **à poser** | prix du palier Pro |
| `STRIPE_PRICE_RESEAU` | **à poser** | prix du palier Réseau |
| `STRIPE_PRICE_ESSENTIEL` | optionnel | prix du palier Essentiel |
| `STAGELY_PUBLIC_URL` | optionnel | domaine définitif |
