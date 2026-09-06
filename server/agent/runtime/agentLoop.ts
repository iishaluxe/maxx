import type { CapabilityObservation, CapabilityRequest } from "../execution";
import { DurableAgentRuntime } from "./durableRuntime";
import { RuntimeExecutor } from "./executor";
import { verifyObservation, type VerificationRequirement } from "./verification";

export type AgentPlanStep = {
  request: CapabilityRequest;
  verification?: VerificationRequirement;
};

export type AgentPlannerDecision =
  | AgentPlanStep
  | null
  | { kind: "step"; step: AgentPlanStep }
  | { kind: "no_work"; reason: string }
  | { kind: "failure"; reason: string };

export type AgentPlanner = (input: {
  snapshot: ReturnType<DurableAgentRuntime["snapshot"]>;
  previousObservation?: CapabilityObservation;
}) => Promise<AgentPlannerDecision>;

export type AgentRecovery = (input: {
  reason: string;
  snapshot: ReturnType<DurableAgentRuntime["snapshot"]>;
}) => Promise<AgentPlanStep | null>;

export type AgentLoopOptions = {
  planner: AgentPlanner;
  recovery?: AgentRecovery;
  maxCycles?: number;
};

export type AgentLoopResult = {
  status: "completed" | "blocked" | "cancelled" | "failed" | "waiting";
  cycles: number;
  reason?: string;
};

function failureReason(error: unknown) {
  return error instanceof Error ? error.message : "The planner failed without a readable reason.";
}

function isPlanStep(decision: AgentPlannerDecision): decision is AgentPlanStep {
  return decision !== null && !("kind" in decision);
}

export class AgentLoop {
  constructor(
    private readonly runtime: DurableAgentRuntime,
    private readonly executor: RuntimeExecutor,
    private readonly options: AgentLoopOptions,
  ) {}

  async run(): Promise<AgentLoopResult> {
    let cycles = this.runtime.getState().currentStep;
    let previousObservation: CapabilityObservation | undefined;
    const maxCycles = this.options.maxCycles ?? this.runtime.getState().maxSteps;

    while (cycles < maxCycles) {
      let state = this.runtime.getState();

      if (state.cancellationRequested) {
        this.runtime.cancel("Cancellation requested.");
        await this.runtime.persistLatestEvent();
        await this.runtime.persistCheckpoint();
        return { status: "cancelled", cycles };
      }

      if (["completed", "blocked", "failed", "cancelled"].includes(state.status)) {
        return { status: state.status as AgentLoopResult["status"], cycles };
      }

      // A persisted approval pause must remain paused until an approved caller
      // resumes the runtime; invoking the planner here would bypass that gate.
      if (state.status === "waiting") return { status: "waiting", cycles };

      if (state.status === "created") {
        this.runtime.start();
        await this.runtime.persistLatestEvent();
      }

      state = this.runtime.getState();
      if (state.status === "planning") {
        this.runtime.ready();
        await this.runtime.persistLatestEvent();
      }

      let decision: AgentPlannerDecision;
      try {
        decision = await this.options.planner({
          snapshot: this.runtime.snapshot(),
          previousObservation,
        });
      } catch (error) {
        const reason = failureReason(error);
        this.runtime.block(reason);
        await this.runtime.persistLatestEvent();
        await this.runtime.persistCheckpoint();
        return { status: "blocked", cycles, reason };
      }

      if (decision === null || ("kind" in decision && decision.kind === "no_work")) {
        const reason = decision === null ? "Planner returned no remaining work." : decision.reason;
        // A no-work decision can occur from ready or running. When ready, enter a
        // legal zero-action step before terminal completion rather than bypassing
        // the protected lifecycle with ready -> completed.
        if (this.runtime.getState().status === "ready") {
          this.runtime.setPhase("plan");
          this.runtime.beginStep("planner:no-work");
          this.runtime.completeStep({ reason });
        }
        this.runtime.complete(reason);
        await this.runtime.persistLatestEvent();
        await this.runtime.persistCheckpoint();
        return { status: "completed", cycles, reason };
      }

      if ("kind" in decision && decision.kind === "failure") {
        this.runtime.block(decision.reason);
        await this.runtime.persistLatestEvent();
        await this.runtime.persistCheckpoint();
        return { status: "blocked", cycles, reason: decision.reason };
      }

      const plan = isPlanStep(decision) ? decision : decision.step;
      this.runtime.setPhase("plan");
      await this.runtime.persistLatestEvent();

      const execution = await this.executor.execute(plan.request);
      cycles += 1;

      if (execution.kind === "denied") {
        return { status: "blocked", cycles, reason: execution.reason };
      }

      if (execution.kind === "approval_required") {
        return { status: "waiting", cycles, reason: execution.reason };
      }

      previousObservation = execution.observation;

      if (execution.observation.outcome === "connection_required") {
        this.runtime.block(execution.observation.output);
        await this.runtime.persistLatestEvent();
        await this.runtime.persistCheckpoint();
        return { status: "blocked", cycles, reason: execution.observation.output };
      }

      if (execution.observation.outcome === "cancelled") {
        // The executor already recorded failStep for a cancelled outcome but
        // left the runtime running; a cancelled action was never completed,
        // so it should never be run through verification.
        this.runtime.cancel(execution.observation.output || "Cancelled during execution.");
        await this.runtime.persistLatestEvent();
        await this.runtime.persistCheckpoint();
        return { status: "cancelled", cycles };
      }

      if (execution.observation.outcome === "failed") {
        // The executor has already called beginRecovery() for this outcome,
        // which moves the runtime to "recovering" and consumes one recovery
        // attempt. "recovering" -> "verifying" is not a legal transition, so
        // this branch must resolve recovery directly rather than falling
        // through to beginVerification() below, which would throw.
        const recovered = await this.attemptRecovery(execution.observation.output, cycles);
        if (recovered.terminal) return recovered.result;
        previousObservation = undefined;
        continue;
      }

      this.runtime.beginVerification();
      this.runtime.setPhase("verify");

      const verification = verifyObservation(
        execution.observation,
        plan.verification ?? {},
      );

      if (verification.passed) {
        this.runtime.verificationPassed(execution.observation.evidence);
        await this.runtime.persistLatestEvent();

        if (cycles < maxCycles) {
          // The explicitly authorized verifying -> ready transition permits the
          // next planning cycle while preserving the state-machine boundary.
          this.runtime.ready();
          this.runtime.setPhase("plan");
          await this.runtime.persistLatestEvent();
          await this.runtime.persistCheckpoint();
          continue;
        }

        this.runtime.complete({ verified: true, cycles });
        await this.runtime.persistLatestEvent();
        await this.runtime.persistCheckpoint();
        return { status: "completed", cycles };
      }

      const reason = verification.reasons.join(" ");
      this.runtime.verificationFailed(reason);

      state = this.runtime.getState();
      if (state.recoveryAttempts >= state.maxRecoveryAttempts) {
        this.runtime.fail(`Recovery budget exhausted: ${reason}`);
        await this.runtime.persistLatestEvent();
        await this.runtime.persistCheckpoint();
        return { status: "failed", cycles, reason };
      }

      this.runtime.beginRecovery(reason);
      await this.runtime.persistLatestEvent();

      const recovered = await this.attemptRecovery(reason, cycles, { alreadyBegun: true });
      if (recovered.terminal) return recovered.result;
      previousObservation = undefined;
    }

    this.runtime.block("Agent loop cycle budget exhausted.");
    await this.runtime.persistLatestEvent();
    await this.runtime.persistCheckpoint();
    return {
      status: "blocked",
      cycles,
      reason: "Agent loop cycle budget exhausted.",
    };
  }

  /**
   * Shared by both recovery entry points: a capability execution that
   * itself failed (runtime already in "recovering", attempt already
   * consumed by the executor), and a completed execution whose evidence
   * failed verification (runtime moved to "recovering" just above, by
   * this same call site, via beginRecovery()). Consolidated so the two
   * paths cannot drift out of sync with each other.
   */
  private async attemptRecovery(
    reason: string,
    cycles: number,
    options: { alreadyBegun?: boolean } = {},
  ): Promise<{ terminal: true; result: AgentLoopResult } | { terminal: false }> {
    if (!options.alreadyBegun) {
      const state = this.runtime.getState();
      if (state.recoveryAttempts >= state.maxRecoveryAttempts) {
        this.runtime.fail(`Recovery budget exhausted: ${reason}`);
        await this.runtime.persistLatestEvent();
        await this.runtime.persistCheckpoint();
        return { terminal: true, result: { status: "failed", cycles, reason } };
      }
    }

    if (!this.options.recovery) {
      this.runtime.block(`No recovery strategy configured: ${reason}`);
      await this.runtime.persistLatestEvent();
      await this.runtime.persistCheckpoint();
      return { terminal: true, result: { status: "blocked", cycles, reason } };
    }

    const recoveryPlan = await this.options.recovery({
      reason,
      snapshot: this.runtime.snapshot(),
    });

    if (!recoveryPlan) {
      this.runtime.block(`Recovery strategy returned no action: ${reason}`);
      await this.runtime.persistLatestEvent();
      await this.runtime.persistCheckpoint();
      return { terminal: true, result: { status: "blocked", cycles, reason } };
    }

    this.runtime.completeRecovery("planner-recovery");
    await this.runtime.persistLatestEvent();
    return { terminal: false };
  }
}
