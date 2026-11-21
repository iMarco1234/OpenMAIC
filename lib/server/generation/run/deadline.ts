/**
 * The time a run gives each provider-calling step: the budget the step's 1.1.x
 * API route declared, so a hung provider fails the step the way a route
 * timeout failed the browser's request, as a retryable failure.
 */

/**
 * Read a positive integer millisecond budget from the environment, falling
 * back to the code default. A blank or invalid value is ignored so a typo
 * never zeroes a deadline. Mirrors `numberFromEnv` in
 * `lib/server/agent-runtime/config.ts`.
 */
const envDeadlineMs = (key: string, fallback: number): number => {
  const raw = process.env[key];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

/**
 * Per call, in milliseconds. Each entry is env-overridable so a slow local
 * model can be given more breathing room without a code change:
 * `OPENMAIC_GEN_DEADLINE_MATERIAL_ANALYSIS_MS`, `OPENMAIC_GEN_DEADLINE_RESEARCH_MS`,
 * `OPENMAIC_GEN_DEADLINE_OUTLINE_MS`, `OPENMAIC_GEN_DEADLINE_AGENT_PROFILES_MS`,
 * `OPENMAIC_GEN_DEADLINE_SCENE_CONTENT_MS`, `OPENMAIC_GEN_DEADLINE_SCENE_ACTIONS_MS`,
 * `OPENMAIC_GEN_DEADLINE_NARRATION_CLIP_MS`.
 *
 * The two heavy steps that dominate a local-model run are bumped: a large
 * output at 128K context takes minutes, so `sceneContent` (3 min -> 25 min) and
 * `sceneActions` (60 s -> 5 min) get generous defaults. The other steps keep
 * their original defaults and can still be widened via env if needed.
 */
export const STEP_DEADLINES_MS = {
  materialAnalysis: envDeadlineMs('OPENMAIC_GEN_DEADLINE_MATERIAL_ANALYSIS_MS', 300_000),
  research: envDeadlineMs('OPENMAIC_GEN_DEADLINE_RESEARCH_MS', 300_000),
  outline: envDeadlineMs('OPENMAIC_GEN_DEADLINE_OUTLINE_MS', 300_000),
  agentProfiles: envDeadlineMs('OPENMAIC_GEN_DEADLINE_AGENT_PROFILES_MS', 120_000),
  sceneContent: envDeadlineMs('OPENMAIC_GEN_DEADLINE_SCENE_CONTENT_MS', 1_500_000),
  sceneActions: envDeadlineMs('OPENMAIC_GEN_DEADLINE_SCENE_ACTIONS_MS', 300_000),
  narrationClip: envDeadlineMs('OPENMAIC_GEN_DEADLINE_NARRATION_CLIP_MS', 30_000),
} as const;

/** A step ran out of its budget. A gateway timeout to the retries: retried. */
export class StepTimeoutError extends Error {
  readonly statusCode = 504;

  constructor(label: string, ms: number) {
    super(`${label} did not finish within ${ms / 1000} s`);
    this.name = 'StepTimeoutError';
  }
}

/**
 * Run `call` with a signal that aborts when the run's signal does (a lost
 * lease, a deleted course, shutdown) or when `ms` pass. A timeout rejects
 * with {@link StepTimeoutError} even if the call ignores its signal; the
 * run's own abort rejects as an abort.
 */
export async function withDeadline<T>(
  label: string,
  ms: number,
  runSignal: AbortSignal,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), ms);
  const signal = AbortSignal.any([runSignal, timeout.signal]);
  const failure = () =>
    runSignal.aborted
      ? (runSignal.reason ?? new DOMException('Aborted', 'AbortError'))
      : new StepTimeoutError(label, ms);
  try {
    return await new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        reject(failure());
        return;
      }
      signal.addEventListener('abort', () => reject(failure()), { once: true });
      call(signal).then(resolve, (error) => reject(signal.aborted ? failure() : error));
    });
  } finally {
    clearTimeout(timer);
  }
}
