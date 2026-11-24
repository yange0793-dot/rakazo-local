# Time-Split Learning Stream

## Commands

List the default deterministic stream without starting a model runtime:

```sh
pnpm exec tsx packages/testkit/src/cli/learning-stream.ts --list
```

Run the offline regression. It starts a loopback-only synthetic model endpoint and uses the real Pi runtime, proposal request, WorkImprovement scorer, and Compose runner:

```sh
pnpm exec tsx packages/testkit/src/cli/learning-stream.ts \
  --output /tmp/learning-stream-offline.json
```

Run against a configured model only with `--live`:

```sh
pnpm exec tsx packages/testkit/src/cli/learning-stream.ts \
  --live \
  --connection /secure/model-connection.json \
  --output /tmp/learning-stream-live.json
```

There are no local time, model-call, token, or tool-call ceilings. Stop a run with `SIGINT` or `SIGTERM`. Pricing and a monetary cap are optional; cost and adoption qualification remain unknown without reliable pricing. A monetary cap requires explicit `--pricing`:

```sh
pnpm exec tsx packages/testkit/src/cli/learning-stream.ts \
  --live \
  --connection /secure/model-connection.json \
  --pricing /secure/model-pricing.json \
  --spend-cap-usd 5 \
  --output /tmp/learning-stream-capped.json
```

The connection file uses the shared model connection shape. Required fields are `provider` and `modelId`; common optional fields are `apiKey`, `baseUrl`, `apiProtocol`, `headers`, `thinkingLevel`, `maxTokens`, `contextWindow`, `reasoning`, and `reasoningCapabilities`.

```json
{
  "provider": "PROVIDER",
  "modelId": "MODEL",
  "apiKey": "LOCAL_SECRET_VALUE",
  "baseUrl": "https://MODEL_ENDPOINT",
  "apiProtocol": "responses",
  "thinkingLevel": "max",
  "maxTokens": 8192,
  "contextWindow": 131072
}
```

The run keeps the selected provider, model, effort, headers, and connection `maxTokens`. The default client headers come from the shared Pi adapter path. `--service-tier priority` injects the standard wire field for this CLI run; it does not change production model configuration. Live receipts record requested/applied tier, HTTP and terminal status, token usage, returned tier, header names, and native client identity, but never header values.

The pricing file is shared with the testkit measurement code. Rates are USD per million tokens:

```json
{
  "source": "PRICING_SOURCE",
  "version": "PRICING_REVISION",
  "input": 1.0,
  "output": 4.0,
  "cacheRead": 0.2,
  "cacheWrite": 1.25
}
```

## Split And Run Controls

The default stream is seed `104729`: three chronological training tasks, two later selection tasks, and three future holdout tasks. Training data alone enters proposal and composition prompts. Selection results only rank the generated revisions. Holdout inputs and expected-answer hashes are excluded from both prompts and are first read during final evaluation.

The first training task produces one shared frozen history snapshot. A second training-only comparison is added only to accumulating history. The third training task generates separate frozen-history and accumulating-history candidates. Selection is performed afterward on the independent selection partition.

The retry runs the same holdout task twice with the selected model connection settings; the second attempt sees only the first attempt's answer and execution receipt, not its grade or the oracle. Tasks retain the isolated read-only file-tool boundary. There are no local per-task time, token, or tool-call ceilings, and no global or phase model-call or token ceiling. An optional USD spend cap requires explicit pricing; offline mode has no provider spend guard.

Spend reservations are a guard, not a billing guarantee. Reported cost is calculated from provider-reported charges or explicit pricing; unavailable cost remains `null`, never zero. Candidate selection is diagnostic and does not qualify adoption while cost is unknown. A stopped or exhausted run writes its partial report and termination receipt and exits nonzero. Failed and unknown phase receipts remain in the report.

## Report

The atomic JSON report uses `learning-stream.report.v1` and includes:

- `manifest`: seed, partition sizes, logical task order, input hashes, and expected-answer hashes.
- `execution`: live/offline mode, provider, model, effort, route, pricing, and any explicitly configured spend cap.
- `revisionRefs`: code revision, working-diff hash, baseline, improver, proposal, composition, and scorer references.
- `promptAudit`: task and history references, prompt hashes, and explicitly excluded selection/holdout task IDs.
- `phases`, `histories`, `training`, and `selection`: actual proposal, composition, comparison, and selection receipts.
- `holdout`: baseline, frozen history, accumulating history, and equal-budget retry verdicts and measurements. Retry metrics separate final per-task outcomes from both-attempt spend and usage.
- `usage`: every settled call, unknown measurement, observed token reservations and phase totals, optional spend guard state, and blocked attempt.
- `outboundHeaderReceipts`: observed request-header names, native client identity, response status, and hashed provider request IDs.
- `termination`: completion, interruption, failure, or optional spend-cap exhaustion and final counters.

`--list` prints task ID, split, logical time, and input hash only. The offline fixture uses a fixed synthetic proposer/composer response and an evidence-driven local task interpreter; its scores verify wiring and scoring contracts, not model learning. Live results are descriptive small-sample results and do not claim statistical significance.
