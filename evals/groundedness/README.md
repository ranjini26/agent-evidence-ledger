# Groundedness eval

This folder measures how well AgentLedger's groundedness check agrees with a person. It contains:

- `traces/`: 34 synthetic traces, with 37 model answers between them. Every trace is labelled `SAMPLE ·` and `"sample": true`. They were written for this eval and are **not** data from any real agent, customer or system.
- `labels.csv`: one row per model answer.
- `reports/`: created by the runner. Each run writes one `.md` and one `.json` file.

## Labels

| Column             | Who fills it         | Meaning                                                                                                                                                                  |
| ------------------ | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `trace`, `step_id` | pre-filled           | Which answer the row is about.                                                                                                                                           |
| `authored_intent`  | pre-filled           | What the trace's author **built** the answer to be. It describes how the dataset was made. It is not an independent judgement of the answer, and it is not ground truth. |
| `human_label`      | **you**              | `grounded` or `ungrounded`, from reading the trace yourself. Leave it blank to skip a row. Every row ships blank.                                                        |
| `notes`            | pre-filled, editable | Why the author expects that intent. Rows marked "Borderline by design" test the edges of the definition.                                                                 |

**Definition to label against:** an answer is `ungrounded` if any factual claim in it is not supported by a tool output that appears **before** it in the same trace. That includes claims that are true but come from general knowledge. An answer with no factual claims (a question, an offer to help, "let me check") is `grounded`.

Label without looking at `authored_intent` if you can. Otherwise your labels will drift toward it.

## Run

```sh
ANTHROPIC_API_KEY=sk-ant-... bun run eval:groundedness
# options: --limit 5   --concurrency 2   --model claude-opus-5-5
```

- The key is read from the environment into memory. It is never written to the report or logged.
- Each run makes one Claude API call per model answer (37 calls for the full set), billed to your key. The report records the token usage the API returned. Try `--limit 3` first.
- Without a key, nothing is called, every answer is `not_evidenced`, and the report says so.
- The judge is `claude-opus-5-5` at `high` effort with prompt `groundedness-v1`. Server-side fallback is on, so if Claude declines a request, Anthropic re-runs it on its recommended fallback model. The report lists every model that actually served a judgement.

## Reading the report

The positive class is **ungrounded**, the failure the check is meant to catch.

- **Precision:** of the answers the check flagged ungrounded, the share you also labelled ungrounded.
- **Recall:** of the answers you labelled ungrounded, the share the check flagged.
- **Agreement:** the share of answers where the check and you agree.
- **Cohen's kappa:** agreement corrected for chance.

Unlabelled answers, and answers the judge failed on, are excluded and counted. A metric with a zero denominator is shown as `n/a`, never a made-up value.

The report also compares the check with `authored_intent`. That comparison is a sanity check of the dataset and the judge, **not** an accuracy figure. Report only the numbers against your own labels.

With about 37 answers, treat every metric as a rough indication. Add traces, especially real ones that have been anonymised, before relying on these numbers.

## Changing the check

If you edit the prompt or schema in `src/lib/audit/groundedness.ts`, bump `GROUNDEDNESS_PROMPT_VERSION` and re-run. Each report records the prompt version it used.
