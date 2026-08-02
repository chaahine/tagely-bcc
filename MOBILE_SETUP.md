# Stagely — mise en app native (iOS / Android) via Capacitor

Ce document explique ce qui a été préparé pour publier Stagely sur l'App
Store et Google Play, et surtout **ce qu'il reste à faire**, étape par
étape, une fois que les comptes développeur et les outils manquants seront
prêts.

## Principe retenu : coquille Capacitor + WebView distante

Stagely est une web app classique (HTML/JS/CSS servis directement par
Vercel, pas de SPA avec état offline complexe). L'approche choisie est donc
la plus simple et la plus robuste : **Capacitor génère une app native dont
la WebView charge directement `https://tagely-bcc.vercel.app` en ligne**,
plutôt que d'embarquer une copie statique des fichiers dans l'app.

Avantages de cette approche :
- Un seul déploiement à gérer (Vercel) — toute mise à jour du site est
  immédiatement visible dans l'app native, sans repasser par une
  validation App Store/Play Store pour du contenu.
- Pas de risque de désynchronisation entre plusieurs copies du code.
- L'authentification et les appels API (Supabase, Brevo, WhatsApp) qui
  dépendent du serveur continuent de fonctionner normalement, puisque tout
  se passe comme dans un navigateur classique pointé sur le vrai domaine.

C'est un pattern documenté et courant, pas un raccourci de mauvaise
qualité (cf. doc officielle Capacitor sur `server.url`).

**Conséquence pratique importante** : une connexion internet est requise
pour utiliser l'app (comme le site web aujourd'hui). Il n'y a pas de mode
hors-ligne. Si un jour Chahine veut un vrai mode offline, ce sera un
chantier à part (embarquer les assets localement + gérer la synchro
Supabase), pas traité ici.

## Ce qui a été fait dans cette branche (`mobile/capacitor-setup`)

### 1. Dépendances installées
```
@capacitor/core, @capacitor/cli, @capacitor/ios, @capacitor/android  (v8.5.0)
```
Ajoutées à `package.json` / `package-lock.json`. Aucune dépendance du site
web existant n'a été touchée (`nodemailer` reste tel quel).

### 2. `capacitor.config.json` (nouveau fichier, racine du repo)
```json
{
  "appId": "com.stagely.app",
  "appName": "Stagely",
  "webDir": "www",
  "server": {
    "url": "https://tagely-bcc.vercel.app",
    "cleartext": false
  },
  "ios": { "contentInset": "always" },
  "android": { "allowMixedContent": false }
}
```
- **App ID** : `com.stagely.app` (aucune convention de bundle ID
  n'existait ailleurs dans le repo — c'est un identifiant inversé de
  domaine standard, cohérent avec la marque produit "Stagely" plutôt
  qu'avec le club pilote BCC, ce qui a du sens vu l'objectif
  multi-clubs). **Ce choix est modifiable jusqu'à la première soumission
  App Store/Play Store, mais devient quasi impossible à changer après**
  (Apple et Google lient l'app à son identifiant définitivement). À
  valider avec Chahine avant la première soumission réelle.
- **`server.url`** pointe vers la prod Vercel actuelle. La WebView native
  navigue directement vers ce domaine au démarrage.
- **`cleartext: false`** interdit le HTTP non chiffré (Stagely est déjà
  entièrement en HTTPS, donc aucun impact).

### 3. `www/` (nouveau dossier, placeholder local minimal)
Capacitor exige un `webDir` local même en mode `server.url` (il sert de
contenu de secours si la WebView ne peut pas joindre le réseau au tout
premier lancement, et c'est ce dossier que `cap sync` copie dans les
projets natifs). Contient un unique `index.html` de chargement (fond noir,
logo Stagely, texte "Chargement de Stagely…") + copies de
`icon-192.png`/`icon-512.png`. **Ce n'est pas le site — le vrai contenu
vient toujours du serveur distant.** Aucun fichier du site existant
(`index.html`, `portal.html`, `register.html`, `api/*`) n'a été modifié.

### 4. Plateformes natives ajoutées
- `ios/` — projet Xcode généré (`App.xcodeproj`, workspace SPM). Généré
  avec succès **sans Xcode.app complet installé** — seuls les Command
  Line Tools étaient présents (`/Library/Developer/CommandLineTools`), ce
  qui a suffi pour `npx cap add ios`. La compilation réelle nécessitera en
  revanche Xcode complet (voir plus bas).
- `android/` — projet Gradle généré (`build.gradle`, `settings.gradle`,
  module `app/`). Généré avec succès sans Android Studio installé (aucun
  SDK Android détecté sur la machine — `$ANDROID_HOME` absent,
  `~/Library/Android` absent). Comme pour iOS, la génération du projet ne
  nécessite pas l'IDE ; la compilation si.
- `npx cap doctor` confirme : `[success] iOS looking great! 👌` et
  `[success] Android looking great! 👌`.

Aucune erreur bloquante à cette étape — tout ce qui pouvait être préparé
sans compte développeur ni IDE complet l'a été.

### 5. Icônes générées automatiquement
Utilisé `@capacitor/assets` (`npx capacitor-assets generate`) à partir de
`icon-512.png` (la meilleure résolution PWA existante). Résultat :
- **Android** : icônes adaptatives complètes (foreground + background,
  toutes densités ldpi→xxxhdpi) + icônes classiques + splash screens clair
  et sombre (`android/app/src/main/res/mipmap-*`, `drawable-*`).
- **iOS** : icône App Store 1024×1024 (`AppIcon.appiconset`) + splash
  screens clair/sombre (`Splash.imageset`).
- Couleur de fond appliquée aux icônes adaptatives et aux splash screens :
  `#080808` (identique au `background_color` du `manifest.json` PWA), pour
  rester cohérent avec l'identité visuelle actuelle.

**Point d'attention qualité** : la source (`icon-512.png`) ne fait que
512×512 px, alors que l'icône App Store idéale part d'un master
1024×1024 px (voire plus grand, sans compression). L'outil a
automatiquement upscalé — le résultat est fonctionnel mais **pas
optimal en netteté**. Recommandation avant soumission réelle : fournir un
fichier source `assets/icon.png` en 1024×1024 (idéalement vectoriel
exporté en haute résolution par un designer), puis relancer :
```bash
npx capacitor-assets generate
npx cap sync
```
Le dossier `assets/icon.png` (utilisé comme source) est déjà présent dans
le repo pour faciliter cette itération future.

### 6. Service worker (`sw.js`) — vérifié, pas modifié
Constat après lecture du code : **`sw.js` n'est en réalité jamais
enregistré** nulle part dans `index.html`/`portal.html`/`register.html`
(aucun appel à `serviceWorker.register(...)` trouvé). Le seul code actif
lié au service worker, dans `index.html` (lignes ~24-47), fait l'inverse :
il **désinscrit** systématiquement tout SW existant et vide les caches au
chargement, avec un commentaire explicite expliquant qu'un ancien SW
servait une version périmée en cache et bloquait le portail humoriste.

Dans le contexte Capacitor/WebView :
- Ce comportement est **sans risque** — la WebView Capacitor charge la
  page comme un navigateur normal, et ce code de désinscription
  s'exécutera pareillement (il ne fait qu'appeler des API standard
  `navigator.serviceWorker`/`caches`, disponibles dans une WebView
  moderne iOS/Android).
- Le `sessionStorage` utilisé pour éviter de re-déclencher le reload à
  chaque fois est propre à chaque session d'app — pas de comportement
  différent attendu par rapport au navigateur.
- **Aucune modification nécessaire.** Simple point de vigilance à garder
  en tête si un jour quelqu'un réactive `sw.js` (notifications push
  planifiées, cache offline) : il faudra alors retester spécifiquement
  dans la WebView native, les APIs de notification natives Capacitor
  (`@capacitor/push-notifications` / `@capacitor/local-notifications`)
  étant de toute façon le chemin recommandé plutôt que le SW web pour une
  app native.

### 7. `.gitignore` (nouveau fichier)
Ajouté pour exclure `node_modules/`, les dossiers `public/` générés
automatiquement dans `ios/`/`android/` par `cap sync` (dérivés de `www/`,
pas la peine de les committer), et les artefacts de build iOS/Android
(`Pods/`, `.gradle/`, `build/`, `xcuserdata`, `local.properties`, etc.) —
propres à chaque machine de dev et régénérés à chaque build.

### 8. Tests
`node --test tests/*.test.mjs` → **70/70 verts**, identique à l'état
avant ce chantier. Confirmé qu'aucun fichier testé (`index.html`,
`portal.html`) n'a été modifié — ce chantier n'a aucun impact sur la
logique métier existante.

## Ce qu'il reste à faire (une fois comptes + outils prêts)

### Pré-requis à obtenir
- (a) Compte **Apple Developer Program** actif (99 $/an) — en cours par
  Chahine.
- (b) Compte **Google Play Console** actif (25 $ à vie, paiement unique)
  — en cours par Chahine.
- (c) **Xcode complet** installé depuis le Mac App Store (pas seulement
  les Command Line Tools déjà présents sur cette machine).
- (d) **Android Studio** installé (fournit le SDK Android nécessaire à la
  compilation, même si le build final peut aussi se faire en ligne de
  commande avec Gradle une fois le SDK installé).

### Étape 1 — Finaliser les identités visuelles et textes App Store/Play Store
- [ ] Fournir un icône source haute résolution (1024×1024 minimum, sans
      transparence pour iOS) — idéalement via un designer, pas juste un
      upscale de l'icône PWA actuelle (512×512). Remplacer
      `assets/icon.png`, relancer `npx capacitor-assets generate` puis
      `npx cap sync`.
- [ ] Captures d'écran pour les fiches App Store / Play Store (tailles
      imposées par Apple/Google, plusieurs formats d'appareils requis).
- [ ] Textes de fiche : description courte/longue, mots-clés, catégorie
      ("Productivité" ou "Affaires" probablement), politique de
      confidentialité (URL publique requise par les deux stores — à
      rédiger si pas déjà fait), support/contact.
- [ ] Décider si le splash screen généré automatiquement (fond
      `#080808` + logo) convient tel quel ou doit être redessiné.

### Étape 2 — Compte Apple Developer + Xcode (iOS)
1. Une fois Xcode complet installé, ouvrir `ios/App/App.xcworkspace`
   (⚠️ pas `.xcodeproj` — Capacitor utilise CocoaPods/SPM, il faut
   toujours ouvrir le `.xcworkspace` s'il existe, sinon le projet SPM
   généré ici).
2. Dans Xcode, onglet **Signing & Capabilities** : sélectionner l'équipe
   de développement liée au compte Apple Developer, laisser Xcode gérer
   la signature automatique (recommandé pour démarrer) ou créer
   manuellement un certificat de distribution + provisioning profile.
3. Créer l'app dans **App Store Connect** (https://appstoreconnect.apple.com)
   avec le même Bundle ID que `capacitor.config.json` (`com.stagely.app`,
   à reconfirmer avant cette étape — voir remarque plus haut, c'est le
   dernier moment pour le changer).
4. Renseigner la fiche App Store (nom, sous-titre, description,
   captures, catégorie, politique de confidentialité, coordonnées de
   support, tarification — gratuit puisque Stagely se monétise par
   abonnement club côté web, pas via achat in-app).
5. Vérifier la conformité **App Tracking Transparency** / déclaration de
   confidentialité (Apple demande de déclarer précisément quelles
   données sont collectées — à faire avec Chahine en fonction de ce que
   Supabase/Brevo/l'app collectent réellement).
6. Build de production : `npx cap sync ios` puis dans Xcode
   *Product > Archive*, puis *Distribute App* → *App Store Connect*.
7. Soumettre à la review Apple depuis App Store Connect (délai de
   validation typique : 24h à quelques jours).

### Étape 3 — Compte Google Play + Android Studio (Android)
1. Une fois Android Studio installé, ouvrir le dossier `android/` comme
   projet Android Studio (il détectera Gradle automatiquement).
2. Générer une **clé de signature** (keystore) pour l'app — étape
   irréversible à sécuriser précieusement (perdre cette clé empêche
   toute mise à jour future de l'app sur le Play Store) :
   ```bash
   keytool -genkey -v -keystore stagely-release.keystore \
     -alias stagely -keyalg RSA -keysize 2048 -validity 10000
   ```
   Alternative recommandée par Google : activer **Play App Signing**
   (Google gère la clé de signature finale, réduit le risque de perte).
3. Configurer `android/app/build.gradle` (bloc `signingConfigs` +
   `buildTypes.release`) pour utiliser cette clé — ne **jamais** committer
   le keystore ni son mot de passe dans le repo git (utiliser des
   variables d'environnement locales ou `local.properties`, déjà exclu
   par `.gitignore`).
4. Créer l'app dans **Google Play Console**
   (https://play.google.com/console) avec le même `applicationId`
   (`com.stagely.app`).
5. Remplir la fiche Play Store (mêmes besoins que côté Apple : captures,
   description, politique de confidentialité, formulaire de
   classification du contenu, section sécurité des données).
6. Build de production :
   ```bash
   npx cap sync android
   cd android && ./gradlew bundleRelease
   ```
   Génère un `.aab` (Android App Bundle) dans
   `android/app/build/outputs/bundle/release/` — c'est le format attendu
   par Play Console (pas l'APK direct).
7. Uploader le `.aab` dans Play Console, configurer un canal de
   diffusion (interne → fermé → production), puis soumettre à la review
   Google (délai typique : quelques heures à quelques jours).

### Étape 4 — Après la première publication
- [ ] Vérifier que les mises à jour du site web (déploiements Vercel
      habituels) apparaissent bien immédiatement dans l'app native au
      prochain lancement (comportement attendu vu l'architecture
      `server.url` — mais à confirmer une fois l'app réellement
      installée sur un device).
- [ ] Décider si des fonctionnalités natives valent la peine d'être
      ajoutées plus tard (notifications push natives via
      `@capacitor/push-notifications` à la place du système de
      notification web actuel, partage natif, etc.) — hors périmètre de
      ce chantier.
- [ ] Prévoir un process de bump de version (`versionCode`/`versionName`
      Android dans `android/app/build.gradle`, `MARKETING_VERSION`/
      `CURRENT_PROJECT_VERSION` iOS dans Xcode) à chaque nouvelle
      soumission de binaire — indépendant des numéros de version `vNNN`
      utilisés pour les déploiements web, qui eux continuent de sortir
      en continu sans repasser par les stores.

## Commandes utiles pour la suite

```bash
# Après toute modif de capacitor.config.json ou de www/ :
npx cap sync

# Ouvrir le projet iOS dans Xcode (une fois Xcode installé) :
npx cap open ios

# Ouvrir le projet Android dans Android Studio (une fois installé) :
npx cap open android

# Vérifier l'état général de l'installation Capacitor :
npx cap doctor
```

## Ce qui n'a PAS été fait (volontairement, hors périmètre)

- Aucune compilation, signature ou soumission — pas de compte développeur
  disponible, pas d'Xcode/Android Studio complets sur cette machine.
- Aucun fichier du site web existant modifié (`index.html`, `portal.html`,
  `register.html`, `api/*`, `manifest.json`, `sw.js` inchangés).
- Aucun push sur `main` — tout ce travail est sur la branche
  `mobile/capacitor-setup`, à relire avant merge.
