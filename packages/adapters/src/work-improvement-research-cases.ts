import type { WorkImprovementCase, WorkImprovementOutput } from "./work-improvement.js";

export const RESEARCH_CHECK_PILOT = {
  id: "research-check",
  revision: "1",
  outputContract: {
    checkIds: ["coverage", "support", "currency"],
    observationIds: ["unsupported_claims", "missing_sources", "stale_sources"],
  },
};

const OUTPUT_VERSION = "work-improvement.output.v1";

/** The same neutral wording for every case. How to check is left to the playbook under test. */
const TASK = [
  "Review whether the research summary in summary.json is backed by the sources it cites, and report the result.",
  "request.json names the project and the question the summary answers; asOf is the date the information must be current as of, and the question itself names any edition or release its sources must carry.",
  "summary.json holds the summary's project and question, and its claims; each claim has an id, a text, and the sourceId it cites.",
  "sources/<sourceId>.json holds one cited source: its title, publishedAt (the date it was published), version, and text.",
  "coverage is pass when every claim's cited source file exists under sources/, and unknown when any cited source has no file there.",
  "support and currency judge only the claims whose cited source exists.",
  "support is pass when each existing source's text supports the claim that cites it, and fail when any of those claims is contradicted or not backed by its source's text.",
  "currency is pass when every existing cited source was published on or before asOf and, when the question names an edition or release, its version is that edition or release; otherwise currency is fail.",
  "outcome is failed when any check fails, otherwise unknown when any check is unknown, otherwise complete.",
  "missing_sources lists the ids of claims whose cited source has no file under sources/; unsupported_claims lists the ids of claims their source's text does not support; stale_sources lists the ids of sources published after asOf or not carrying the edition or release the question names.",
  "When summary.json's project or question differs from the one request.json names, outcome is out_of_scope and every check is not_applicable.",
].join("\n");

interface Source {
  title: string;
  publishedAt: string;
  version: string;
  text: string;
}

interface Claim {
  id: string;
  text: string;
  sourceId: string;
}

interface Scenario {
  id: string;
  split: "diagnostic" | "holdout";
  category: "success" | "failure" | "insufficient_evidence" | "scope_exception";
  protection: boolean;
  question: string;
  asOf: string;
  /** The summary's project; the scope case points it at a project the request did not name. */
  summaryProject?: string;
  claims: Claim[];
  sources: Record<string, Source>;
  expected: WorkImprovementOutput;
}

/** Synthetic research checks; the comparison keeps these answers outside model input. */
export function researchCheckPilotCases(project: string): WorkImprovementCase[] {
  const output = (change: Partial<WorkImprovementOutput> = {}): WorkImprovementOutput => ({
    schemaVersion: OUTPUT_VERSION,
    outcome: "complete",
    checks: { coverage: "pass", support: "pass", currency: "pass" },
    observations: { unsupported_claims: [], missing_sources: [], stale_sources: [] },
    ...change,
  });
  const scenarios: Scenario[] = [
    {
      id: "clean",
      split: "diagnostic",
      category: "success",
      protection: true,
      question: "Which export formats does Meridian Notes offer, and how does bulk export work?",
      asOf: "2026-09-30",
      claims: [
        {
          id: "c1",
          text: "Meridian Notes exports a notebook as PDF or Markdown.",
          sourceId: "src-export-guide",
        },
        {
          id: "c2",
          text: "Version 4.2 added single-notebook HTML export.",
          sourceId: "src-4-2-notes",
        },
        {
          id: "c3",
          text: "Bulk export handles one notebook per run.",
          sourceId: "src-export-faq",
        },
      ],
      sources: {
        "src-export-guide": {
          title: "Meridian Notes user guide: exporting notebooks",
          publishedAt: "2026-07-12",
          version: "2026.7",
          text: "A notebook can be exported as PDF or Markdown from the share menu.",
        },
        "src-4-2-notes": {
          title: "Meridian Notes 4.2 release notes",
          publishedAt: "2026-08-21",
          version: "4.2",
          text: "Version 4.2 adds single-notebook HTML export alongside the existing PDF and Markdown formats.",
        },
        "src-export-faq": {
          title: "Export FAQ",
          publishedAt: "2026-06-03",
          version: "2026.6",
          text: "Bulk export processes one notebook per run; queue several runs to export several notebooks.",
        },
      },
      expected: output(),
    },
    {
      // Three claims cite two sources: two share src-rate-limits and one cites src-429-notes.
      id: "multi-source",
      split: "holdout",
      category: "success",
      protection: true,
      question: "What rate limits apply to the Tidewater Sync API?",
      asOf: "2026-10-15",
      claims: [
        {
          id: "m1",
          text: "Tidewater Sync allows 600 requests per minute per workspace.",
          sourceId: "src-rate-limits",
        },
        {
          id: "m2",
          text: "A request over the limit is answered with HTTP 429.",
          sourceId: "src-rate-limits",
        },
        {
          id: "m3",
          text: "Rate windows reset at the start of each minute.",
          sourceId: "src-429-notes",
        },
      ],
      sources: {
        "src-rate-limits": {
          title: "Tidewater Sync rate limits",
          publishedAt: "2026-09-28",
          version: "2026.10",
          text: "Each workspace may send up to 600 requests per minute; a request over the limit is answered with HTTP 429.",
        },
        "src-429-notes": {
          title: "Handling 429 responses",
          publishedAt: "2026-08-14",
          version: "2026.8",
          text: "Rate windows reset at the start of each minute, and every 429 carries a Retry-After header.",
        },
      },
      expected: output(),
    },
    {
      // src-shipping-note says May 2026, contradicting the claim that it shipped in March.
      id: "unsupported",
      split: "diagnostic",
      category: "failure",
      protection: false,
      question:
        "When did the Kestrel 2.0 hardware revision ship, and which radio module does it use?",
      asOf: "2026-06-30",
      claims: [
        {
          id: "u1",
          text: "Kestrel 2.0 shipped in March 2026.",
          sourceId: "src-shipping-note",
        },
        {
          id: "u2",
          text: "Kestrel 2.0 uses the Larkspur B2 radio module.",
          sourceId: "src-hardware-spec",
        },
      ],
      sources: {
        "src-shipping-note": {
          title: "Kestrel 2.0 shipping update",
          publishedAt: "2026-05-06",
          version: "2.0",
          text: "The Kestrel 2.0 hardware revision began shipping in May 2026.",
        },
        "src-hardware-spec": {
          title: "Kestrel 2.0 hardware specification",
          publishedAt: "2026-02-19",
          version: "2.0",
          text: "Kestrel 2.0 carries the Larkspur B2 radio module with dual-band support.",
        },
      },
      expected: output({
        outcome: "failed",
        checks: { coverage: "pass", support: "fail", currency: "pass" },
        observations: { unsupported_claims: ["u1"], missing_sources: [], stale_sources: [] },
      }),
    },
    {
      // x2 cites src-rollout-roadmap, which has no file, so coverage cannot be judged.
      id: "missing-source",
      split: "holdout",
      category: "insufficient_evidence",
      protection: true,
      question: "Which firmware branch should Osprey routers use for stable updates?",
      asOf: "2026-05-31",
      claims: [
        {
          id: "x1",
          text: "Stable Osprey firmware ships from the cedar branch.",
          sourceId: "src-firmware-channels",
        },
        {
          id: "x2",
          text: "Osprey routers switch to the cedar branch automatically after 30 days.",
          sourceId: "src-rollout-roadmap",
        },
      ],
      sources: {
        "src-firmware-channels": {
          title: "Osprey firmware channels",
          publishedAt: "2026-04-08",
          version: "2026.4",
          text: "Stable Osprey firmware ships from the cedar branch; the beta branch carries early builds.",
        },
      },
      expected: output({
        outcome: "unknown",
        checks: { coverage: "unknown", support: "pass", currency: "pass" },
        observations: { unsupported_claims: [], missing_sources: ["x2"], stale_sources: [] },
      }),
    },
    {
      // The question asks for the 2026 edition; src-pricing-2025 is the 2025 edition.
      id: "stale",
      split: "holdout",
      category: "failure",
      protection: false,
      question: "What does the 2026 edition of the Bramble pricing sheet list for the team plan?",
      asOf: "2026-06-30",
      claims: [
        {
          id: "s1",
          text: "The Bramble team plan costs 40 credits per month.",
          sourceId: "src-pricing-2025",
        },
        {
          id: "s2",
          text: "Team plans can be billed annually.",
          sourceId: "src-billing-terms",
        },
      ],
      sources: {
        "src-pricing-2025": {
          title: "Bramble pricing sheet, 2025 edition",
          publishedAt: "2025-10-15",
          version: "2025 edition",
          text: "The team plan costs 40 credits per month, billed monthly.",
        },
        "src-billing-terms": {
          title: "Bramble billing terms, 2026 edition",
          publishedAt: "2026-01-20",
          version: "2026 edition",
          text: "Team plans can be billed annually at ten times the monthly price.",
        },
      },
      expected: output({
        outcome: "failed",
        checks: { coverage: "pass", support: "pass", currency: "fail" },
        observations: {
          unsupported_claims: [],
          missing_sources: [],
          stale_sources: ["src-pricing-2025"],
        },
      }),
    },
    {
      // The summary belongs to another project, so nothing in it is judged.
      id: "other-project",
      split: "holdout",
      category: "scope_exception",
      protection: true,
      question: "Which maintenance windows does the Juniper Field service publish?",
      asOf: "2026-08-31",
      summaryProject: `${project}-unrelated`,
      claims: [
        {
          id: "o1",
          text: "Juniper Field publishes maintenance windows every second Tuesday.",
          sourceId: "src-maintenance-schedule",
        },
        {
          id: "o2",
          text: "Maintenance windows last up to 90 minutes.",
          sourceId: "src-maintenance-schedule",
        },
      ],
      sources: {
        "src-maintenance-schedule": {
          title: "Juniper Field maintenance schedule",
          publishedAt: "2026-07-02",
          version: "2026.7",
          text: "Maintenance windows are published for every second Tuesday and last up to 90 minutes.",
        },
      },
      expected: output({
        outcome: "out_of_scope",
        checks: {
          coverage: "not_applicable",
          support: "not_applicable",
          currency: "not_applicable",
        },
      }),
    },
  ];
  return scenarios.map((scenario): WorkImprovementCase => {
    const summaryProject = scenario.summaryProject ?? project;
    const scoped = summaryProject !== project;
    const citedSourceIds = [...new Set(scenario.claims.map((claim) => claim.sourceId))]
      .filter((sourceId) => scenario.sources[sourceId] !== undefined)
      .sort();
    return {
      id: scenario.id,
      project: summaryProject,
      family: RESEARCH_CHECK_PILOT.id,
      split: scenario.split,
      category: scenario.category,
      protection: scenario.protection,
      input: {
        task: TASK,
        materials: {
          "request.json": JSON.stringify({
            project,
            question: scenario.question,
            asOf: scenario.asOf,
          }),
          "summary.json": JSON.stringify({
            project: summaryProject,
            question: scenario.question,
            claims: scenario.claims,
          }),
          ...Object.fromEntries(
            Object.entries(scenario.sources).map(([sourceId, source]) => [
              `sources/${sourceId}.json`,
              JSON.stringify(source),
            ]),
          ),
        },
      },
      expected: scenario.expected,
      requiredSteps: scoped
        ? [
            { tool: "read_file", path: "request.json" },
            { tool: "read_file", path: "summary.json" },
          ]
        : [
            { tool: "read_file", path: "request.json" },
            { tool: "read_file", path: "summary.json" },
            ...citedSourceIds.map((sourceId) => ({
              tool: "read_file" as const,
              path: `sources/${sourceId}.json`,
            })),
          ],
    };
  });
}
