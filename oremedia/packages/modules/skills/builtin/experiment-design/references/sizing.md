# Sizing

Standard settings unless the brand's analyst has set others in the playbook:

- Significance 0.05 (two-sided), power 0.8.
- Minimum detectable effect: the relative lift the recommendation implies; when it states none, use 10% relative
  and say so in a finding.
- Sample size per variant for a proportion metric with baseline p and relative MDE r:
  n ≈ 2 × (1.96 + 0.84)² × p(1 − p) / (p × r)².
- Duration in days = ceil(n × variants / (eventsPerWeek / 7)), rounded up to whole weeks so weekday effects
  balance.
- Feasible when duration ≤ available weeks × 7 and n ≥ the minimum sample the analyst set (default 200 events per
  variant).
- Guardrail breach threshold: a relative drop of 5% on any guardrail metric with at least the same sample stops
  the experiment.
