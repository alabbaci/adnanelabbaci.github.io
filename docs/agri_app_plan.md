# Chajra — Plan de développement
### Application mobile de diagnostic pour arbres fruitiers (olivier, oranger, citronnier, avocatier)

> **Chajra** (شجرة, « arbre ») est une application mobile qui permet à un
> agriculteur de photographier ou filmer un arbre malade et d'obtenir en
> quelques secondes un diagnostic raisonné, un plan d'action et un guide
> vidéo, en français, en arabe ou en anglais.

Ce document est le **plan**. L'implémentation qui en découle vit dans
[`app/`](../app/), le dossier de benchmarking Gemini dans
[`gemini_benchmark.md`](gemini_benchmark.md).

---

## 1. Le problème

Le verger marocain est dominé par quatre cultures pérennes qui portent
l'essentiel de la valeur : **l'olivier** (première espèce fruitière du pays),
**l'oranger** et **le citronnier** (agrumes du Souss, du Gharb et de la
Moulouya) et **l'avocatier** (culture en forte expansion sur le Loukkos et le
Gharb).

Ces quatre cultures partagent un même point de friction :

| Frein | Conséquence terrain |
|---|---|
| Le diagnostic phytosanitaire demande un œil expert | Un conseiller agricole couvre des centaines d'exploitations ; le délai de visite se compte en semaines |
| Les symptômes se ressemblent | Chlorose ferrique, salinité et pourriture racinaire donnent tous des feuilles jaunes — les traitements sont opposés |
| Le traitement arrive trop tard | Sur mouche de l'olive ou *Phytophthora*, deux semaines de retard changent l'issue de la saison |
| La documentation existe mais n'est pas mobilisable | Elle est en PDF, en français académique, et suppose qu'on sache déjà quoi chercher |

Un modèle multimodal change l'équation : il regarde l'image **et** raisonne sur
le contexte (culture, organe, région, irrigation, saison) au lieu de simplement
classer une photo dans un catalogue de labels fermé.

## 2. Le choix technique : pourquoi un modèle multimodal généraliste

L'approche classique — un CNN entraîné sur PlantVillage — bute sur trois murs
pour ce cas d'usage :

1. **Le jeu de données n'existe pas.** PlantVillage couvre surtout des cultures
   annuelles (tomate, pomme de terre, maïs) photographiées sur fond neutre en
   laboratoire. Il n'y a pas de corpus étiqueté suffisant pour l'œil de paon de
   l'olivier ou la gommose à *Phytophthora* des agrumes en conditions marocaines.
2. **Le label seul ne suffit pas.** « *Venturia oleaginea* » n'aide pas un
   agriculteur. Il lui faut : quoi faire cette semaine, avec quel produit, à
   quelle dose, et à quel moment ne pas traiter.
3. **Le contexte est décisif.** La même feuille jaune signifie une carence sur
   sol calcaire du Haouz et une salinité sur eau de forage du Loukkos.

Un modèle comme Gemini accepte **image + vidéo + texte de contexte** dans la
même requête, et rend un raisonnement lisible plutôt qu'un score. Le dossier de
benchmarking (§ [`gemini_benchmark.md`](gemini_benchmark.md)) mesure exactement
ce que cela coûte et ce que cela vaut, modèle par modèle.

## 3. Architecture retenue

```
┌───────────────────────────────────────────────┐
│  PWA mobile  (app/)                           │
│                                               │
│  Capture ──► Contexte ──► Analyse ──► Résultat│
│  photo/vidéo  culture,     Gemini     verdict │
│               organe,      structuré  + guide │
│               région                  animé   │
│                                               │
│  Base de connaissances locale (crops.json)    │
│  Historique + mode hors-ligne (IndexedDB/LS)  │
└───────────────────────────────────────────────┘
                      │ HTTPS
                      ▼
          generativelanguage.googleapis.com
```

### Décisions structurantes

| Décision | Raison |
|---|---|
| **PWA, pas d'application native** | Le parc mobile rural est majoritairement Android d'entrée de gamme ; une PWA s'installe sans passer par le Play Store, pèse quelques centaines de Ko et se met à jour instantanément. Pas de double base de code iOS/Android. |
| **Sortie JSON structurée** (`responseSchema`) | Le modèle rend un objet typé — diagnostic, confiance, différentiels, actions — et non de la prose à parser. L'interface devient déterministe. |
| **Base de connaissances locale** (`crops.json`) | Les fiches maladies, calendriers et guides sont embarqués. L'application reste utile sans réseau, et le modèle est ancré sur un référentiel vérifié plutôt que sur sa seule mémoire. |
| **Découverte des modèles à l'exécution** | Les identifiants de modèles Gemini changent tous les trimestres. L'application interroge `models.list` et propose ce qui est réellement disponible, au lieu de coder en dur un identifiant qui sera périmé. |
| **Trilingue FR / العربية / EN avec RTL** | L'arabe n'est pas une option cosmétique : c'est la langue de travail de la majorité des utilisateurs cibles. |
| **Synthèse vocale du diagnostic** | Une partie du public lit peu. Le diagnostic est lu à voix haute dans la langue choisie. |
| **Clé API côté client, stockée localement** | Convient à un usage individuel et à une démonstration publique. Pour un déploiement multi-utilisateurs, la clé passe derrière un proxy — voir § 7. |

## 4. Le rôle de la vidéo

La vidéo intervient à deux endroits, et c'est volontaire.

**En entrée** — une photo de feuille ne permet pas de juger d'un dépérissement.
L'agriculteur filme un panoramique de 10 à 15 secondes : port de l'arbre,
répartition des symptômes, sol, collet. Gemini analyse la séquence complète.
C'est ce qui permet de distinguer une attaque localisée d'un dépérissement
racinaire généralisé.

**En sortie** — le résultat n'est pas un mur de texte. L'application joue :
- la **vidéo de l'agriculteur** en regard du diagnostic, avec les points
  d'observation annotés ;
- un **guide animé** minuté, étape par étape (le geste technique : où couper,
  comment doser, où positionner un piège), avec narration vocale ;
- des **liens de recherche vidéo** vers des ressources externes, construits
  dynamiquement — jamais des identifiants figés qui pourriraient.

## 5. Parcours utilisateur

```
1. Langue          FR / العربية / EN
2. Culture         🫒 Olivier · 🍊 Oranger · 🍋 Citronnier · 🥑 Avocatier
3. Capture         1-4 photos (feuille, organe atteint, arbre entier, collet)
                   + vidéo optionnelle ≤ 15 s
4. Contexte        organe · apparition · irrigation · région · âge du verger
5. Analyse         Gemini → JSON structuré
6. Résultat        verdict + confiance + gravité
                   hypothèses alternatives (ce n'est pas un label unique)
                   actions immédiates (cette semaine)
                   traitement bio / conventionnel
                   prévention saison prochaine
                   ⚠️ seuil d'alerte « appelez un technicien »
7. Guide animé     lecture pas-à-pas + voix
8. Historique      sauvegardé hors-ligne, exportable JSON
```

## 6. Garde-fous agronomiques

L'application recommande des interventions phytosanitaires. Trois règles sont
inscrites dans le prompt système **et** dans l'interface :

1. **Aucune ordonnance.** Les matières actives sont citées comme familles
   (cuivre, spinosad, phosphonate), jamais comme marque avec une dose ferme.
   La validation passe par un produit homologué **ONSSA** et son étiquette.
2. **Le délai avant récolte est toujours affiché** quand un traitement est
   proposé sur arbre en production.
3. **Le modèle doit dire qu'il ne sait pas.** Le schéma de réponse impose un
   champ `confidence` et un champ `needs_expert` ; sous un seuil de confiance,
   l'interface affiche le renvoi vers un technicien au lieu du plan d'action.

Ces garde-fous sont testés explicitement dans le benchmark (§ « cas pièges »).

## 7. Étapes suivantes hors périmètre de cette livraison

| Étape | Pourquoi elle n'est pas ici |
|---|---|
| Proxy serveur pour la clé API | Nécessite un hébergement applicatif ; le dépôt est un site statique GitHub Pages |
| Compte utilisateur et synchronisation multi-appareils | Demande un backend et une politique de données personnelles |
| Géolocalisation et alertes de pression parasitaire | Suppose un flux de données de piégeage régional |
| Jeu de test photographique propriétaire | Doit être collecté sur le terrain, étiqueté par un agronome — le harnais de benchmark l'attend en entrée |

---

## Summary (EN)

**Chajra** is a mobile-first PWA that lets a farmer photograph or film a sick
fruit tree — olive, orange, lemon or avocado — and get a reasoned diagnosis,
an action plan and an animated how-to guide, in French, Arabic or English.

It uses a multimodal model rather than a trained classifier because the
labelled dataset for these Moroccan perennial crops does not exist, because a
Latin species name is not actionable advice, and because the same yellow leaf
means different things depending on soil, water and season — context the model
can weigh and a classifier cannot.

Video is used on both sides: a 10–15 s pan as *input* (whole-tree decline is
invisible in a leaf close-up), and an animated, narrated step-by-step guide as
*output*.

Model choice, cost per diagnosis and failure modes are measured in
[`gemini_benchmark.md`](gemini_benchmark.md), with a runnable harness at
[`scripts/benchmark_gemini.py`](../scripts/benchmark_gemini.py).
