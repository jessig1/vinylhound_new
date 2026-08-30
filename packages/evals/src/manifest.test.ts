import { describe, expect, it } from "vitest";

import { selectRunnableCases } from "./manifest.js";
import { evaluationCase, evaluationManifest } from "./test-fixture.js";

describe("selectRunnableCases", () => {
  it("selects verified and consented cases by split", () => {
    const development = evaluationCase({
      caseId: "vh-002",
      split: "development",
    });
    const selected = selectRunnableCases(
      evaluationManifest([evaluationCase(), development]),
      { split: "holdout" },
    );

    expect(selected.map((item) => item.caseId)).toEqual(["vh-001"]);
  });

  it("rejects cases whose labels are not verified", () => {
    const unverified = evaluationCase({
      groundTruth: {
        ...evaluationCase().groundTruth,
        maintainerVerified: false,
      },
    });

    expect(() =>
      selectRunnableCases(evaluationManifest([unverified]), {
        split: "holdout",
      }),
    ).toThrow("ground truth not maintainer-verified");
  });

  it("rejects unknown explicit case IDs", () => {
    expect(() =>
      selectRunnableCases(evaluationManifest(), {
        split: "all",
        caseIds: ["missing"],
      }),
    ).toThrow("Unknown case IDs: missing");
  });
});
