/**
 * Groundedness eval: run the groundedness check on every trace in
 * evals/groundedness/traces and compare its per-answer verdicts with the hand
 * labels in evals/groundedness/labels.csv.
 *
 *   ANTHROPIC_API_KEY=... bun run eval:groundedness [--limit N] [--concurrency N] [--model ID]
 *
 * The key is read from the environment into memory only. It is never written
 * to the report or logged. Without a key, every answer is not_evidenced, no
 * call is made, and the report says so.
 *
 * Every run with a key calls the Claude API once per model answer and is
 * billed to that key. The report records the token usage the API returned.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GROUNDEDNESS_PROMPT_VERSION,
  computeAgreement,
  evaluateGroundedness,
  parseLabelsCsv,
  parseTrace,
  type AgreementReport,
  type AnswerGroundedness,
  type LabelRow,
} from "../src/lib/audit/index.ts";
import {
  GROUNDEDNESS_JUDGE_MODEL,
  createClaudeGroundednessJudge,
} from "../src/lib/judge/claude-groundedness-judge.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const evalDir = path.join(root, "evals", "groundedness");

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}
const limit = flag("limit") ? Number(flag("limit")) : Infinity;
const concurrency = Number(flag("concurrency") ?? 2);
const model = flag("model") ?? GROUNDEDNESS_JUDGE_MODEL;

const apiKey = process.env["ANTHROPIC_API_KEY"]?.trim() || null;
const judge = apiKey ? createClaudeGroundednessJudge({ apiKey, model }) : null;

const labels = parseLabelsCsv(readFileSync(path.join(evalDir, "labels.csv"), "utf8"));
const labelFor = new Map(labels.map((row) => [`${row.trace}#${row.stepId}`, row]));
const files = readdirSync(path.join(evalDir, "traces"))
  .filter((name) => name.endsWith(".json"))
  .sort()
  .slice(0, limit);

interface Row {
  trace: string;
  stepId: string;
  label: LabelRow | undefined;
  answer: AnswerGroundedness;
}

async function runTrace(file: string): Promise<Row[]> {
  const source: unknown = JSON.parse(readFileSync(path.join(evalDir, "traces", file), "utf8"));
  const result = await evaluateGroundedness(parseTrace(source), 0, judge, { concurrency: 1 });
  return result.answers.map((answer) => ({
    trace: file,
    stepId: answer.stepId ?? `step-${answer.step}`,
    label: labelFor.get(`${file}#${answer.stepId}`),
    answer,
  }));
}

async function runAll(): Promise<Row[]> {
  const results: Row[][] = new Array(files.length);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < files.length) {
      const index = next++;
      results[index] = await runTrace(files[index]!);
      done++;
      process.stdout.write(`\r  ${done}/${files.length} traces`);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, files.length)) }, worker),
  );
  process.stdout.write("\n");
  return results.flat();
}

const pct = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);
const num = (value: number | null) => (value === null ? "n/a" : value.toFixed(3));

function metricsTable(report: AgreementReport): string {
  const { tp, fp, fn, tn } = report.confusion;
  return [
    `| | Check: ungrounded | Check: grounded |`,
    `|---|---|---|`,
    `| **Label: ungrounded** | ${tp} (TP) | ${fn} (FN) |`,
    `| **Label: grounded** | ${fp} (FP) | ${tn} (TN) |`,
    ``,
    `| Metric | Value |`,
    `|---|---|`,
    `| Answers compared | ${report.compared} |`,
    `| Precision (flagged ungrounded → labelled ungrounded) | ${pct(report.precision)} |`,
    `| Recall (labelled ungrounded → flagged) | ${pct(report.recall)} |`,
    `| F1 | ${num(report.f1)} |`,
    `| Agreement | ${pct(report.agreement)} |`,
    `| Cohen's kappa | ${num(report.cohensKappa)} |`,
    ``,
    `Excluded: ${report.unlabelled} unlabelled, ${report.notEvidenced} labelled but not judged.`,
  ].join("\n");
}

async function main() {
  const answerCount = labels.filter((row) => files.includes(row.trace)).length;
  console.log(
    judge
      ? `Judging ${answerCount} answers in ${files.length} traces with ${model} (prompt ${GROUNDEDNESS_PROMPT_VERSION}). Calls are billed to your API key.`
      : `ANTHROPIC_API_KEY is not set: no calls will be made and every answer will be not_evidenced.`,
  );

  const startedAt = new Date();
  const rows = await runAll();
  const vsHuman = computeAgreement(
    rows.map((row) => ({
      id: `${row.trace}#${row.stepId}`,
      human: row.label?.humanLabel ?? null,
      predicted: row.answer.verdict,
    })),
  );
  const vsIntent = computeAgreement(
    rows.map((row) => ({
      id: `${row.trace}#${row.stepId}`,
      human: row.label?.authoredIntent ?? null,
      predicted: row.answer.verdict,
    })),
  );
  const servedModels = [
    ...new Set(rows.flatMap((row) => (row.answer.model ? [row.answer.model] : []))),
  ];
  const usage = rows.reduce(
    (sum, row) => ({
      inputTokens: sum.inputTokens + (row.answer.usage?.inputTokens ?? 0),
      outputTokens: sum.outputTokens + (row.answer.usage?.outputTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0 },
  );
  const unmatched = rows.filter((row) => !row.label);

  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const reportDir = path.join(evalDir, "reports");
  mkdirSync(reportDir, { recursive: true });

  const json = {
    startedAt: startedAt.toISOString(),
    judgeRan: judge !== null,
    modelRequested: judge ? model : null,
    modelsServed: servedModels,
    promptVersion: GROUNDEDNESS_PROMPT_VERSION,
    traces: files.length,
    answers: rows.length,
    usage,
    vsHumanLabels: vsHuman,
    vsAuthoredIntent: vsIntent,
    rows: rows.map((row) => ({
      trace: row.trace,
      stepId: row.stepId,
      humanLabel: row.label?.humanLabel ?? null,
      authoredIntent: row.label?.authoredIntent ?? null,
      predicted: row.answer.verdict,
      model: row.answer.model,
      error: row.answer.error,
      claims: row.answer.claims,
    })),
  };
  writeFileSync(path.join(reportDir, `${stamp}.json`), `${JSON.stringify(json, null, 2)}\n`);

  const disagreements = rows.filter(
    (row) =>
      row.label?.humanLabel &&
      row.answer.verdict !== "not_evidenced" &&
      row.answer.verdict !== row.label.humanLabel,
  );
  const markdown = [
    `# Groundedness eval report`,
    ``,
    `- Run: ${startedAt.toISOString()}`,
    `- Judge: ${judge ? `requested \`${model}\`; served by ${servedModels.map((m) => `\`${m}\``).join(", ") || "none (every call failed)"}` : "**not run (no ANTHROPIC_API_KEY)**"}`,
    `- Prompt version: \`${GROUNDEDNESS_PROMPT_VERSION}\``,
    `- Traces: ${files.length} · Answers: ${rows.length}`,
    `- Tokens reported by the API: ${usage.inputTokens} input, ${usage.outputTokens} output`,
    ``,
    `> The traces are synthetic SAMPLE data written for this eval. They are not data from any real agent or customer.`,
    `> With ${vsHuman.compared} compared answers, treat every metric as a rough indication, not a benchmark.`,
    `> Positive class is **ungrounded**.`,
    ``,
    `## Agreement with your hand labels`,
    ``,
    vsHuman.labelled === 0
      ? `**No hand labels yet.** Fill the \`human_label\` column in \`evals/groundedness/labels.csv\` (\`grounded\` or \`ungrounded\`) and re-run. No metrics are reported until then.`
      : metricsTable(vsHuman),
    ``,
    `## Against authoring intent (not ground truth)`,
    ``,
    `\`authored_intent\` records what the trace's author built each answer to be. It is not an independent human judgement of the answer, so this section is a sanity check of the dataset and the judge, **not** an accuracy figure. Do not report it as one.`,
    ``,
    metricsTable(vsIntent),
    ``,
    `## Per answer`,
    ``,
    `| Trace | Step | Human | Intent | Check | Not supported |`,
    `|---|---|---|---|---|---|`,
    ...rows.map(
      (row) =>
        `| ${row.trace} | ${row.stepId} | ${row.label?.humanLabel ?? "—"} | ${row.label?.authoredIntent ?? "—"} | ${row.answer.verdict}${row.answer.error ? ` (${row.answer.error})` : ""} | ${row.answer.claims
          .filter((claim) => claim.verdict !== "supported")
          .map((claim) => `${claim.verdict}: ${claim.claim.replace(/\|/g, "\\|")}`)
          .join("<br>")} |`,
    ),
    ``,
    disagreements.length > 0
      ? `## Disagreements with hand labels\n\n${disagreements.map((row) => `- ${row.trace} ${row.stepId}: you said ${row.label!.humanLabel}, check said ${row.answer.verdict}`).join("\n")}\n`
      : "",
    unmatched.length > 0
      ? `## Answers with no label row\n\n${unmatched.map((row) => `- ${row.trace} ${row.stepId}`).join("\n")}\n`
      : "",
  ].join("\n");
  const mdPath = path.join(reportDir, `${stamp}.md`);
  writeFileSync(mdPath, markdown);

  console.log(`Report: ${path.relative(root, mdPath)}`);
  console.log(
    vsHuman.labelled === 0
      ? "No hand labels yet; no metrics reported."
      : `vs hand labels (n=${vsHuman.compared}): precision ${pct(vsHuman.precision)}, recall ${pct(vsHuman.recall)}, agreement ${pct(vsHuman.agreement)}, kappa ${num(vsHuman.cohensKappa)}`,
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "The eval failed.");
  process.exit(1);
});
