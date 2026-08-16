import { describe, expect, it } from "vitest";
import { ATTEMPT_REASON_LABELS, processingFallbackPresentation, safeProcessingErrorLabel, type HiveProcessingStatus } from "./processing-stages";

describe("processing-stage metadata", () => {
  it.each([
    ["queued", "Request queued…", ["dots"]], ["routing", "HIVE is selecting a route…", ["shimmer", "ring"]],
    ["searching", "Searching cited sources…", ["shimmer", "line"]], ["reading-files", "Scout is analyzing 2 files…", ["shimmer", "line"]],
    ["reasoning", "Reviewer is checking the response…", ["shimmer", "ring"]], ["waiting-first-token", "Waiting for model-a…", ["dots", "ring"]],
    ["streaming", "HIVE is responding…", ["shimmer"]], ["retrying", "Retrying route…", ["line"]],
    ["completed", "Response complete", []], ["cancelled", "Request cancelled", []], ["failed", "HIVE could not complete the request", []],
  ] as Array<[HiveProcessingStatus, string, string[]]>)('%s has one canonical presentation', (status, label, animations) => {
    expect(processingFallbackPresentation(status, 2, "model-a")).toEqual({ label, animations });
  });

  it("uses safe fallbacks for unknown error and attempt codes", () => {
    expect(safeProcessingErrorLabel("private-provider-detail")).toBe("HIVE could not complete the request");
    expect(ATTEMPT_REASON_LABELS["private-provider-detail"] || "Provider attempt did not complete").toBe("Provider attempt did not complete");
  });
});
