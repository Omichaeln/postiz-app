# Brand system document fields (spec 8.1)

| Field                     | What to put there                                                                | Source evidence you need           |
| ------------------------- | -------------------------------------------------------------------------------- | ---------------------------------- |
| `voice.summary`           | Two or three sentences describing how the brand speaks                           | Guideline text, about page         |
| `voice.tone`              | Up to 12 adjectives used by the material itself                                  | Guideline text                     |
| `voice.audiences`         | Key + description per audience the material names                                | Guideline or strategy document     |
| `voice.preferredTerms`    | `{ use, avoid[] }` pairs stated in the material                                  | Terminology section                |
| `voice.prohibitedPhrases` | Phrases the material forbids                                                     | Do/don't lists                     |
| `voice.examples`          | Quoted examples with an on_brand / off_brand verdict                             | Guideline examples                 |
| `tokens.colours`          | `{ key, value, role }` with hex values as written                                | Colour section                     |
| `tokens.typeRoles`        | `{ role, fontAssetId, weight, minSizePx }` bound to eligible font assets         | Typography section + asset library |
| `logoRules`               | `{ assetId, variant, allowedBackgroundColourKeys, clearSpaceRatio, minWidthPx }` | Logo section + asset library       |
| `patterns`                | Named layout or imagery patterns with example asset ids                          | Layout or imagery section          |
| `channelGuidance`         | Per provider: caption style, preferred formats, CTA conventions                  | Social or channel section          |

Leave a field empty rather than filling it with a guess; the gap becomes a finding for the brand manager.
