# Severity guide

| Situation                                                  | Severity                                        | Code                         |
| ---------------------------------------------------------- | ----------------------------------------------- | ---------------------------- |
| Claim without an approved fact                             | blocking                                        | `unsupported_claim`          |
| Fact revoked or outside its validity window                | blocking                                        | `fact_not_effective`         |
| Policy prohibited term or brand prohibited phrase          | blocking                                        | `prohibited_term`            |
| Restricted topic mentioned                                 | blocking (warning when policy says review-only) | `restricted_topic`           |
| Protected element changed                                  | blocking                                        | `protected_element_modified` |
| Logo below minimum width or on a disallowed background     | blocking                                        | `logo_rule`                  |
| Text below the token minimum size or contrast below target | blocking                                        | `legibility`                 |
| Colour or font outside the tokens                          | warning                                         | `token_drift`                |
| Avoided term, tone drift                                   | warning                                         | `voice_drift`                |
| Missing CTA, hashtag count above guidance                  | note                                            | `guidance`                   |
