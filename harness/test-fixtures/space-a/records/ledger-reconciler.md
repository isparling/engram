---
id: ledger-reconciler
title: Ledger Reconciler (batch)
updated: 2026-07-18
---

## Active claims

- The reconciliation job runs as a Kubernetes CronJob on a 15-minute schedule, but a second, deprecated static Pod manifest for the same job still exists in the manifests directory and has been manually applied at least once by accident. [source: incident-2890]
- Reconciliation assumes settlement files arrive in strict lexical filename order; an out-of-order upload from the EU partner silently skipped a batch in 2026-05. [source: incident-2610]
- The job's service account has broader S3 read access than the reconciliation path requires, scoped at the bucket level rather than the prefix level. [source: access-review-2026-Q2]

## Evidence log

- 2026-05-19 — Incident 2610: an out-of-order settlement file upload caused one batch to be silently skipped; detected three days later during month-end close. [source: incident-2610]
- 2026-06-02 — Access review flagged the reconciler's service account for overly broad S3 permissions; ticket filed, not yet remediated. [source: access-review-2026-Q2]
- 2026-07-18 — Incident 2890: the deprecated static Pod manifest was applied manually during an on-call escalation, running a duplicate reconciliation pass alongside the CronJob. [source: incident-2890]
