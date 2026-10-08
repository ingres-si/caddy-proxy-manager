// SPDX-License-Identifier: Elastic-2.0
"use client";

/**
 * The Ask box (Analytics page, and the "Ask about traffic" dialog on
 * Compliance): a question in plain language goes to
 * POST /api/v1/analytics/questions, the answer shows under it, and it can be
 * saved (/api/v1/analytics/questions/saved) to run again with fresh data or
 * to add to a compliance report schedule. The API decides what is allowed;
 * without an AI provider or with questions turned off, the box explains why
 * it is read-only.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { Bookmark, Loader2, Play, Sparkles, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Pagination } from "@/components/ui/Pagination";
import { SectionCard } from "@/components/ui/SectionCard";
import { Skeleton } from "@/components/ui/skeleton";
import { paginate } from "@/src/lib/pagination";
import { MAX_QUESTION_LENGTH, type QuestionAnswer, type QuestionAvailability, type SavedQuestionView } from "../types";
import { AnswerView } from "./AnswerView";

const ASK_URL = "/api/v1/analytics/questions";
const SAVED_URL = "/api/v1/analytics/questions/saved";
/** Saved questions per page of the list under the Ask box. */
const SAVED_PER_PAGE = 10;

export const EXAMPLE_QUESTIONS = [
  "Which countries were blocked most in the last 7 days?",
  "Did 5xx errors go up in the last 24 hours?",
  "Which paths got the most WAF blocks this week?",
] as const;

async function send<T>(method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: body === undefined ? { Accept: "application/json" } : { "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: unknown = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const reported = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error ?? "") : "";
    throw new Error(reported || `The request failed (HTTP ${response.status})`);
  }
  return data as T;
}

function isAnswer(value: unknown): value is QuestionAnswer {
  return Boolean(value) && typeof value === "object" && typeof (value as QuestionAnswer).status === "string" && typeof (value as QuestionAnswer).question === "string";
}

export type AskPanelProps = {
  availability: QuestionAvailability;
  /** Built-in administrator: may delete others' shared questions. */
  isAdmin: boolean;
  /** May open AI settings to set up a provider (ai:read). */
  canOpenAiSettings: boolean;
  /** "card": a section of the Analytics page; "plain": inside a dialog. */
  variant?: "card" | "plain";
  /** Called after a question was saved, shared or deleted. */
  onSavedChange?: () => void;
};

function Unavailable({ availability, canOpenAiSettings }: Pick<AskPanelProps, "availability" | "canOpenAiSettings">) {
  if (!availability.analyticsEnabled) {
    return <Banner tone="info" title="Traffic analytics is off." />;
  }
  if (!availability.enabled) {
    return <Banner tone="info" title="Questions are turned off.">An administrator turned them off in the AI settings (AI settings).</Banner>;
  }
  if (!availability.providerConfigured) {
    return (
      <Banner
        tone="info"
        title="No AI provider is set up."
        actions={
          canOpenAiSettings ? (
            <Button asChild variant="outline" size="sm">
              <Link href="/settings/ai">Set up a provider</Link>
            </Button>
          ) : undefined
        }
      />
    );
  }
  return null;
}

function SavedList({
  saved,
  canRun,
  isAdmin,
  busy,
  onRun,
  onShare,
  onDelete,
}: {
  saved: SavedQuestionView[];
  canRun: boolean;
  isAdmin: boolean;
  busy: boolean;
  onRun: (question: SavedQuestionView) => void;
  onShare: (question: SavedQuestionView, shared: boolean) => void;
  onDelete: (question: SavedQuestionView) => void;
}) {
  const [page, setPage] = useState(1);
  if (saved.length === 0) return null;
  const shown = paginate(saved, page, SAVED_PER_PAGE);
  return (
    <div className="flex flex-col gap-1.5">
      <h3 className="m-0 text-[13px] font-semibold">Saved questions</h3>
      <ul className="m-0 flex list-none flex-col divide-y divide-line rounded-xl border border-line p-0" aria-label="Saved questions">
        {shown.items.map((question) => (
          <li key={question.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
            <span className="flex min-w-0 flex-[1_1_280px] flex-col">
              <span className="text-[13px] [overflow-wrap:anywhere]">{question.question}</span>
              <span className="text-xs text-soft [overflow-wrap:anywhere]">{question.interpretation}</span>
            </span>
            {question.shared && (
              <Badge variant="muted" title={question.owned ? "Shared with everyone who can read analytics" : `Shared by ${question.ownerName ?? "another user"}`}>
                <Users className="size-3" aria-hidden="true" />
                {question.owned ? "Shared" : (question.ownerName ?? "Shared")}
              </Badge>
            )}
            <span className="flex items-center gap-0.5">
              <Button variant="ghost" size="icon-sm" title="Run with fresh data" aria-label={`Run "${question.question}"`} disabled={!canRun || busy} onClick={() => onRun(question)}>
                <Play />
              </Button>
              {question.owned && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title={question.shared ? "Stop sharing" : "Share with everyone who can read analytics"}
                  aria-label={question.shared ? `Stop sharing "${question.question}"` : `Share "${question.question}"`}
                  aria-pressed={question.shared}
                  disabled={busy || (!question.shared && !canRun)}
                  onClick={() => onShare(question, !question.shared)}
                >
                  <Users />
                </Button>
              )}
              {(question.owned || (isAdmin && question.shared)) && (
                <Button variant="ghost" size="icon-sm" title="Delete" aria-label={`Delete "${question.question}"`} disabled={busy} onClick={() => onDelete(question)}>
                  <Trash2 />
                </Button>
              )}
            </span>
          </li>
        ))}
      </ul>
      <Pagination page={shown.page} perPage={SAVED_PER_PAGE} total={shown.total} noun="questions" label="Pages of saved questions" onPageChange={setPage} />
    </div>
  );
}

export function AskPanel({ availability, isAdmin, canOpenAiSettings, variant = "card", onSavedChange }: AskPanelProps) {
  const ready = availability.analyticsEnabled && availability.enabled && availability.providerConfigured;
  const [question, setQuestion] = useState("");
  const [asking, setAsking] = useState(false);
  const [answer, setAnswer] = useState<QuestionAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedQuestionView[]>([]);
  const [busy, setBusy] = useState(false);
  const [share, setShare] = useState(false);
  const [savedId, setSavedId] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let active = true;
    send<unknown>("GET", SAVED_URL)
      .then((data) => {
        if (active && Array.isArray(data)) setSaved(data as SavedQuestionView[]);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [tick]);

  const reload = useCallback(() => {
    setTick((t) => t + 1);
    onSavedChange?.();
  }, [onSavedChange]);

  async function run(request: () => Promise<unknown>) {
    setAsking(true);
    setError(null);
    setAnswer(null);
    setSavedId(null);
    try {
      const data = await request();
      if (!isAnswer(data)) throw new Error("The answer was not understood");
      setAnswer(data);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "The question could not be answered");
    } finally {
      setAsking(false);
    }
  }

  function ask(event?: FormEvent) {
    event?.preventDefault();
    const text = question.trim();
    if (text.length < 3 || asking) return;
    void run(() => send("POST", ASK_URL, { question: text }));
  }

  function runSaved(item: SavedQuestionView) {
    setQuestion(item.question);
    void run(() => send("POST", `${SAVED_URL}/${item.id}/run`)).then(() => setSavedId(item.id));
  }

  async function save() {
    if (!answer?.query) return;
    setBusy(true);
    try {
      const view = await send<SavedQuestionView>("POST", SAVED_URL, { question: answer.question, query: answer.query, shared: share });
      setSavedId(view.id);
      toast.success(share ? "Question saved and shared" : "Question saved");
      reload();
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "The question could not be saved");
    } finally {
      setBusy(false);
    }
  }

  async function change(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await action();
      toast.success(done);
      reload();
    } catch (failure) {
      toast.error(failure instanceof Error ? failure.message : "The change failed");
    } finally {
      setBusy(false);
    }
  }

  const saveSlot =
    answer?.status === "answered" && answer.query && ready ? (
      savedId !== null ? (
        <Badge variant="success">
          <Bookmark className="size-3" aria-hidden="true" />
          Saved
        </Badge>
      ) : (
        <span className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
            <Checkbox checked={share} onCheckedChange={(checked) => setShare(checked === true)} aria-label="Share with everyone who can read analytics" />
            Share
          </label>
          <Button variant="secondary" size="sm" onClick={() => void save()} disabled={busy}>
            <Bookmark aria-hidden="true" />
            Save question
          </Button>
        </span>
      )
    ) : null;

  const body = (
    <div className="flex min-w-0 flex-col gap-3.5">
      <Unavailable availability={availability} canOpenAiSettings={canOpenAiSettings} />
      <form onSubmit={ask} className="flex flex-wrap items-center gap-2" aria-label="Ask a question">
        <Input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          maxLength={MAX_QUESTION_LENGTH}
          placeholder="Which countries were blocked most last week on the shop hosts?"
          aria-label="Your question"
          disabled={!ready || asking}
          className="h-[38px] min-w-0 flex-[1_1_320px]"
        />
        <Button type="submit" className="h-[38px]" disabled={!ready || asking || question.trim().length < 3}>
          {asking ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
          Ask
        </Button>
      </form>
      {ready && !answer && !asking && !error && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-soft">
          <span>Try:</span>
          {EXAMPLE_QUESTIONS.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => setQuestion(example)}
              className="rounded-full border border-line px-2.5 py-0.5 text-xs text-muted-foreground hover:bg-raise hover:text-foreground"
            >
              {example}
            </button>
          ))}
        </div>
      )}
      {asking && (
        <div className="flex flex-col gap-2" aria-live="polite" aria-busy="true">
          <span className="text-[13px] text-muted-foreground">
            {availability.provider ? `Asking ${availability.provider.name}…` : "Running the question…"}
          </span>
          <Skeleton className="h-[120px] w-full rounded-xl" />
        </div>
      )}
      {error && (
        <Banner tone="bad" live>
          {error}
        </Banner>
      )}
      {answer && <AnswerView answer={answer} saveSlot={saveSlot} />}
      <SavedList
        saved={saved}
        canRun={ready}
        isAdmin={isAdmin}
        busy={busy || asking}
        onRun={runSaved}
        onShare={(item, shared) => void change(() => send("PATCH", `${SAVED_URL}/${item.id}`, { shared }), shared ? "Question shared" : "Question no longer shared")}
        onDelete={(item) => void change(() => send("DELETE", `${SAVED_URL}/${item.id}`), "Question deleted")}
      />
      <p className="m-0 text-xs text-soft">Your question is sent to the AI provider set up on AI settings.</p>
    </div>
  );

  if (variant === "plain") return body;
  return (
    <SectionCard
      id="ask"
      title="Ask about your traffic"
      padded
      divided={false}
      contentClassName="pt-0"
    >
      {body}
    </SectionCard>
  );
}
