# Tidewatch public investigation corpus

12 deterministic tasks investigate a fictional coastal monitoring project with
12 fixture files (including one base64-encoded, 2x2 RGB PNG). No private code,
sessions, or service credentials are included. The project is a static fixture:
its Python modules are evidence, not runnable application dependencies.

Input: expose **only** `fixtures/tidewatch/` as the evaluated CLI root. Give
the evaluator one `question` from `tasks.json` at a time. Never mount this
README, `tasks.json`, `oracle/`, or `validate.py` within that root. Keep the
oracle out of the model's retrieval context and prompt; it is for scoring only.

Oracle: `oracle/answers.json` maps task IDs to exact required value substrings,
fixture-relative citation paths and inclusive 1-based line ranges. A citation's
`contains` text must appear in the specified range. T09 is an honest no-match:
score `status: not_found` semantically, not a particular sentence. T12's `pixels`
fields are exact decoded image properties, not required prose. Decode the PNG
from base64 before visual scoring. File names and evidence spans matter; do not
score answer wording equality or expose the oracle as a target file.

Tasks intentionally cover active-versus-sample/archive decoys, cross-file
resolution, joined station/region facts, routes, no-match, and image decoding.
Do not train, tune a prompt, or edit a system against these answers; use unseen
cases for optimization and this small corpus only as a transparent smoke test.

From this directory run `python validate.py` to check task IDs, citation lines,
literal facts, no-match absence, file count, and PNG pixels without dependencies.
