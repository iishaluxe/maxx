import { describe, expect, it } from "vitest";
import { classifyRisk, evaluateCapabilityPolicy, maxRiskTier } from "./policy";

describe("classifyRisk", () => {
  it("uses the capability's static base tier from the registry", () => {
    expect(classifyRisk({ capability: "filesystem.read", target: "cloud_sandbox" })).toBe("low");
    expect(classifyRisk({ capability: "browser.interact", target: "cloud_sandbox" })).toBe("medium");
    expect(classifyRisk({ capability: "package.install", target: "cloud_sandbox" })).toBe("high");
    expect(classifyRisk({ capability: "secret.inject", target: "cloud_sandbox" })).toBe("critical");
  });

  it("escalates one tier when destructive", () => {
    expect(classifyRisk({ capability: "filesystem.read", target: "cloud_sandbox", destructive: true })).toBe("medium");
    expect(classifyRisk({ capability: "browser.interact", target: "cloud_sandbox", destructive: true })).toBe("high");
    expect(classifyRisk({ capability: "package.install", target: "cloud_sandbox", destructive: true })).toBe("critical");
  });

  it("caps escalation at critical rather than overflowing", () => {
    expect(classifyRisk({ capability: "secret.inject", target: "cloud_sandbox", destructive: true })).toBe("critical");
  });

  it("floors at high for local_bridge regardless of the capability's own tier", () => {
    expect(classifyRisk({ capability: "filesystem.read", target: "local_bridge" })).toBe("high");
  });

  it("does not lower an already-higher tier for local_bridge", () => {
    expect(classifyRisk({ capability: "secret.inject", target: "local_bridge" })).toBe("critical");
  });
});

describe("maxRiskTier", () => {
  it("returns whichever tier is higher", () => {
    expect(maxRiskTier("medium", "high")).toBe("high");
    expect(maxRiskTier("critical", "low")).toBe("critical");
    expect(maxRiskTier("medium", "medium")).toBe("medium");
  });
});

describe("evaluateCapabilityPolicy", () => {
  it("denies raw secrets outright, regardless of target", () => {
    const decision = evaluateCapabilityPolicy({ capability: "secret.inject", target: "cloud_sandbox", hasRawSecret: true });
    expect(decision.allowed).toBe(false);
    expect(decision.requiresApproval).toBe(false);
  });

  it("does not require approval for a low-tier capability with no escalation", () => {
    const decision = evaluateCapabilityPolicy({ capability: "shell.exec", target: "cloud_sandbox" });
    expect(decision.allowed).toBe(true);
    expect(decision.requiresApproval).toBe(false);
    expect(decision.risk).toBe("low");
  });

  it("requires approval once a low-tier capability is marked destructive", () => {
    const decision = evaluateCapabilityPolicy({ capability: "shell.exec", target: "cloud_sandbox", destructive: true });
    expect(decision.requiresApproval).toBe(true);
    expect(decision.risk).toBe("medium");
  });

  it("always requires approval for a capability with a medium-or-above base tier", () => {
    const decision = evaluateCapabilityPolicy({ capability: "browser.interact", target: "cloud_sandbox" });
    expect(decision.requiresApproval).toBe(true);
    expect(decision.risk).toBe("medium");
  });

  it("always requires approval for local_bridge, even for an otherwise-low-tier capability", () => {
    const decision = evaluateCapabilityPolicy({ capability: "filesystem.read", target: "local_bridge" });
    expect(decision.requiresApproval).toBe(true);
    expect(decision.risk).toBe("high");
  });
});
