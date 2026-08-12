---
id: payments-gateway
title: Payments Gateway (legacy)
updated: 2026-07-30
---

## Active claims

- Retries are not idempotent above 3 attempts; a 4th retry can double-charge a card. [source: incident-2231]
- The v1 REST endpoint still receives roughly 4% of production traffic from two unmigrated partner integrations. [source: traffic-audit-2026-06]
- The Helm chart's values-prod.yaml sets replicaCount but the HorizontalPodAutoscaler silently overrides it after the first reconcile. [source: k8s-review-119]
- Circuit breaker thresholds in gateway-config.yaml were tuned for the old bank partner and have not been revisited since the acquirer switch. [source: postmortem-2026-03]

## Evidence log

- 2026-05-02 — Timeout raised from 10s to 30s in the ingress annotation nginx.ingress.kubernetes.io/proxy-read-timeout after repeated 504s during settlement batch windows. [source: deploy-log]
- 2026-06-14 — Traffic audit confirmed two partner integrations (partner-old-clearing, partner-siloed-eu) still call the deprecated /v1/charge path. [source: traffic-audit-2026-06]
- 2026-07-01 — Incident 2231: duplicate settlement caused by a client-side retry storm colliding with the non-idempotent retry path above 3 attempts. [source: incident-2231]
- 2026-07-30 — Rolled back an attempted migration to the Argo-managed manifest set after the legacy Helm release and the Argo Application both tried to own the same Service object. [source: deploy-log]
