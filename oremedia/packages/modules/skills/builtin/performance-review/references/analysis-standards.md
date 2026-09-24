# Analysis standards

- Compare like with like: same metric definition version, same channel set, same window length.
- Report the base: a rate without its denominator is not an insight.
- Freshness: state the newest snapshot date behind the insight; if older than the period end by more than the
  metric's collection interval, say "as of <date>".
- Completeness: when a snapshot's completeness is below 100%, the insight says which days or channels are
  missing.
- Observational language: "coincided with", "was higher during", "correlates with". Causal language only for
  experiments that reached their stop rule.
- Small numbers: below the minimum sample the brand's analyst set (default 200 events), report the observation as
  `low` confidence and recommend an experiment rather than a change.
