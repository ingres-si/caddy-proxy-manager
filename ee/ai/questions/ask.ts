// SPDX-License-Identifier: Elastic-2.0
/**
 * Plain-language analytics questions: asking one, and re-running a saved one.
 *
 *   question ──model──> JSON ──schema.ts──> QuestionQuery ──run.ts──> result
 *                                                   (analytics layer, bound parameters,
 *                                                    the asker's tag scope)
 *   result ──(aggregates, placeholders)──model──> summary   (optional)
 *
 * Nothing the model returns runs unvalidated: an answer that is not one of
 * the three allowed shapes, or a query outside the allow-lists, is refused
 * and nothing runs. Ambiguous questions get a clarification, and questions
 * traffic data cannot answer say so.
 *
 * Bounded: questions of at most 500 characters, at most two model calls per
 * question (each one call, no tools, no retries, the provider's timeout and 1024 output
 * tokens), one question at a time per user, 10 per 10 minutes and 100 per
 * day per user, and ClickHouse's own 30 s limit per query.
 *
 * Every question is recorded in the audit log: who asked, the question, the
 * outcome and the query that ran. Asking needs questions to be on in the AI
 * settings; the caller's analytics:read is checked by the route.
 */
import { logAuditEvent } from "@/src/lib/audit";
import { ApiClientError, ApiValidationError } from "@/src/lib/api-errors";
import { getRetentionDays } from "@/src/lib/clickhouse/client";
import { createRateLimiter, type RateLimiter } from "@/src/lib/rate-limit";
import { scopeTagsFor, type Access } from "@/src/lib/permissions";
import { listProxyHosts } from "@/src/lib/models/proxy-hosts";
import { allProxyHostDomains } from "@/src/lib/analytics/service";
import { requestModelText, sanitizeExplanation } from "@/ee/ai/explain";
import { getAiProviderConfig, type ResolvedAiProvider } from "@/ee/ai/settings";
import { analyticsHrefFor, computedSummary, describeQuery, formatPeriod } from "./describe";
import { buildInterpretationPrompt, buildSummaryPrompt, restorePlaceholders } from "./prompts";
import { runQuestionQuery, seenHosts, type QuestionScope } from "./run";
import { getSavedQuestionRow } from "./saved";
import { parseModelAnswer, parseQuestionQuery, parseQuestionText } from "./schema";
import { getQuestionSettings } from "./settings";
import { QUESTION_RATE_LIMITS, type QuestionAnswer, type QuestionPrivacy, type QuestionQuery, type QuestionSettingsView, type QuestionSummary } from "./types";

/** Longest model answer read for the interpretation (a query is far shorter). */
const MAX_INTERPRETATION_CHARS = 6000;
const MAX_SUMMARY_CHARS = 700;

/** Thrown when the AI provider could not interpret the question; answered with 502 and its safe message. */
export class AiQuestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiQuestionError";
  }
}

// ── Rate limits ───────────────────────────────────────────────────────

function limiters(): { short: RateLimiter; daily: RateLimiter; busy: Set<number> } {
  // registerAttempt blocks on the attempt that reaches maxAttempts, so allow one more.
  const short = createRateLimiter({ name: "ai-questions-short", maxAttempts: QUESTION_RATE_LIMITS.short.maxQuestions + 1, windowMs: QUESTION_RATE_LIMITS.short.windowMs, blockMs: "window" });
  const daily = createRateLimiter({ name: "ai-questions-daily", maxAttempts: QUESTION_RATE_LIMITS.daily.maxQuestions + 1, windowMs: QUESTION_RATE_LIMITS.daily.windowMs, blockMs: "window" });
  // Questions being answered, per user: this process's only (a user waiting
  // on one replica could start another on a second; the limits still count both).
  return { short, daily, busy: new Set() };
}

const store = globalThis as typeof globalThis & { __ingressiQuestionLimits?: ReturnType<typeof limiters> };
let limits = (store.__ingressiQuestionLimits ??= limiters());

/** Starts every user's limits afresh (tests). */
export async function resetQuestionRateLimits(): Promise<void> {
  await limits.short.clear();
  await limits.daily.clear();
  limits = store.__ingressiQuestionLimits = limiters();
}

function minutes(ms: number): string {
  const n = Math.max(1, Math.ceil(ms / 60_000));
  return n >= 120 ? `${Math.ceil(n / 60)} hours` : `${n} minute${n === 1 ? "" : "s"}`;
}

/** Counts one question for the user; 429 when they are over a limit or already waiting for an answer. */
async function admitQuestion(userId: number): Promise<() => void> {
  if (limits.busy.has(userId)) throw new ApiClientError("Your previous question is still being answered; wait for it first", 429);
  const key = `user:${userId}`;
  for (const limiter of [limits.short, limits.daily]) {
    const state = await limiter.isRateLimited(key);
    if (state.blocked) throw new ApiClientError(`Too many questions; try again in ${minutes(state.retryAfterMs ?? 0)}`, 429);
  }
  if (limits.busy.has(userId)) throw new ApiClientError("Your previous question is still being answered; wait for it first", 429);
  limits.busy.add(userId);
  try {
    const short = await limits.short.registerAttempt(key);
    const daily = await limits.daily.registerAttempt(key);
    const blocked = short.blocked ? short : daily.blocked ? daily : null;
    if (blocked) throw new ApiClientError(`Too many questions; try again in ${minutes(blocked.retryAfterMs ?? 0)}`, 429);
  } catch (error) {
    limits.busy.delete(userId);
    throw error;
  }
  return () => limits.busy.delete(userId);
}

// ── Dependencies ──────────────────────────────────────────────────────

export type AskDependencies = {
  provider: () => Promise<ResolvedAiProvider | null>;
  model: typeof requestModelText;
  now: () => Date;
  /** The asker's scope; the default reads their tag scope. */
  scope: (access: Access) => Promise<QuestionScope>;
};

/**
 * What a question may read for `access`: every host (analytics:read covers
 * them all), and as host tags only the proxy hosts their role's tag scope
 * reaches.
 */
export async function questionScopeFor(access: Access): Promise<QuestionScope> {
  const visible = await listProxyHosts(scopeTagsFor(access, "proxy_hosts"));
  return {
    taggableHosts: visible.map((host) => ({ id: host.id, domains: host.domains, tags: host.tags })),
    allHosts: await allProxyHostDomains(),
    seenHosts,
    audience: "asker",
  };
}

export const defaultAskDependencies: AskDependencies = {
  provider: getAiProviderConfig,
  model: requestModelText,
  now: () => new Date(),
  scope: questionScopeFor,
};

function dependencies(overrides: Partial<AskDependencies>): AskDependencies {
  return { ...defaultAskDependencies, ...overrides };
}

const PROVIDER_NAMES: Record<string, string> = { anthropic: "Anthropic", openai_compatible: "your OpenAI-compatible server" };

function privacyOf(provider: ResolvedAiProvider, summary: boolean, requestDetails: boolean, query: QuestionQuery | null): QuestionPrivacy {
  const sent = ["your question and the query schema"];
  if (summary) {
    const detailWords = requestDetails
      ? "client addresses, user agents and paths included"
      : query && ["ip", "user_agent", "path"].includes(query.breakdown)
        ? "client addresses, user agents and paths replaced by placeholders"
        : null;
    sent.push(`the aggregated result${detailWords ? ` (${detailWords})` : ""}`);
  }
  return {
    provider: provider.provider,
    model: provider.model,
    interpretation: true,
    summary,
    requestDetails,
    description: `Sent to ${PROVIDER_NAMES[provider.provider] ?? provider.provider} (${provider.model}): ${sent.join(", then ")}. The query ran here; no log lines or raw requests were sent.`,
  };
}

function answerShell(question: string, now: Date): QuestionAnswer {
  return {
    status: "unsupported",
    question,
    message: null,
    query: null,
    interpretation: null,
    analyticsHref: null,
    result: null,
    summary: null,
    summaryError: null,
    privacy: null,
    askedAt: now.toISOString(),
  };
}

async function audit(access: Access, answer: QuestionAnswer, extra: Record<string, unknown>): Promise<void> {
  const outcome = answer.status === "answered" ? "answered" : answer.status === "clarify" ? "asked back" : "not answerable";
  await logAuditEvent({
    userId: access.userId,
    action: "analytics_question_asked",
    entityType: "analytics_question",
    summary: `Asked "${answer.question.slice(0, 160)}" (${outcome})`,
    data: {
      question: answer.question,
      status: answer.status,
      query: answer.query,
      interpretation: answer.interpretation,
      provider: answer.privacy?.provider ?? null,
      model: answer.privacy?.model ?? null,
      summary: answer.summary?.source ?? null,
      requestDetailsSent: answer.privacy?.requestDetails ?? false,
      ...extra,
    },
  });
}

/**
 * Runs `query` for `access` and fills `answer` with the result, the query
 * in words, the link and the summary (by the model when the settings and a
 * provider allow, otherwise computed).
 */
async function answerWith(
  access: Access,
  answer: QuestionAnswer,
  query: QuestionQuery,
  settings: QuestionSettingsView,
  provider: ResolvedAiProvider | null,
  deps: AskDependencies
): Promise<QuestionAnswer> {
  const now = deps.now();
  const run = await runQuestionQuery(query, await deps.scope(access), { now: Math.floor(now.getTime() / 1000) });
  if (run.kind === "clarify") {
    return { ...answer, status: "clarify", message: run.message, query, privacy: provider ? privacyOf(provider, false, false, query) : null };
  }
  const { result, range, tagHosts } = run;
  const link = analyticsHrefFor(query, { start: range.start, end: range.end, preset: range.preset }, tagHosts);
  if (!link.complete) result.notes.push("The Analytics page link shows every host: the hosts with these tags do not fit in its filters.");
  const interpretation = describeQuery(query, range);
  let summary: QuestionSummary = { text: computedSummary(result, formatPeriod(range.start, range.end)), source: "computed" };
  let summaryError: string | null = null;
  let summarySent = false;
  let requestDetails = false;
  if (provider && settings.aiSummaries && result.status === "ok") {
    const built = buildSummaryPrompt({ question: answer.question, query, result, shareRequestDetails: settings.shareRequestDetails });
    summarySent = true;
    requestDetails = built.requestDetails;
    const reply = await deps.model(provider, built.prompt, { maxChars: MAX_SUMMARY_CHARS, refusalMessage: "The model declined to summarise the result" });
    if (reply.ok) {
      const text = sanitizeExplanation(restorePlaceholders(reply.text, built.placeholders), MAX_SUMMARY_CHARS * 2);
      if (text) summary = { text, source: "ai" };
      else summaryError = "The model returned no summary";
    } else {
      summaryError = reply.error;
    }
  }
  return {
    ...answer,
    status: "answered",
    query,
    interpretation,
    analyticsHref: link.href,
    result,
    summary,
    summaryError,
    privacy: provider ? privacyOf(provider, summarySent, requestDetails, query) : null,
  };
}

async function requireQuestionsOn(): Promise<QuestionSettingsView> {
  const settings = await getQuestionSettings();
  if (!settings.enabled) throw new ApiClientError("Analytics questions are turned off in the AI settings", 409);
  return settings;
}

/**
 * Asks a question ({question}) for `access`. Needs questions turned on and
 * an AI provider. Throws AiQuestionError (502) when the provider fails to
 * interpret it; every other outcome is an answer.
 */
export async function askQuestion(access: Access, body: unknown, overrides: Partial<AskDependencies> = {}): Promise<QuestionAnswer> {
  const deps = dependencies(overrides);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ApiValidationError("Request body must be a JSON object");
  for (const key of Object.keys(body)) {
    if (key !== "question") throw new ApiValidationError(`Unknown field "${key.slice(0, 40)}" in the question`);
  }
  const question = parseQuestionText((body as Record<string, unknown>).question);
  const settings = await requireQuestionsOn();
  const provider = await deps.provider().catch(() => null);
  if (!provider) throw new ApiValidationError("Enable and configure an AI provider first (AI settings)");

  const release = await admitQuestion(access.userId);
  const now = deps.now();
  const shell = answerShell(question, now);
  try {
    const reply = await deps.model(
      provider,
      buildInterpretationPrompt(question, { now, retentionDays: getRetentionDays() }),
      { maxChars: MAX_INTERPRETATION_CHARS, refusalMessage: "The model declined to interpret this question" }
    );
    if (!reply.ok) {
      await audit(access, { ...shell, privacy: privacyOf(provider, false, false, null) }, { error: reply.error });
      throw new AiQuestionError(`The question could not be interpreted: ${reply.error}`);
    }
    const parsed = parseModelAnswer(reply.text);
    let answer: QuestionAnswer;
    if (parsed.kind === "clarify") {
      answer = { ...shell, status: "clarify", message: parsed.message, privacy: privacyOf(provider, false, false, null) };
    } else if (parsed.kind === "unsupported") {
      answer = { ...shell, status: "unsupported", message: `Cannot answer that from traffic data: ${parsed.message}`, privacy: privacyOf(provider, false, false, null) };
    } else if (parsed.kind === "invalid") {
      answer = {
        ...shell,
        message: `The model's answer could not be used (${parsed.reason}), so nothing was run. Try asking in other words.`,
        privacy: privacyOf(provider, false, false, null),
      };
      await audit(access, answer, { refused: parsed.reason });
      return answer;
    } else {
      let query: QuestionQuery;
      try {
        query = parseQuestionQuery(parsed.query);
      } catch (error) {
        if (!(error instanceof ApiValidationError)) throw error;
        answer = {
          ...shell,
          message: `The model read the question as something the analytics cannot run (${error.message}), so nothing was run.`,
          privacy: privacyOf(provider, false, false, null),
        };
        await audit(access, answer, { refused: error.message });
        return answer;
      }
      answer = await answerWith(access, shell, query, settings, provider, deps);
    }
    await audit(access, answer, {});
    return answer;
  } finally {
    release();
  }
}

/**
 * Re-runs a saved question with fresh data, without asking the model to
 * interpret it again (the summary still comes from the model when the
 * settings allow and a provider is configured). Needs questions turned on.
 */
export async function runSavedQuestion(access: Access, id: number, overrides: Partial<AskDependencies> = {}): Promise<QuestionAnswer> {
  const deps = dependencies(overrides);
  const { row, query } = await getSavedQuestionRow(access, id);
  const settings = await requireQuestionsOn();
  const provider = settings.aiSummaries ? await deps.provider().catch(() => null) : null;
  const release = await admitQuestion(access.userId);
  try {
    const answer = await answerWith(access, answerShell(row.question, deps.now()), query, settings, provider, deps);
    await audit(access, answer, { savedQuestionId: row.id });
    return answer;
  } finally {
    release();
  }
}
