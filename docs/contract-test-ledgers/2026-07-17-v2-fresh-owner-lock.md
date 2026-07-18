## Contract Test Ledger

| Invariant | Risk It Prevents | First Test / Proof | Status |
| --- | --- | --- | --- |
| `setup --fresh` rejects a pre-existing V2 owner but does not reject the setup operation's own repository lock. | Every Legacy-to-V2 cutover blocks immediately after setup acquires its own lock. | `test/v2-setup.test.ts`: `fresh does not classify its own setup ownership as an active V2 runner` | green |
