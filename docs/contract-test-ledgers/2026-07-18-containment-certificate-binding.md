# Containment Certificate Runtime Binding

## Contract Test Ledger

| Invariant | Risk It Prevents | First Test / Proof | Status |
| --- | --- | --- | --- |
| A package upgrade with unchanged Codex and containment argv policy accepts the existing certificate. | Every npm package bump blocks authorized issues even when the certified containment boundary is unchanged. | `runtime accepts a certificate from an older package when Codex and containment policy are unchanged` | green |
| A changed Codex version or containment argv policy still invalidates the certificate. | Runtime drift silently exceeds the boundary proved by the canary. | `runtime still rejects a certificate when the containment policy changes`; `runtime still rejects a certificate when the Codex version changes` | green |
