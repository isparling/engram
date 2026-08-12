---
id: checkout-api
title: Checkout API
updated: 2026-07-22
---

## Active claims

- Two competing deployment paths exist: a hand-maintained kubectl apply -f manifests/ script and a newer Argo CD Application; only the Argo path is documented, but the manual path is still what most engineers use. [source: onboarding-audit]
- The readiness probe hits /healthz, which returns 200 even while the connection pool to the ledger service is exhausted, so rollouts can promote a pod that immediately errors under load. [source: incident-3390]
- The checkout-api-hpa HorizontalPodAutoscaler targets CPU only; a memory-bound regression in 2026-06 was not caught by autoscaling. [source: postmortem-2026-06]
- Feature flag checkout.newPricingEngine is at 100% in the config map but the old pricing engine code path has not been deleted, so both are live dependencies. [source: code-audit-118]

## Evidence log

- 2026-04-11 — Argo CD Application checkout-api added alongside the existing manual deploy script rather than replacing it, per the migration ticket. [source: deploy-log]
- 2026-06-09 — Incident 3390: a pod passed readiness while its ledger connection pool was exhausted, causing a five-minute partial outage during a rollout. [source: incident-3390]
- 2026-06-20 — Postmortem for the memory regression recommended adding a memory target to the HPA; the recommendation was not yet implemented as of this entry. [source: postmortem-2026-06]
- 2026-07-22 — Confirmed checkout.newPricingEngine flag at 100% rollout in configmap/checkout-api-flags. [source: code-audit-118]
