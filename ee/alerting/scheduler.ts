// SPDX-License-Identifier: Elastic-2.0
/**
 * Runs the alert evaluator every minute. Started from src/instrumentation.ts
 * (never in tests).
 */
import { runAlertEvaluation } from "./engine";
import { ensureBuiltInAlertRulesOnce } from "./builtins";
import { onShutdown } from "@/src/lib/shutdown";

export const ALERT_EVALUATION_INTERVAL_MS = 60_000;
/** Lets Caddy, ClickHouse and the first config apply settle after a restart. */
const FIRST_RUN_DELAY_MS = 30_000;

const store = globalThis as typeof globalThis & {
  __ingressiAlertEvaluator?: { interval: ReturnType<typeof setInterval> | null; running: boolean };
};
const state = (store.__ingressiAlertEvaluator ??= { interval: null, running: false });

/** One run, skipped while the previous one is still delivering. */
export async function runScheduledAlertEvaluation(): Promise<void> {
  if (state.running) return;
  state.running = true;
  try {
    await ensureBuiltInAlertRulesOnce().catch((error) => {
      console.warn("[alerting] Built-in alert rules could not be added:", error instanceof Error ? error.name : typeof error);
    });
    const summary = await runAlertEvaluation();
    if (summary.fired > 0 || summary.resolved > 0) {
      console.log(
        `[alerting] ${summary.fired} alert(s) fired, ${summary.resolved} resolved, ${summary.notifications} notification(s) sent`
      );
    }
  } catch (error) {
    console.error("[alerting] Alert evaluation failed:", error instanceof Error ? error.name : typeof error);
  } finally {
    state.running = false;
  }
}

/** The pending first run, so stopping (a PostgreSQL replica that stops leading) cancels it too. */
let firstRun: ReturnType<typeof setTimeout> | undefined;

export function startAlertEvaluator(): void {
  if (state.interval) return;
  clearTimeout(firstRun);
  firstRun = setTimeout(() => void runScheduledAlertEvaluation(), FIRST_RUN_DELAY_MS);
  firstRun.unref?.();
  state.interval = setInterval(() => void runScheduledAlertEvaluation(), ALERT_EVALUATION_INTERVAL_MS);
  state.interval.unref?.();
  onShutdown("stopping the alert evaluator", stopAlertEvaluator);
}

export function stopAlertEvaluator(): void {
  clearTimeout(firstRun);
  firstRun = undefined;
  if (state.interval) clearInterval(state.interval);
  state.interval = null;
}
