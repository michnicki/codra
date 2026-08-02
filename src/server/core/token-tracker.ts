import { logger } from './logger';

export interface TokenUsage {
  input: number;
  output: number;
}

export interface ModelUsage extends TokenUsage {
  model: string;
  calls: number;
}

export class TokenTracker {
  private usage: Map<string, ModelUsage> = new Map();
  private subrequests = 0;
  private readonly MAX_SUBREQUESTS = 50;
  // Increased from 10 to 25 to account for the untracked Hyperdrive queries that happen per chunk
  // (e.g. lease heartbeats, getting reviews, upserting reviews, etc.) which can easily add ~15
  // subrequests that the tracker doesn't see.
  private readonly SAFE_MARGIN = 25;

  incrementSubrequests(count = 1) {
    this.subrequests += count;
  }

  getSubrequestCount() {
    return this.subrequests;
  }

  hasRemainingSubrequests(needed = 1) {
    return this.subrequests + needed <= this.MAX_SUBREQUESTS;
  }

  /**
   * Confirmed live during the 29-09 UAT checkpoint: `core/bitbucket.ts`'s paginated walks call
   * `tracker?.hasRemainingSafeBudget?.(needed)` and silently skip the guard when the method is
   * missing (optional chaining makes the whole check a no-op), which is exactly what happened here
   * before this method existed -- the tree walk paginated with no budget awareness at all, some
   * invocations consumed the ENTIRE per-invocation subrequest budget just enumerating the tree, and
   * the file-processing loop that runs afterward got zero budget and threw "too many subrequests"
   * before fetching a single file. Bounded by the same safety margin as `remainingSafeBudget()`, not
   * the raw `hasRemainingSubrequests`, so pagination backs off before the DB writes later in the same
   * invocation would themselves start hitting the cap.
   */
  hasRemainingSafeBudget(needed = 1) {
    return this.remainingSafeBudget() >= needed;
  }

  isNearLimit() {
    return this.subrequests >= this.MAX_SUBREQUESTS - this.SAFE_MARGIN;
  }

  /**
   * How many more subrequests can safely be spent right now before crossing into the
   * reserved safety margin below Cloudflare's hard per-invocation cap (Workers Free plan:
   * 50 subrequests/invocation). Callers that can start a variable amount of concurrent work
   * (e.g. how many files to review at once) should size that work against this number
   * instead of a fixed constant, so throughput stays high while the budget is healthy and
   * automatically shrinks as it's spent.
   */
  remainingSafeBudget() {
    return Math.max(0, this.MAX_SUBREQUESTS - this.SAFE_MARGIN - this.subrequests);
  }

  /**
   * Records token usage for a specific model call.
   */
  record(model: string, input: number, output: number) {
    const existing = this.usage.get(model) || { model, input: 0, output: 0, calls: 0 };
    
    this.usage.set(model, {
      model,
      input: existing.input + input,
      output: existing.output + output,
      calls: existing.calls + 1,
    });

    logger.debug(`Token usage recorded for ${model}`, { 
      input, 
      output, 
      totalInput: existing.input + input,
      totalOutput: existing.output + output
    });
  }

  /**
   * Returns the total usage across all models.
   */
  getTotalUsage(): TokenUsage {
    let input = 0;
    let output = 0;
    for (const modelUsage of this.usage.values()) {
      input += modelUsage.input;
      output += modelUsage.output;
    }
    return { input, output };
  }

  /**
   * Returns a breakdown of usage by model.
   */
  getBreakdown(): ModelUsage[] {
    return Array.from(this.usage.values());
  }

  /**
   * Merges another tracker's usage into this one.
   * Useful when combining results from retries or sub-tasks.
   */
  merge(other: TokenTracker) {
    for (const usage of other.getBreakdown()) {
      // `record()` would increment `calls` by 1 per model regardless of how many calls the other
      // tracker actually accumulated, undercounting the merged call total. Combine the aggregated
      // per-model breakdown directly so tokens AND call counts sum correctly.
      const existing = this.usage.get(usage.model) ?? { model: usage.model, input: 0, output: 0, calls: 0 };
      this.usage.set(usage.model, {
        model: usage.model,
        input: existing.input + usage.input,
        output: existing.output + usage.output,
        calls: existing.calls + usage.calls,
      });
    }
  }

  /**
   * Resets all usage data.
   */
  reset() {
    this.usage.clear();
  }
}
