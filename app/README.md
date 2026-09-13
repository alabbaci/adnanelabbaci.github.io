# Chajra — application mobile

PWA de diagnostic pour l'**olivier**, l'**oranger**, le **citronnier** et
l'**avocatier**. L'agriculteur photographie ou filme l'arbre, l'application
interroge Gemini, et rend un diagnostic raisonné, un plan d'action et un guide
animé — en français, en arabe ou en anglais.

Le plan est dans [`docs/agri_app_plan.md`](../docs/agri_app_plan.md), le dossier
de choix du modèle dans [`docs/gemini_benchmark.md`](../docs/gemini_benchmark.md).

## Essayer

```bash
python -m http.server 8000   # depuis la racine du dépôt
```
puis ouvrez `http://localhost:8000/app/`.

Un serveur HTTP est nécessaire : les modules ES et le service worker ne
fonctionnent pas en `file://`.

**Sans clé API**, l'application tourne en *mode démonstration* : elle affiche un
diagnostic d'exemple pour chaque culture, clairement marqué comme tel, afin de
pouvoir parcourir toute l'interface. **Avec une clé** (Réglages → Clé API
Gemini, obtenue sur [aistudio.google.com](https://aistudio.google.com)), les
images sont réellement analysées.

## Ce qu'il y a dedans

| Fichier | Rôle |
|---|---|
| `index.html` | La coque : quatre vues de diagnostic, fiches, historique, réglages |
| `js/app.js` | Orchestration des vues, rendu du résultat, historique |
| `js/gemini.js` | Client REST : découverte des modèles, schéma de réponse typé, erreurs codées |
| `js/capture.js` | Redimensionnement des photos, plafond vidéo, budget de requête |
| `js/knowledge.js` | Chargement du référentiel, rapprochement verdict → fiche |
| `js/guide.js` | Lecteur pas-à-pas minuté, avec narration vocale |
| `js/i18n.js` | FR / العربية / EN, avec bascule RTL |
| `js/store.js` | localStorage : clé, modèle, langue, historique |
| `data/crops/*.json` | Le référentiel : 20 problèmes documentés sur 4 cultures |
| `data/demo.json` | Les réponses d'exemple du mode démonstration |
| `sw.js` | Cache hors-ligne de la coque et du référentiel |

## Notes d'implémentation

**La clé API vit côté client.** Elle est stockée dans le `localStorage` de
l'appareil et n'est envoyée qu'à Google. C'est acceptable pour un usage
individuel et pour une démonstration publique sur un site statique ; ce n'est
pas un schéma multi-utilisateurs. Un déploiement de production placerait un
proxy minimal entre l'application et l'API, et la clé ne quitterait jamais le
serveur.

**Les identifiants de modèles ne sont pas codés en dur.** L'application
interroge `models.list` et ne propose que ce que le compte possède réellement.
Les noms de modèles Gemini changent chaque trimestre ; en figer un garantit une
application cassée à moyen terme.

**Le référentiel est local.** Les fiches, les calendriers et les guides sont
embarqués : ils restent consultables sans réseau, et ils sont injectés dans le
prompt pour ancrer le verdict du modèle sur un label connu plutôt que sur sa
seule mémoire.

**La vidéo sert des deux côtés.** En entrée, un panoramique de 10 à 15 secondes
montre la répartition des symptômes qu'une macro de feuille ne montre pas. En
sortie, le guide rejoue les étapes du geste technique par-dessus la photo de
l'agriculteur, avec narration — ce qui fonctionne hors ligne, là où une vidéo
hébergée ne fonctionnerait pas.

## Limites connues

- Le conseil produit est **indicatif, jamais une ordonnance**. Le prompt
  interdit les marques et les doses chiffrées, et le benchmark vérifie que cette
  règle tient. La validation finale passe par un produit homologué ONSSA et son
  étiquette.
- Les réponses du mode démonstration sont en français uniquement : ce sont des
  fixtures illustrant le format, pas des traductions.
- L'historique vit dans `localStorage` et se limite aux 40 derniers diagnostics,
  vignettes comprises. Il disparaît si l'utilisateur efface les données du site.
- La synthèse vocale dépend des voix installées sur l'appareil ; l'arabe est
  absent de nombreux Android d'entrée de gamme.
