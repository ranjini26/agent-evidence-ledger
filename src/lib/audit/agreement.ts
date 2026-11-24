/**
 * Agreement between the groundedness check and hand labels, at answer level.
 *
 * Positive class = "ungrounded" (what the check is meant to catch):
 *   precision = of answers the check flagged ungrounded, the share a human also labelled ungrounded
 *   recall    = of answers a human labelled ungrounded, the share the check flagged
 *   agreement = share of compared answers where check and human agree
 *   Cohen's kappa = agreement corrected for chance
 *
 * Unlabelled answers and answers the check could not judge (not_evidenced)
 * are excluded and counted. A metric whose denominator is zero is null,
 * never a made-up value.
 */

export type HumanLabel = "grounded" | "ungrounded";
export type CheckPrediction = "grounded" | "ungrounded" | "not_evidenced";

export interface LabelledPrediction {
  id: string;
  human: HumanLabel | null;
  predicted: CheckPrediction;
}

export interface AgreementReport {
  total: number;
  labelled: number;
  unlabelled: number;
  /** Labelled answers the check could not judge. */
  notEvidenced: number;
  /** Labelled and judged answers: the denominator for every metric below. */
  compared: number;
  confusion: { tp: number; fp: number; fn: number; tn: number };
  precision: number | null;
  recall: number | null;
  f1: number | null;
  agreement: number | null;
  cohensKappa: number | null;
}

const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

export function computeAgreement(rows: LabelledPrediction[]): AgreementReport {
  const labelled = rows.filter((row) => row.human !== null);
  const compared = labelled.filter((row) => row.predicted !== "not_evidenced");
  const confusion = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const row of compared) {
    const humanPositive = row.human === "ungrounded";
    const checkPositive = row.predicted === "ungrounded";
    if (humanPositive && checkPositive) confusion.tp++;
    else if (!humanPositive && checkPositive) confusion.fp++;
    else if (humanPositive && !checkPositive) confusion.fn++;
    else confusion.tn++;
  }
  const n = compared.length;
  const precision = ratio(confusion.tp, confusion.tp + confusion.fp);
  const recall = ratio(confusion.tp, confusion.tp + confusion.fn);
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);
  const agreement = ratio(confusion.tp + confusion.tn, n);
  let cohensKappa: number | null = null;
  if (n > 0 && agreement !== null) {
    const humanPositive = (confusion.tp + confusion.fn) / n;
    const checkPositive = (confusion.tp + confusion.fp) / n;
    const chance = humanPositive * checkPositive + (1 - humanPositive) * (1 - checkPositive);
    cohensKappa = chance === 1 ? null : (agreement - chance) / (1 - chance);
  }
  return {
    total: rows.length,
    labelled: labelled.length,
    unlabelled: rows.length - labelled.length,
    notEvidenced: labelled.length - compared.length,
    compared: n,
    confusion,
    precision,
    recall,
    f1,
    agreement,
    cohensKappa,
  };
}

// ---------------------------------------------------------------------------
// labels.csv
// ---------------------------------------------------------------------------

export interface LabelRow {
  trace: string;
  stepId: string;
  /** What the trace's author built the answer to be. Not a human judgement of the output. */
  authoredIntent: HumanLabel;
  /** The hand label, or null while unlabelled. */
  humanLabel: HumanLabel | null;
  notes: string;
}

const LABEL_COLUMNS = ["trace", "step_id", "authored_intent", "human_label", "notes"] as const;

function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        field += '"';
        index++;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      record.push(field);
      if (record.some((value) => value !== "")) records.push(record);
      record = [];
      field = "";
    } else {
      field += char;
    }
  }
  record.push(field);
  if (record.some((value) => value !== "")) records.push(record);
  return records;
}

function readLabel(
  value: string,
  column: string,
  line: number,
  allowBlank: boolean,
): HumanLabel | null {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "" && allowBlank) return null;
  if (trimmed === "grounded" || trimmed === "ungrounded") return trimmed;
  throw new Error(
    `labels.csv line ${line}: ${column} must be "grounded" or "ungrounded"${allowBlank ? " or blank" : ""}, got "${value}".`,
  );
}

export function parseLabelsCsv(text: string): LabelRow[] {
  const [header, ...records] = parseCsvRecords(text);
  if (!header || LABEL_COLUMNS.some((column, index) => header[index]?.trim() !== column)) {
    throw new Error(`labels.csv must start with the header: ${LABEL_COLUMNS.join(",")}`);
  }
  return records.map((record, index) => {
    const line = index + 2;
    return {
      trace: (record[0] ?? "").trim(),
      stepId: (record[1] ?? "").trim(),
      authoredIntent: readLabel(record[2] ?? "", "authored_intent", line, false) as HumanLabel,
      humanLabel: readLabel(record[3] ?? "", "human_label", line, true),
      notes: (record[4] ?? "").trim(),
    };
  });
}
