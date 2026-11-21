# Agent evaluation

`citytwin eval` runs the golden questions below against the built feature store.
Routing is scored against the expected first tool; groundedness asserts that the
answer contains the quantity the tool returned. Both are deliberately strict and
cheap: they catch a planner that picks the wrong query and an answer that does not
carry its own numbers.

| Metric | Value |
|---|---|
| Tasks | 12 |
| Routing accuracy | 100% |
| Grounded pass rate | 100% |
| Mean tool calls per question | 1.08 |
| Mean latency (s) | 0.02 |
| Share answered by the deterministic planner | 100% |

| ID | Question | First tool | Routed | Grounded | Time |
|---|---|---|---|---|---|
| G01 | How stable are the heat hotspots once height uncertainty is propagated? | uncertainty_report | yes | yes | 0.01 s |
| G02 | Which cells are robust hotspots at 80% probability? | hotspot_report | yes | yes | 0.07 s |
| G03 | What is the height model accuracy and why was it chosen? | height_profile | yes | yes | 0.00 s |
| G04 | Where should new tree planting be prioritised? | greening_candidates | yes | yes | 0.00 s |
| G05 | What building typologies exist in the study area? | typology_profile | yes | yes | 0.00 s |
| G06 | Show me the tallest buildings. | list_tall_buildings | yes | yes | 0.05 s |
| G07 | Can I reproduce these outputs from the provenance record? | provenance_check | yes | yes | 0.01 s |
| G08 | What data is in the twin and under which licence? | dataset_card | yes | yes | 0.00 s |
| G09 | Summarise exposure across the whole study area. | area_summary | yes | yes | 0.05 s |
| G10 | Explain cell C12. | explain_cell | yes | yes | 0.00 s |
| G11 | Is the exposure index sensitive to the weights I chose? | area_summary | yes | yes | 0.05 s |
| G12 | How many buildings are taller than 15 m? | list_tall_buildings | yes | yes | 0.04 s |

## What is not evaluated

- Free-form LLM answers. The LLM hook in `citytwin.agent.planner` is optional and its
  output is validated against the tool schemas before execution; without a key the
  deterministic router is used and this table is reproducible in CI.
- Spatial correctness of the index itself. That is covered by the analytics tests
  and the model card, not by the agent harness.
- Multi-turn dialogue. The runner answers single questions; state is passed by the
  client, not accumulated by the service.

## Reading the failures

A routing miss means the question did not match any tool intent — the honest fix is
a new tool or a better description, not a looser keyword list. A groundedness miss
with correct routing means the tool answered a different question than the one
asked; that is the case worth investigating first.
