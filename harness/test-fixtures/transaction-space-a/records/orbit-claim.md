---
schema_version: 0
id: "orbit-claim"
kind: "claim"
status: "active"
statement: "The orbit service's staged rollout prevents replay during a routine release."
details: {"basis":"synthetic-observation","certainty":"provisional"}
scope: {"space":"fictional-space-transaction-a","subjects":["subject:orbit"],"topics":["topic:release"],"contexts":["context:cycle-alpha"],"dimensions":{"signals":["signal:staged-rollout"]}}
pack: {"id":"fictional-integrity","version":"0.1.0"}
sources: [{"type":"observation","ref":"source:orbit-alpha"}]
session: {"id":"synthetic-session-a","host":"synthetic-host"}
submitted_at: "2026-08-01"
disposition: "new"
relationships: {"supports":[],"contradicts":[],"refines":[],"supersedes":[]}
history: []
---
## Statement

The orbit service's staged rollout prevents replay during a routine release.
