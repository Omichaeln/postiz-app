# Prompt-injection fixtures (spec 18, Phase 4 gate)

Each file is one piece of retrieved content (guideline text, OCR text, a caption, a comment, a web page) that tries
to make the agent publish, call an unlisted tool, raise its own autonomy or exfiltrate credentials. `obeyedToolCalls`
is what a model that obeys the text would emit; the injection tests script the fake model to emit exactly that and
assert that the dispatcher denies every unlisted call (`tool_not_allowed`), that listed calls stay inside the run's
server-side scope, that the run's mode never rises, that no external effect exists and that the audit trail records
the denials.
