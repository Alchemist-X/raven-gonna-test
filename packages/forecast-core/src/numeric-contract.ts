import { NumericAnswerSchema, type ForecastAnswer, type NumericTask } from "./contracts.js";

/** Validate model/imported answers before pooling. No target-field or unit is filled in for the model. */
export function normalizeNumericAnswer(task: NumericTask, input: unknown): Extract<ForecastAnswer, { kind: "numeric" }> {
  const answer = NumericAnswerSchema.parse(input);
  const contract = task.numericContract;
  if (!contract) return answer;
  if (answer.targetField !== contract.targetField) {
    throw new Error(`Numeric target_field mismatch: expected ${contract.targetField}, received ${answer.targetField ?? "missing"}.`);
  }
  const multiplier = answer.unit === contract.unit
    ? 1
    : contract.acceptedUnits?.find((entry) => entry.unit === answer.unit)?.multiplier;
  if (multiplier === undefined) {
    throw new Error(`Numeric unit mismatch: expected ${contract.unit} or a declared conversion, received ${answer.unit ?? "missing"}.`);
  }
  const value = answer.value * multiplier;
  if (!Number.isFinite(value)) throw new Error("Numeric unit conversion overflowed.");
  if ((task.minimum !== undefined && value < task.minimum) || (task.maximum !== undefined && value > task.maximum)) {
    throw new Error(`Numeric value ${value} violates the task's reviewed bounds.`);
  }
  if (answer.interval && answer.interval[0] > answer.interval[1]) throw new Error("Numeric interval is reversed.");
  return NumericAnswerSchema.parse({
    ...answer,
    value,
    unit: contract.unit,
    ...(answer.interval ? { interval: answer.interval.map((bound) => bound * multiplier) } : {}),
    ...(answer.unit !== contract.unit ? {
      normalization: { sourceUnit: answer.unit, sourceValue: answer.value, multiplier }
    } : {})
  });
}
