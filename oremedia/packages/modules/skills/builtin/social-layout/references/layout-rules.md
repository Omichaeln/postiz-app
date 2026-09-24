# Layout rules

- Safe margin: 6% of the shorter page side on every edge; stories keep an additional 14% clear at top and bottom
  for platform chrome.
- Hierarchy: headline uses the `display` or `heading` type role, body uses `body`, CTA uses `label`. Sizes never
  drop below the token's `minSizePx`.
- Contrast: text over imagery needs the brand's contrast target (AA by default); add a token-coloured panel
  behind text when the image cannot guarantee it.
- Logo: use the variant allowed on the chosen background colour key; keep the clear space ratio and never scale
  below the minimum width; one logo per page.
- Imagery: one dominant image; do not crop through faces or product labels; keep the aspect ratio.
- Text overflow: prefer reducing the body to two lines over shrinking type below the minimum; report any
  shortening as a `warning` finding with the element id.
