/**
 * Answer generation pipeline — instructions §4a, PRD §9.5.
 *
 * queued -> retrieving -> answering -> answered | unsupported | failed | dead_lettered
 *
 * DEPLOYMENT LIMITATION, stated plainly (mirroring document.worker.ts): this is
 * an in-process worker. Jobs live in the Node process, so a restart mid-job
 * leaves a query stuck in `retrieving`/`answering`. `recoverStuckQueries()`
 * resets those on boot, which is adequate for a single instance but is NOT a
 * substitute for a durable queue. A second instance will claim the same row and
 * nothing in the shortcut prevents it. THE TRIGGER THAT ENDS THIS SHORTCUT IS
 * HORIZONTAL SCALING; the seam is `enqueueQuery`, the only entry point.
 *
 * THE ORDERED PIPELINE, with the model call numbered so a reviewer can check
 * it at a glance:
 *   1. atomic claim
 *   2. RE-RESOLVE AUTHORIZATION (the asker may have been deactivated or had a
 *      grant revoked since the ask)
 *   3. authorization-filtered retrieval
 *   4. injection scan + withholding (inside retrieval)
 *   5. escape + opaque ref assignment (inside retrieval)
 *   6. getAiProvider().answer(...) — THE FIRST AND ONLY MODEL INVOCATION,
 *      raced against AI_ANSWER_TIMEOUT_MS
 *   7. validateCitations
 *   8. sanitiseAnswer
 *   9. persist terminal status
 *  10. audit, cache invalidation, term indexing
 */
import { Types } from 'mongoose';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { invalidateForSubsidiary } from '../../utils/aggregateCache.js';
import { getAiProvider } from '../../services/ai/index.js';
import { newContextNonce } from '../../services/ai/prompt.js';
import { recordAudit } from '../audit/audit.service.js';
import { openConflictsForDocuments } from '../documents/conflictDetection.js';
import { User } from '../users/user.model.js';
import { TopicCache } from '../topics/topicCache.model.js';
import { AnalyticsCache } from '../analytics/analyticsCache.model.js';
import { MetricsCache } from '../dashboard/metricsCache.model.js';
import { indexQueryTerms } from '../topics/termIndexer.js';
import {
  QueryModel,
  type AnswerStatus,
  type QueryCitation,
  type QueryInjectionFlag,
  type QueryStatus,
} from './query.model.js';
import { retrievePassages, type RetrievalResult } from './retrieval.service.js';
import { validateCitations, sanitiseAnswer } from './citation.js';

/** Tracks in-flight work so tests (and shutdown) can await quiescence. */
const inFlight = new Set<Promise<void>>();

export function enqueueQuery(queryId: string): void {
  const job = processQuery(queryId).catch((err: unknown) => {
    logger.error('Query processing crashed', {
      queryId,
      message: err instanceof Error ? err.message : String(err),
    });
  });
  inFlight.add(job);
  void job.finally(() => inFlight.delete(job));
}

/**
 * Track a deferred follow-up so `drainQueries()` means what it says.
 *
 * The term index and the cache invalidation at the end of `processQuery` are
 * deliberately not awaited on the answering path: the answer is already
 * durable by the time they run, and a failure in either must not fail the
 * answer. But firing them as bare `void` expressions left them outside
 * `inFlight`, so a caller that awaited quiescence could still observe a stale
 * cache or a missing term row — a race that surfaces as an intermittently
 * empty word cloud rather than as an error.
 */
function trackDeferred(work: Promise<unknown>): void {
  const job = work.then(
    () => undefined,
    (err: unknown) => {
      logger.error('Deferred query follow-up failed', {
        message: err instanceof Error ? err.message : String(err),
      });
    },
  );
  inFlight.add(job);
  void job.finally(() => inFlight.delete(job));
}

/**
 * Await all queued answering AND its deferred follow-ups — used by tests and
 * graceful shutdown. The loop re-checks because a tracked follow-up is added
 * while the job that scheduled it is still in the set.
 */
export async function drainQueries(): Promise<void> {
  while (inFlight.size > 0) await Promise.all([...inFlight]);
}

export function canRetryQuery(attempts: number, maxAttempts: number): boolean {
  return attempts < maxAttempts;
}

/** No timers, no dependency — a hosted provider must not be able to wedge the pipeline. */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      const t = setTimeout(() => reject(new Error('Answer generation timed out')), ms);
      // `.catch` BEFORE `.finally`: `p.finally(...)` returns a derived promise
      // that adopts p's rejection, and nothing handles that derivative. A
      // provider that rejects asynchronously — the normal shape for any hosted
      // adapter — would therefore be handled correctly by the caller AND ALSO
      // escape as an unhandledRejection, which server.ts logs verbatim. That
      // log line is the raw provider error, carrying exactly the endpoint and
      // stack detail §9.4 keeps out of `failureReason`.
      void p.catch(() => undefined).finally(() => clearTimeout(t));
    }),
  ]);
}

export async function processQuery(queryId: string): Promise<void> {
  const id = new Types.ObjectId(queryId);

  // ── 1. Claim atomically. A null result means someone else claimed it,
  //       which is what makes a double enqueue harmless.
  const claimed = await QueryModel.findOneAndUpdate(
    { _id: id, status: { $in: ['queued', 'failed'] }, isDeleted: false },
    {
      $set: {
        status: 'retrieving',
        processingStartedAt: new Date(),
        lastAttemptAt: new Date(),
      },
      // $unset, NOT `$set: { failureReason: undefined }` — Mongoose strips
      // undefined values out of an update object, so the field would survive a
      // successful retry and GET /queries/:id would return an `answered` query
      // still carrying the reason it failed the previous time.
      $unset: { failureReason: '' },
      $inc: { attempts: 1 },
    },
    { returnDocument: 'after' },
  );
  if (!claimed) return;

  const subsidiaryIds = claimed.contextScope.subsidiaryIds;

  try {
    // ── 2. RE-RESOLVE AUTHORIZATION AT PROCESSING TIME.
    //
    // The job runs asynchronously, so a grant revoked — or a user deactivated —
    // between ask and answer must NOT be honoured. §9.1 requires subsidiary
    // access to be evaluated on EVERY protected operation, not just at request
    // time, and this async gap is a protected operation.
    const asker = await User.findOne({ _id: claimed.askedBy, isDeleted: false }).lean();
    const stillGranted =
      asker !== null &&
      asker.isActive &&
      (asker.role === 'admin' ||
        subsidiaryIds.every((s) => (asker.subsidiaryAccess ?? []).some((g) => String(g) === String(s))));

    if (!stillGranted) {
      await QueryModel.updateOne(
        { _id: id },
        {
          $set: {
            status: 'failed',
            failureReason: 'Access to the queried subsidiaries is no longer available',
          },
        },
      );
      await recordAudit({
        action: 'query.scope_revoked',
        // §9.6 requires audit history to be searchable by authorized users, and
        // audit.routes.ts scopes a non-admin to `subsidiaryId IN grants OR
        // userId = me`. A row carrying neither matches neither, so it exists
        // and is unreadable — including by the person it is about.
        userId: String(claimed.askedBy),
        targetType: 'Query',
        targetId: queryId,
        subsidiaryId: subsidiaryIds.length === 1 ? String(subsidiaryIds[0]) : undefined,
        metadata: { scopeSize: subsidiaryIds.length },
      });
      return;
    }

    // ── 3-5. Authorization-filtered retrieval, injection scan, escaping, refs.
    const nonce = newContextNonce();
    const retrieval = await retrievePassages({
      questionText: claimed.questionText,
      scopeSubsidiaryIds: subsidiaryIds,
      documentIds: claimed.contextScope.documentIds,
      nonce,
    });

    if (retrieval.flags.length > 0) {
      await recordAudit({
        action: 'query.injection_suspected',
        userId: String(claimed.askedBy),
        targetType: 'Query',
        targetId: queryId,
        subsidiaryId: subsidiaryIds.length === 1 ? String(subsidiaryIds[0]) : undefined,
        metadata: {
          // Rule ids and counts only — NEVER the offending text (§9.6).
          ruleIds: [...new Set(retrieval.flags.map((f) => f.ruleId))],
          flagged: retrieval.flags.length,
          withheld: retrieval.withheld,
        },
      });
    }

    // Zero surviving passages is a terminal, honest answer — not a failure and
    // not an occasion to broaden the search. The provider is not invoked.
    if (retrieval.refs.length === 0) {
      await finish(id, {
        askedBy: String(claimed.askedBy),
        subsidiaryIds: subsidiaryIds.map(String),
        status: 'unsupported',
        answerStatus: 'unsupported',
        responseText:
          'The authorised source material available to you does not contain enough information to answer this question.',
        retrieval,
        provider: getAiProvider().name,
        promptVersion: getAiProvider().promptVersion,
        generationMs: 0,
        citations: [],
        discarded: 0,
      });
      return;
    }

    await QueryModel.updateOne({ _id: id }, { $set: { status: 'answering' } });

    // ── 6. THE FIRST AND ONLY MODEL INVOCATION.
    const provider = getAiProvider();
    const startedAt = Date.now();
    const result = await withTimeout(
      provider.answer({
        question: claimed.questionText,
        passages: retrieval.refs.map((ref) => {
          const r = retrieval.byRef.get(ref)!;
          return { ref, text: r.passageText, pageNumber: r.pageNumber, section: r.section };
        }),
        style: claimed.isParliamentary ? 'parliamentary' : 'standard',
        maxAnswerChars: env.AI_MAX_ANSWER_CHARS,
        nonce,
      }),
      env.AI_ANSWER_TIMEOUT_MS,
    );
    const generationMs = Date.now() - startedAt;

    // ── 7. Citation validation against the refs ACTUALLY issued.
    const authorized = new Set(subsidiaryIds.map(String));
    const { citations, discarded, acceptedRefs } = validateCitations(
      result.citedRefs,
      result.answerText,
      retrieval.byRef,
      authorized,
    );

    if (discarded > 0) {
      // A separate audit ROW, not metadata on query.answered, so an
      // operational alert can key on the action alone. A spike here is the
      // system's primary fabricated-citation signal.
      await recordAudit({
        action: 'query.citation_discarded',
        userId: String(claimed.askedBy),
        targetType: 'Query',
        targetId: queryId,
        subsidiaryId: subsidiaryIds.length === 1 ? String(subsidiaryIds[0]) : undefined,
        metadata: { discarded, accepted: citations.length, provider: provider.name },
      });
    }

    // ── 8. Rewrite markers, strip unresolved ones and any ObjectId-shaped run.
    const refOrdinal = new Map<string, number>();
    for (const c of citations) {
      for (const [ref, r] of retrieval.byRef) {
        if (String(r.chunkId) === String(c.chunkId)) refOrdinal.set(ref, c.ordinal);
      }
    }
    const responseText = sanitiseAnswer(
      result.answerText,
      citations,
      acceptedRefs,
      refOrdinal,
      env.AI_MAX_ANSWER_CHARS,
    );

    const answerStatus: AnswerStatus =
      citations.length === 0 ? 'unsupported' : discarded > 0 ? 'partially_sourced' : 'sourced';

    /**
     * ── 8b. §4.5 — do the CITED documents contradict each other on what was
     * actually asked?
     *
     * Computed here rather than inside `finish`, because relevance needs the
     * question and `FinishArgs` deliberately excludes it: that type feeds the
     * audit row, which must never carry question or answer text (§9.5, §9.6).
     * Only the metric labels and the disputed figures cross into it.
     */
    const conflictingMetrics = (
      await openConflictsForDocuments(
        [...new Set(citations.map((c) => String(c.documentId)))].map((v) => new Types.ObjectId(v)),
        { questionText: claimed.questionText, answerText: responseText },
      )
    ).map((c) => ({
      metricLabel: c.metricLabel,
      reason: c.reason,
      ...(c.quoted ? { quoted: c.quoted } : {}),
      readings: c.readings.map((r) => ({ originalFilename: r.originalFilename, value: r.value })),
    }));

    // ── 9. Persist the terminal state.
    await finish(id, {
      conflictingMetrics,
        askedBy: String(claimed.askedBy),
        subsidiaryIds: subsidiaryIds.map(String),
      status: citations.length === 0 ? 'unsupported' : 'answered',
      answerStatus,
      responseText,
      retrieval,
      provider: provider.name,
      promptVersion: provider.promptVersion,
      model: result.model,
      generationMs,
      citations,
      discarded,
    });

    // ── 10. Downstream effects. §4.3 counts queries in the corpus; §4.6's
    //        cached series now has one more answered query in it.
    //
    // A question is indexed into the word cloud ONLY when its scope is a single
    // subsidiary. `wordFrequencies.subsidiaryId` is the one field the topics
    // pipelines authorise on, so attributing a group-wide question to
    // `subsidiaryIds[0]` would publish the asker's terms — and the query's own
    // id, via `clusters[].sourceIds` — into that one tenant's cloud, for a
    // query the containment rule in query.service.ts deliberately 404s for them.
    //
    // This is the same invariant query.model.ts already states for the
    // denormalised `subsidiaryId`: it is set only when the scope is
    // unambiguous. Fanning the terms out to every subsidiary in scope was the
    // alternative, and it is worse: an admin reads topics unscoped, so one
    // question would be counted N times in the admin cloud — a leak traded for
    // a fabricated figure. A slightly smaller corpus is the honest outcome.
    if (subsidiaryIds.length === 1) {
      trackDeferred(
        indexQueryTerms({
          _id: id,
          subsidiaryId: subsidiaryIds[0]!,
          questionText: claimed.questionText,
          createdAt: claimed.createdAt,
        }),
      );
    }
    for (const s of subsidiaryIds) {
      trackDeferred(invalidateForSubsidiary([TopicCache, AnalyticsCache, MetricsCache], s));
    }
  } catch (err) {
    // §9.4 — a defined failure state and a NON-SENSITIVE reason. The raw error
    // goes to the log only.
    const detail = err instanceof Error ? err.message : String(err);
    logger.error('Query answering failed', { queryId, message: detail });

    const exhausted = !canRetryQuery(claimed.attempts, claimed.maxAttempts);
    await QueryModel.updateOne(
      { _id: id },
      {
        $set: {
          status: exhausted ? 'dead_lettered' : 'failed',
          failureReason: exhausted
            ? 'Answer generation failed repeatedly; manual review required'
            : 'Answer generation failed; retry available',
        },
      },
    );
    await recordAudit({
      action: 'query.generation_failed',
      userId: String(claimed.askedBy),
      targetType: 'Query',
      targetId: queryId,
      subsidiaryId: subsidiaryIds.length === 1 ? String(subsidiaryIds[0]) : undefined,
      metadata: { attempts: claimed.attempts, deadLettered: exhausted },
    });
  }
}

/** Everything a terminal state needs, assembled by the caller from server-held records. */
interface FinishArgs {
  /**
   * The asker and the scope, threaded in purely so the §9.6 audit row is
   * REACHABLE. `audit.routes.ts` scopes a non-admin read to
   * `subsidiaryId IN grants OR userId = me`; a row with neither field is
   * written, is correct, and can never be read by anyone but an unfiltered
   * admin — which is indistinguishable from not auditing at all.
   */
  askedBy: string;
  subsidiaryIds: string[];
  status: QueryStatus;
  answerStatus: AnswerStatus;
  responseText: string;
  retrieval: RetrievalResult;
  provider: string;
  promptVersion: string;
  model?: string;
  generationMs: number;
  citations: QueryCitation[];
  discarded: number;
  /**
   * §4.5 — metrics on which the cited documents disagree, already filtered to
   * the question. Labels and figures only; no question or answer text, so this
   * stays safe to reach the audit row.
   */
  conflictingMetrics?: Array<{
    metricLabel: string;
    readings: Array<{ originalFilename: string; value: string }>;
  }>;
}

/**
 * Persist a terminal state and write the §9.6 audit row — counts and ids only.
 *
 * NEVER questionText, NEVER responseText, NEVER passage text (§9.5, §9.6). The
 * answer prose is stored on the row a scoped read already gates; copying it
 * into the audit collection would put it behind a different, broader read path.
 *
 * `injectionFlags` is resolved through `byRef`, which is where the server-held
 * chunk -> parent-document mapping lives. A flag raised on a chunk the scanner
 * then WITHHELD has no byRef entry and so no document to attribute itself to;
 * that loss is carried instead by `passagesWithheld`, by `injectionSuspected`
 * (which counts every flag, withheld or not), and by the `query.injection_suspected`
 * audit row, which records the rule ids. The stored array is therefore
 * "flagged but still used", which is the set a reviewer of THIS ANSWER needs;
 * the withheld set is a document-review concern and is already flagged at
 * ingestion by document.worker.ts.
 */
async function finish(id: Types.ObjectId, r: FinishArgs): Promise<void> {
  const retrieved = [...r.retrieval.byRef.values()];
  // detectInjection was called with String(chunk._id) as its ref, so a flag's
  // `ref` IS the chunk id — no second lookup table is needed for the chunk half.
  const documentByChunk = new Map(retrieved.map((v) => [String(v.chunkId), v.documentId]));

  const injectionFlags: QueryInjectionFlag[] = [];
  for (const f of r.retrieval.flags) {
    const documentId = documentByChunk.get(f.ref);
    if (!documentId) continue;
    injectionFlags.push({
      documentId,
      chunkId: new Types.ObjectId(f.ref),
      ruleId: f.ruleId,
      severity: f.severity,
    });
  }

  const injectionSuspected = r.retrieval.flags.length > 0;

  const conflictingMetrics = r.conflictingMetrics ?? [];

  await QueryModel.updateOne(
    { _id: id },
    {
      $set: {
        status: r.status,
        answerStatus: r.answerStatus,
        conflictingMetrics,
        /**
         * A contradicted answer goes into the human queue whatever it was
         * before. This is the one condition that can promote an otherwise
         * routine query to `pending`: the figures are individually sourced and
         * individually citable, and collectively they cannot both be right.
         *
         * `not_required` is never restored here — a parliamentary query already
         * pending review stays pending.
         */
        ...(conflictingMetrics.length > 0 ? { reviewStatus: 'pending' as const } : {}),
        responseText: r.responseText,
        citations: r.citations,
        retrievedChunkIds: retrieved.map((v) => v.chunkId),
        candidatesConsidered: r.retrieval.candidatesConsidered,
        passagesUsed: r.retrieval.refs.length,
        passagesWithheld: r.retrieval.withheld,
        discardedCitationCount: r.discarded,
        injectionFlags,
        injectionSuspected,
        providerName: r.provider,
        promptVersion: r.promptVersion,
        model: r.model,
        generationMs: r.generationMs,
        answeredAt: new Date(),
      },
    },
  );

  await recordAudit({
    action: 'query.answered',
    userId: r.askedBy,
    targetType: 'Query',
    targetId: String(id),
    // Only when the scope is unambiguous: a group-wide answer has no single
    // affected subsidiary, and stamping an arbitrary one would file it under a
    // tenant it does not belong to. `userId` keeps it reachable either way.
    subsidiaryId: r.subsidiaryIds.length === 1 ? r.subsidiaryIds[0] : undefined,
    metadata: {
      answerStatus: r.answerStatus,
      citations: r.citations.length,
      discarded: r.discarded,
      passagesUsed: r.retrieval.refs.length,
      passagesWithheld: r.retrieval.withheld,
      injectionSuspected,
      conflictsFlagged: conflictingMetrics.length,
      provider: r.provider,
      generationMs: r.generationMs,
    },
  });
}

/**
 * Reset queries stranded by a crash or restart — instructions §4a.
 *
 * "Recovery-on-boot is not optional even for a single instance: it is the thing
 * that makes a redeploy mid-processing survivable." A row left in `answering`
 * is invisible to the user otherwise, exactly as a document stuck in
 * `processing` was.
 *
 * The exhausted sweep runs FIRST and by design: a row that has already burned
 * its attempts must reach `dead_lettered`, and requeueing it first would let
 * the second sweep hand it straight back to the worker for another doomed run.
 */
export async function recoverStuckQueries(): Promise<number> {
  const cutoff = new Date(Date.now() - env.QUERY_STUCK_TIMEOUT_MINUTES * 60_000);

  const exhausted = await QueryModel.updateMany(
    {
      status: { $in: ['retrieving', 'answering'] },
      processingStartedAt: { $lt: cutoff },
      $expr: { $gte: ['$attempts', '$maxAttempts'] },
    },
    {
      $set: {
        status: 'dead_lettered',
        failureReason: 'Answer generation was interrupted repeatedly; manual review required',
      },
    },
  );

  // NO AGE GUARD on the requeue sweep, unlike the dead-letter sweep above.
  //
  // This runs at boot, and at boot no worker holds anything — the process that
  // claimed these rows is gone by definition. An age guard here does not mean
  // "still owned by a live worker"; it just makes recovery a no-op for the rows
  // that need it most, because a redeploy takes seconds and the cutoff is ten
  // minutes. The document worker's equivalent has never had one.
  //
  // The dead-letter sweep keeps its guard: exhausting a row's attempts is
  // destructive, so it should only catch rows that really have been abandoned.
  const stranded = await QueryModel.find({ status: { $in: ['retrieving', 'answering'] } })
    .select({ _id: 1 })
    .lean();

  const requeued = await QueryModel.updateMany(
    { status: { $in: ['retrieving', 'answering'] } },
    // $unset, not `$set: { failureReason: undefined }` — Mongoose strips
    // undefined out of an update, so a requeued row would keep the reason from
    // the run that was interrupted.
    { $set: { status: 'queued' }, $unset: { failureReason: '' } },
  );

  // RE-ENQUEUE. Resetting the row to `queued` without this stranded it
  // permanently: nothing else calls processQuery for an existing row, and
  // POST /queries/:id/retry refuses anything that is not `failed`, so `queued`
  // was a state no code path and no user could leave. That contradicted both
  // this file's own claim that recovery makes a redeploy survivable and §4a's
  // "work must reach a terminal state exactly once".
  for (const row of stranded) enqueueQuery(String(row._id));

  const total = exhausted.modifiedCount + requeued.modifiedCount;
  if (total > 0) {
    logger.warn('Recovered queries left mid-generation by a previous run', {
      requeued: requeued.modifiedCount,
      deadLettered: exhausted.modifiedCount,
    });
  }
  return total;
}
