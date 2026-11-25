// AgentLedger full walkthrough with voiceover, start to finish.
// Uses only synthetic SAMPLE data: the six audits the app seeds into a fresh browser profile,
// plus one SAMPLE eval trace uploaded during the take. No API key is entered.
//
// Each scene holds until its narration clip (out/product-demo/voiceover/<id>.aiff) has played,
// and records the frame it started on in out/product-demo/<name>.scenes.json, so the voiceover
// can be placed exactly. Requires --keep-frames (the take counts frames on disk).
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const url = process.env.DEMO_URL ?? "http://127.0.0.1:8090/agent-evidence-ledger/";

const NAME = process.env.DEMO_NAME ?? "full-demo";
const OUT = resolve(`out/product-demo/${NAME}`);
const FRAMES = `${OUT}.frames`;
// A byte-identical copy of evals/groundedness/traces/gt-24-mixed-answers.json, named so the
// app (which names runs after the file) labels the uploaded run SAMPLE.
const TRACE = resolve("out/product-demo/fixtures/SAMPLE · Plan and renewal answers.json");
const durations = JSON.parse(readFileSync(resolve("out/product-demo/voiceover/durations.json"), "utf8"));
const GAP_MS = 500;
const marks = [];

const frameCount = () =>
  existsSync(FRAMES) ? readdirSync(FRAMES).filter((f) => f.endsWith(".jpg")).length : 0;

async function scene(t, id, body) {
  const start = frameCount();
  marks.push({ id, frame: start });
  await body();
  const elapsed = ((frameCount() - start) / t.fps) * 1000;
  const needed = durations[id] * 1000 + GAP_MS;
  if (elapsed < needed) await t.hold(needed - elapsed);
}

const section = (t, title) =>
  t.frame.locator("section", { has: t.frame.locator("h3", { hasText: new RegExp(`^${title}$`) }) }).first();

export async function ready(t) {
  await t.frame.locator("aside a", { hasText: "SAMPLE · Model version drift" }).first().waitFor();
  await t.page.waitForTimeout(1200);
}

export default async function take(t) {
  if (!existsSync(FRAMES)) throw new Error("Run with --keep-frames so scenes can be timed.");

  await scene(t, "intro", async () => {
    await t.hold(700);
    await t.hover(t.frame.getByText("sample audits are ready.", { exact: false }).first(), { fx: 0.2, dwell: 900 });
    await t.hover(t.frame.getByText("Audited runs", { exact: false }).first(), { dwell: 700 });
    await t.hover(t.frame.getByText("Not evidenced", { exact: true }).first(), { dwell: 700 });
  });

  await scene(t, "thresholds", async () => {
    for (const key of ["traceabilityMin", "versioningMin", "hallucinationMax", "oversightMin", "groundednessMin"]) {
      await t.hover(t.frame.locator(`#threshold-${key}`), { fx: 0.4, dwell: 650 });
    }
  });

  await scene(t, "key", async () => {
    await t.hover(t.frame.locator("#anthropic-key"), { fx: 0.25, dwell: 1200 });
    await t.hover(t.frame.getByText("Kept in this tab's memory only.", { exact: false }), { fx: 0.3, dwell: 900 });
  });

  await scene(t, "upload", async () => {
    const choose = t.frame.getByRole("button", { name: /Choose JSON file/ });
    await t.hover(choose, { dwell: 500 });
    const [chooser] = await Promise.all([t.page.waitForEvent("filechooser"), t.clickOn(choose, { settle: 200 })]);
    await chooser.setFiles(TRACE);
    await section(t, "Traceability").waitFor();
    await t.hold(800);
  });

  await scene(t, "results", async () => {
    await t.hover(t.frame.getByText("Qualified — findings require attention").first(), { fx: 0.3, dwell: 900 });
    await t.hover(section(t, "Traceability").locator("h3"), { fx: 0.3, dwell: 1300 });
    await t.hover(section(t, "Versioning").locator("h3"), { fx: 0.3, dwell: 1800 });
    await t.wheel(260, { ms: 700 });
    await t.hover(section(t, "Hallucination rate").locator("h3"), { fx: 0.3, dwell: 1600 });
    await t.hover(section(t, "Human oversight").locator("h3"), { fx: 0.3, dwell: 1600 });
  });

  await scene(t, "groundedness", async () => {
    await t.wheel(240, { ms: 600 });
    await t.hover(section(t, "Groundedness").locator("h3"), { fx: 0.3, dwell: 1300 });
    await t.hover(section(t, "Groundedness").getByText(/^Method:/), { fx: 0.5, dwell: 1800 });
  });

  await scene(t, "evidence", async () => {
    const step = section(t, "Versioning").locator('a[href="#source-entry-2"]');
    await t.wheel(-300, { ms: 600 });
    await t.hover(step, { dwell: 500 });
    await t.clickOn(step, { settle: 600 });
    await t.hover(t.frame.locator("#source-entry-2").getByText("← steps › entry 3 › model_version", { exact: true }), {
      fx: 1.06,
      fy: 0.7,
      dwell: 1400,
    });
    t.poster();
  });

  await scene(t, "report", async () => {
    await t.wheel(-2000, { ms: 700 });
    const report = t.frame.getByRole("link", { name: /Printable report/ });
    await t.clickOn(report, { settle: 300 });
    await t.frame.getByRole("button", { name: /Export PDF/ }).waitFor();
    await t.hold(700);
    await t.hover(t.frame.getByText("Qualified — findings require attention").first(), { fx: 0.3, dwell: 900 });
    await t.hover(t.frame.getByRole("button", { name: /Export Markdown/ }), { dwell: 500 });
    await t.clickOn(t.frame.getByRole("button", { name: /Export PDF/ }), { settle: 900 });
  });

  await scene(t, "ledger", async () => {
    await t.clickOn(t.frame.locator("aside a", { hasText: /^Dashboard$/ }).first(), { settle: 400 });
    await t.frame.getByRole("button", { name: "Verify ledger" }).waitFor();
    await t.moveTo(t.width * 0.4, t.height * 0.6, { ms: 500 });
    await t.wheel(760, { ms: 900 });
    const verify = t.frame.getByRole("button", { name: "Verify ledger" });
    await t.hover(verify, { dwell: 500 });
    await t.clickOn(verify, { settle: 900 });
    await t.hover(t.frame.getByText("Ledger intact.", { exact: true }), { fx: 0.5, dwell: 1600 });
  });

  await scene(t, "outro", async () => {
    await t.moveTo(t.width * 0.62, t.height * 0.2, { ms: 800 });
    await t.hold(1200);
  });

  writeFileSync(`${OUT}.scenes.json`, `${JSON.stringify({ fps: t.fps, scenes: marks }, null, 2)}\n`);
}
