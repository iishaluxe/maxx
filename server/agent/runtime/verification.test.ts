import { describe, expect, it } from "vitest";
import { verifyObservation } from "./verification";

const observation = {
  outcome: "completed" as const,
  output: "file created successfully",
  evidence: [{ kind: "exit", value: "0" }, { kind: "file", value: "created" }],
  adapterId: "test",
  startedAt: new Date(),
  completedAt: new Date(),
};

describe("runtime verification", () => {
  it("passes when all evidence requirements are satisfied", () => {
    const result = verifyObservation(observation, {
      requiredOutcome: "completed",
      requiredEvidence: ["exit:0", "file:created"],
      requiredOutputIncludes: ["created"],
    });

    expect(result.passed).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("fails with explicit reasons when evidence is missing", () => {
    const result = verifyObservation(observation, {
      requiredEvidence: ["exit:1"],
      requiredOutputIncludes: ["deleted"],
    });

    expect(result.passed).toBe(false);
    expect(result.reasons).toHaveLength(2);
  });
});
