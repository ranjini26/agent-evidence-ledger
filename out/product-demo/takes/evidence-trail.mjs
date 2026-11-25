// AgentLedger demo: from a SAMPLE audit's failed control to the exact log entry behind it.
// Uses only the synthetic SAMPLE audits the app seeds into a fresh browser profile.
export const url = process.env.DEMO_URL ?? "http://127.0.0.1:8090/agent-evidence-ledger/";

const RUN = "SAMPLE · Untracked tool execution";

const sidebarRun = (t) => t.frame.locator("aside a", { hasText: RUN }).first();
const traceability = (t) =>
  t.frame.locator("section", { has: t.frame.locator("h3", { hasText: /^Traceability$/ }) }).first();

export async function ready(t) {
  await sidebarRun(t).waitFor();
  await t.page.waitForTimeout(1200);
}

export async function still(t) {
  await sidebarRun(t).click();
  await traceability(t).waitFor();
  await t.page.waitForTimeout(800);
  await traceability(t).locator('a[href="#source-entry-0"]').click();
  await t.page.waitForTimeout(1000);
}

export default async function take(t) {
  await t.hold(600);

  // Open the SAMPLE audit from the sidebar.
  await t.hover(sidebarRun(t), { fx: 0.35, dwell: 420 });
  await t.clickOn(sidebarRun(t), { fx: 0.35, settle: 300 });
  await traceability(t).waitFor();
  await t.hold(900);

  // The failed control: 70% of entries identified, 95% required.
  await t.hover(traceability(t).locator("h3"), { fx: 0.3, dwell: 700 });
  await t.hover(traceability(t).getByText("Fail", { exact: true }), { dwell: 600 });

  // Jump to the exact entry the result was computed from.
  const step1 = traceability(t).locator('a[href="#source-entry-0"]');
  await t.hover(step1, { dwell: 420 });
  await t.clickOn(step1, { settle: 500 });
  await t.hold(900);

  // The field each control read, then an entry with no ID.
  const entry1 = t.frame.locator("#source-entry-0");
  await t.hover(entry1.getByText("← steps › entry 1 › step_id", { exact: true }), {
    fx: 1.06,
    fy: 0.7,
    dwell: 900,
  });
  t.poster();
  await t.hover(entry1.locator("pre"), { fx: 0.18, fy: 0.25, dwell: 700 });
  await t.hover(t.frame.locator("#source-entry-7 summary"), { fx: 0.12, dwell: 700 });
  await t.hover(t.frame.locator("#source-entry-7 summary"), { fx: 0.97, dwell: 900 });

  await t.moveTo(t.width * 0.6, t.height * 0.12, { ms: 700 });
  await t.hold(900);
}
