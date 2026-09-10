# Stagely — textes et réponses pour les fiches App Store / Google Play

Prêt à copier-coller. Les limites de caractères sont respectées et indiquées.

---

## Identité

| Champ | Valeur |
|---|---|
| Nom de l'app | **Stagely** |
| Bundle ID / applicationId | `com.stagely.app` |
| Catégorie principale | **Productivité** (secondaire : Affaires) |
| Classification | Tout public / 3+ |
| Langue principale | Français |

---

## App Store (Apple)

**Sous-titre** — 30 caractères max
```
Le planning de votre club
```
(25 caractères)

**Mots-clés** — 100 caractères max, séparés par des virgules, sans espaces
```
comedy,club,humoriste,planning,plateau,scene,standup,dispos,spectacle,programmation,cachet
```
(91 caractères)

Ne pas répéter le nom de l'app ni la catégorie dans les mots-clés : Apple les
indexe déjà, ce serait 15 caractères gâchés.

**Description**
```
Stagely est l'outil de programmation des comedy clubs.

Fini le tableur partagé et le groupe WhatsApp où les dispos se perdent. Vos humoristes indiquent leurs disponibilités depuis leur téléphone, vous composez vos plateaux en quelques minutes, et chacun sait où il passe et quand.

CE QUE FAIT STAGELY

• Planning — Composez vos plateaux sur une grille claire, semaine après semaine. Le MC est repéré d'un coup d'œil.
• Disponibilités — Chaque humoriste remplit les siennes depuis un simple lien, sans rien installer. Vous voyez immédiatement qui est libre.
• Portail humoriste — Vos artistes consultent leurs dates, confirment leur passage et sont prévenus des annulations.
• Rappels automatiques — Une relance part avant la deadline de dispos, puis le jour même. Vous ne courez plus après personne.
• Dates hors grille — Ajoutez une tournée, une soirée exceptionnelle ou une date privée sans casser votre programmation habituelle.
• Chapeau et cachets — Enregistrez la recette de la soirée ou le cachet de chaque artiste, selon votre mode de fonctionnement.
• Tableau de bord — Revenu, taux de remplissage, artistes les plus programmés.
• Export comptable — Sortez le mois en CSV pour votre comptable.
• Plusieurs personnes — Votre équipe accède au même club, chacun avec son compte.

POUR QUI

Pour les comedy clubs, cafés-théâtres et salles qui programment régulièrement plusieurs artistes par soirée. Que vous fassiez un plateau par semaine ou quatre par soir.

ESSAI GRATUIT

30 jours, sans carte bancaire. Vous testez avec vos vraies dates et vos vrais humoristes.

TARIFS

Essentiel 39,90 €/mois — planning, dispos et portail, jusqu'à 30 humoristes.
Pro 69,90 €/mois — 150 humoristes, mode tournée, chapeau ou cachets, tableau de bord.
Réseau 99,90 €/mois — sans limite, avec export comptable.

Les abonnements se souscrivent et se gèrent sur notre site, pas dans l'application.
```

**URL de support** : à remplir avec le domaine définitif (page de contact)
**URL marketing** : idem
**Politique de confidentialité** : `https://<domaine>/privacy.html`

---

## Google Play

**Description courte** — 80 caractères max
```
Plannings, dispos et plateaux : l'outil de programmation des comedy clubs.
```
(73 caractères)

**Description complète** — 4000 caractères max
Reprendre la description App Store ci-dessus, elle passe largement.

---

## Notes pour la review (les deux stores)

À coller dans le champ « Notes pour l'examinateur ». **Indispensable** : sans
compte de test, un examinateur bloqué sur l'écran de connexion rejette l'app.

```
Stagely est un outil professionnel de gestion destiné à des structures (comedy clubs, cafés-théâtres), pas une application grand public.

Compte de démonstration :
  Email : demo@stagely.<domaine>
  Mot de passe : <à créer avant la soumission>

Ce compte contient un club de test avec des dates, des humoristes et des disponibilités déjà renseignées, afin que toutes les fonctionnalités soient visibles immédiatement.

Les abonnements ne sont pas vendus dans l'application : Stagely est un service de gestion vendu à des entreprises, la facturation se fait hors application (règle 3.1.3(b) — « Multiplatform Services » / logiciel d'entreprise).
```

**À faire avant de soumettre** : créer réellement ce compte de démonstration,
avec des données. Un club vide ne montre rien.

---

## App Privacy (Apple) / Sécurité des données (Google)

Source de vérité : `/privacy.html`, qui liste exactement ce qui est collecté.

| Donnée | Collectée | Liée à l'identité | Utilisée pour le suivi |
|---|---|---|---|
| Adresse email | Oui | Oui | Non |
| Nom | Oui | Oui | Non |
| Contenu utilisateur (plannings, dispos) | Oui | Oui | Non |
| Identifiants (compte) | Oui | Oui | Non |
| Données de localisation | Non | — | — |
| Publicité / identifiants publicitaires | Non | — | — |
| Historique de navigation | Non | — | — |

**Suivi publicitaire : aucun.** Stagely n'intègre aucun SDK publicitaire ni
d'analyse tierce — donc pas de demande ATT à prévoir côté iOS.

Finalité déclarée pour toutes les données collectées : **fonctionnement de
l'app**. Ni publicité, ni analyse, ni personnalisation.

Chiffrement en transit : oui (HTTPS). Suppression du compte possible depuis
l'app : oui (Réglages → Zone dangereuse) — c'est l'exigence Apple 5.1.1(v),
déjà satisfaite.

---

## Captures d'écran à produire

Impossible sans Xcode (simulateur iOS) ni Android Studio (émulateur).

| Store | Format | Nombre |
|---|---|---|
| App Store | iPhone 6.9″ (1320×2868) | 3 à 10 |
| App Store | iPhone 6.5″ (1242×2688) | 3 à 10 |
| Google Play | Téléphone (min. 1080 px de large) | 2 à 8 |
| Google Play | Tablette 7″ et 10″ | recommandé |
| Google Play | Icône 512×512 + bannière 1024×500 | obligatoire |

**Les quatre écrans à montrer, dans cet ordre** : le planning de la semaine,
la grille des disponibilités, le portail vu par un humoriste, le tableau de
bord financier. C'est la démonstration la plus courte du produit.

Utiliser un club de démonstration crédible — jamais de « Test test » ni de
noms d'humoristes réels sans leur accord.

---

## Checklist avant la première soumission

- [ ] Domaine définitif acheté et branché (`server.url` de `capacitor.config.json` est **gelé** dans le binaire)
- [ ] `STAGELY_PUBLIC_URL` posée sur Vercel
- [ ] Compte de démonstration créé, avec des données
- [ ] Captures d'écran produites
- [ ] Keystore Android généré et sauvegardé (le perdre interdit toute mise à jour), Play App Signing activé
- [ ] `versionCode` / `versionName` vérifiés dans `android/app/build.gradle`
- [ ] Mentions légales complétées si une société est créée (SIRET, forme juridique, siège)
