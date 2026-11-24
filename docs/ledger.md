# Audit ledger

Every audited run is appended to an on-device, hash-chained ledger in IndexedDB. The database is `agentledger-device-tests` (version 2) and the store is `ledger`. Hashing uses the browser's WebCrypto API (`crypto.subtle.digest("SHA-256")`). The ledger makes no network calls. The code is in `src/lib/audit/ledger.ts`, which is pure and tested, and in `src/lib/agent-ledger-local.ts`, which handles the IndexedDB storage.

## Record

| Field                   | Meaning                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `index`                 | 1-based position in the chain.                                                                                                                                                 |
| `kind`                  | `audit_recorded` when a run is saved or seeded; `audit_deleted` when a run is deleted. Deleting a run never removes records.                                                   |
| `recordedAt`            | ISO time the record was written.                                                                                                                                               |
| `engineVersion`         | `AUDIT_ENGINE_VERSION`, e.g. `agentledger-audit-1.0.0`. Bump it when scoring, the record format or hashing changes.                                                            |
| `run`                   | Run id, name, source filename, entry count, creation time, and `sourceSha256`: the SHA-256 of the uploaded log's canonical JSON. The log itself is not copied into the ledger. |
| `thresholds`, `opinion` | As applied to the run.                                                                                                                                                         |
| `results`               | Every control result, including its `evidence` references (step, step id, JSON path) and, for groundedness, the judge's method, model, prompt version and claims.              |
| `previousHash`          | `hash` of the previous record; 64 zeros for record #1.                                                                                                                         |
| `hash`                  | SHA-256 (hex) of the canonical JSON of every other field. Canonical JSON sorts keys, omits `undefined` and rejects non-finite numbers.                                         |

## Verify ledger

The dashboard's **Verify ledger** button reads every record, recomputes each hash and link in order, and reports the first record that breaks the chain:

- `hash_mismatch`: the record's contents changed after it was written.
- `previous_hash_mismatch`: the record links to a hash the previous record no longer has. The previous record, or an earlier one, was rewritten and re-hashed, or a record was inserted or removed.
- `index_out_of_order`: a record was removed, inserted or reordered.
- `malformed`: the record is missing fields.

It also compares each run the app displays with its latest ledger record:

- **Differs from its ledger record:** the stored audit was changed after it was recorded. If that ledger record still verifies, the record is the original. If the record also fails verification, neither copy can be trusted.
- **Not in the ledger:** the run was saved before the ledger existed (databases upgraded from version 1), or recording failed.

## Exports

The report page exports Markdown and PDF. Both are rendered from one report model (`src/lib/report/audit-report.ts`) on the device. They contain the run summary, each control's result, cited evidence and method, the ledger record and its hash, the verification outcome at export time, and the limitations. The PDF writer (`src/lib/report/pdf.ts`) uses no dependencies and fetches nothing. It uses the standard Helvetica fonts and replaces characters outside WinAnsi with ASCII equivalents (for example `≥` becomes `>=`).

## Limitations

- The chain detects edits, insertions, removals and reordering of **earlier** records. On its own it cannot detect removal of the newest records, or someone rewriting and re-hashing the whole chain, because nothing anchors it outside the device. Every export prints the head hash. Keep it somewhere else and compare it later.
- It is a hash chain, not a digital signature. It shows that records are consistent with each other, not who wrote them.
- The ledger lives in this browser's IndexedDB. Clearing site data deletes it.
