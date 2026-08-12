---
schema_version: 0
id: "inactive-note"
kind: "claim"
status: "retired"
statement: "The retired synthetic risk record must not enter active retrieval."
details: {"basis":"synthetic-retired-review","certainty":"provisional","audience":"shared"}
scope: {"space":"fictional-space-retrieval","subjects":["subject:beacon"],"topics":["topic:delivery"],"contexts":["context:review-alpha"],"dimensions":{"visibility":["shared"]}}
pack: {"id":"fictional-integrity","version":"0.1.0"}
sources: [{"type":"risk","ref":"source:beacon-retired-risk"}]
session: {"id":"synthetic-session-retrieval","host":"synthetic-host"}
submitted_at: "2026-08-05"
disposition: "new"
relationships: {"supports":[],"contradicts":[],"refines":[],"supersedes":[]}
history: []
---
## Statement

The retired synthetic risk record must not enter active retrieval.
