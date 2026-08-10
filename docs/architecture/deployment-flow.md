# Deployment flow

```text
exact PR head
  -> PR Gate + Security Gate
  -> native protected squash merge
  -> push to protected main
  -> classify runtime impact
     -> neutral: summary only
     -> impacting: build + attest immutable release once
        -> test deploy + SHA/digest/smoke/auth/telemetry verification
        -> one current-main read
        -> production promotion of the same digest
        -> production verification
        -> one known-good package rollback if the new release is observed and fails
```

The protected branch is the trust boundary between candidate validation and release construction. Delivery does not reconstruct PR lineage, replay exact-main CI, dispatch child controllers, or poll Actions run lists. Azure mutations use OIDC and the reusable deployment workflow. Production and rollback serialize through `production-deployment`.
