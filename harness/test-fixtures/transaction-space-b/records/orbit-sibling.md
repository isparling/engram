---
schema_version: 0
id: "orbit-sibling"
kind: "claim"
status: "active"
statement: "The orbit service's staged rollout prevents replay during a routine release."
details: {"basis":"synthetic-sibling","certainty":"provisional"}
scope: {"space":"fictional-space-transaction-b","subjects":["subject:orbit"],"topics":["topic:release"],"contexts":["context:cycle-beta"],"dimensions":{"signals":["signal:staged-rollout"]}}
pack: {"id":"fictional-integrity","version":"0.1.0"}
sources: [{"type":"observation","ref":"source:orbit-beta"}]
session: {"id":"synthetic-session-b","host":"synthetic-host"}
submitted_at: "2026-08-01"
disposition: "new"
relationships: {"supports":[],"contradicts":[],"refines":[],"supersedes":[]}
history: []
---
## Statement

The orbit service's staged rollout prevents replay during a routine release.
