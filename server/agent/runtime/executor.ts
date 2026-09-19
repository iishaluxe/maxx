import {
  CapabilityBroker,
  type CapabilityDispatchResult,
  type CapabilityRequest,
  type CapabilityObservation,
} from "../execution";
import { DurableAgentRuntime } from "./durableRuntime";

export type RuntimeExecutionResult =
  | { kind: "denied"; reason: string }
  | { kind: "approval_required"; reason: string }
  | { kind: "observation"; observation: CapabilityObservation };

export class RuntimeExecutor {
  constructor(
    private readonly broker: CapabilityBroker,
    private readonly runtime: DurableAgentRuntime,
  ) {}

  async execute(request: CapabilityRequest): Promise<RuntimeExecutionResult> {
    const fingerprint =
      `${request.capability}:${request.action}:${JSON.stringify(request.arguments)}`;

    this.runtime.setPhase("act");
    this.runtime.beginStep(fingerprint);
    await this.runtime.persistLatestEvent();

    let result: CapabilityDispatchResult;

    try {
      result = await this.broker.dispatch(request);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);

      this.runtime.failStep({ reason });
      this.runtime.recordObservation({
        outcome: "failed",
        reason,
      });
      this.runtime.beginRecovery(reason);

      await this.runtime.persistLatestEvent();

      return {
        kind: "observation",
        observation: {
          outcome: "failed",
          output: reason,
          evidence: [{ kind: "runtime", value: "dispatch-error" }],
          adapterId: "broker",
          startedAt: new Date(),
          completedAt: new Date(),
        },
      };
    }

    if (result.kind === "denied") {
      this.runtime.block(result.reason);
      await this.runtime.persistLatestEvent();
      await this.runtime.persistCheckpoint();
      return result;
    }

    if (result.kind === "approval_required") {
      this.runtime.wait(result.reason);
      await this.runtime.persistLatestEvent();
      await this.runtime.persistCheckpoint();
      return result;
    }

    this.runtime.setPhase("observe");
    this.runtime.recordObservation({
      outcome: result.observation.outcome,
      adapterId: result.observation.adapterId,
      evidence: result.observation.evidence,
      output: result.observation.output,
    });

    if (result.observation.outcome === "failed") {
      this.runtime.failStep({
        adapterId: result.observation.adapterId,
        output: result.observation.output,
      });
      this.runtime.beginRecovery(result.observation.output);
    } else if (result.observation.outcome === "cancelled") {
      this.runtime.failStep({
        adapterId: result.observation.adapterId,
        output: result.observation.output,
      });
    } else {
      this.runtime.completeStep({
        adapterId: result.observation.adapterId,
      });
    }

    await this.runtime.persistLatestEvent();
    await this.runtime.persistCheckpoint();

    return result;
  }
}
