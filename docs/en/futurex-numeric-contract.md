# FutureX numeric targets and unit validation

Chinese primary: [中文](../futurex-numeric-contract.md). Updated 2026-09-09.

The August 26 review found thousandfold and millionfold scale errors, plus target errors such as confusing an index level with a monthly change. `futurex run` and `futurex pilot` now require an explicit `numericContract` for every numeric route; a field name or unit sentence in the question alone is insufficient. Verify the resolving source, metric, reference period, initial/revised release, seasonal adjustment and output units before recording `route-review`. Do not tune on published outcomes or rewrite historical forecasts with them.

Add the following structure to numeric entries in the existing routes file bound to a full revision SHA. This is a format example; the actual definition must match the round's question.

```json
{
  "kind": "numeric",
  "numericContract": {
    "targetField": "quarterly_total_revenue",
    "definition": "Total revenue for the fiscal quarter named in the question, from the issuer's first earnings release; not net income or a segment's revenue.",
    "unit": "USD million",
    "scale": "One output unit equals one million USD.",
    "example": { "sourceValue": "USD 2.7 billion", "outputValue": 2700 },
    "acceptedUnits": [
      { "unit": "USD billion", "multiplier": 1000 },
      { "unit": "USD", "multiplier": 0.000001 }
    ]
  }
}
```

`targetField`, `definition`, `unit` and `scale` are required. `example` and `acceptedUnits` are optional. Conversion uses `canonicalValue = value * multiplier`; only positive multiplicative conversions are supported. Percentage points, percentage changes and index levels are different measurements, not interchangeable units. Tasks without a reliable settlement definition stop before model calls until the definition is supplied and reviewed.

Each model response must include a JSON number `value`, the exact `target_field`, and the `unit` actually used. The harness validates the field and unit, converts values and standard deviations, then aggregates. Raw responses and conversion provenance are retained. Undeclared units, missing or mismatched fields, prose values and empty strings cannot enter aggregation. Matching declarations cannot establish that research selected the right metric; the definition and evidence still need review.

Before writing a formal candidate, the final value and trial metadata are checked again. Numeric fallbacks for open questions and results without valid trials cannot produce a formal candidate. Failure records remain in the checkpoint; after fixing the issue, use `--resume --retry-fallbacks`. The default policy still permits explicitly labelled deterministic fallbacks for questions already closed at the evidence cutoff and excluded from research. Formal output requires 100% coverage and the strict validator, and only produces a local candidate.

New checkpoints and manifests carry `numericContractVersion: 1` and remain bound to the routes file hash. Old checkpoints cannot be resumed directly into new formal runs. Historical questions and results remain readable and scoreable through the default offline adapter. Adding labels to old predictions does not turn them into newly validated forecasts.

Regression tests cover equivalent measurements in different units, idempotent conversion, standard-deviation scaling, negative and zero values, percentages and fractions, wrong fields/units, malformed output, reused results and failed-candidate rejection. No current-round outcomes were used to tune forecast parameters, and no paid model calls were made.
