# Jeu de test du benchmark Gemini

```
testset.example.json    modèle à copier en testset.json (versionné)
testset.json            votre jeu de test étiqueté        (ignoré par git)
images/                 vos photographies de terrain      (ignoré par git)
results/                sorties du harnais                (ignoré par git)
```

Le protocole, les métriques et la règle de décision sont décrits dans
[`docs/gemini_benchmark.md`](../../docs/gemini_benchmark.md).

Les images et les jeux de test ne sont pas versionnés : ce sont des
photographies de parcelles identifiables, et leur vérité terrain doit venir d'un
diagnostic confirmé par un agronome ou un laboratoire — pas d'une supposition.

```bash
cp testset.example.json testset.json
# déposer les photos dans images/, renseigner truth.issue_id, remplir pricing
python ../../scripts/benchmark_gemini.py --dry-run
```
