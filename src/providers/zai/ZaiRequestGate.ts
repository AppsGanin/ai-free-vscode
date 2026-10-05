import { ProviderError } from "../types";

const PROVIDER_ID = "ai-free-vscode-zai";

/** Shortest gap between two completion requests. */
export const MIN_REQUEST_INTERVAL_MS = 4000;
/** First pause after Z.ai's WAF blocked us; doubles while it keeps blocking. */
export const WAF_COOLDOWN_MS = 5 * 60_000;
export const MAX_WAF_COOLDOWN_MS = 30 * 60_000;

/**
 * Keeps the request rate to chat.z.ai within reason.
 *
 * Its Alibaba Cloud WAF blocks the completion endpoint for a client after a
 * burst of requests — an agent session fires one every few seconds for
 * minutes. Two things keep that from happening, or from getting worse:
 *
 * - requests are spaced at least MIN_REQUEST_INTERVAL_MS apart;
 * - once blocked, nothing is sent for a while. Every request sent into a
 *   block is another strike against the client; failing fast instead lets
 *   the block lift. A block right after a pause doubles the next one.
 */
export class ZaiRequestGate {
  private lastRequestAt = 0;
  private blockedUntil = 0;
  private cooldownMs = WAF_COOLDOWN_MS;

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /**
   * Waits for the request slot. Throws while a WAF block is being sat out,
   * and when the caller gives up waiting.
   */
  async beforeRequest(signal?: AbortSignal): Promise<void> {
    const left = this.blockedUntil - this.now();
    if (left > 0) {
      const minutes = Math.max(1, Math.ceil(left / 60_000));
      throw new ProviderError(
        PROVIDER_ID,
        `Z.ai's anti-bot is blocking chat requests from this browser. Requests are paused so the block can lift — try again in ${minutes} min, or switch to another provider.`,
      );
    }

    const wait = this.lastRequestAt + MIN_REQUEST_INTERVAL_MS - this.now();
    if (wait > 0 && !signal?.aborted) await this.sleep(wait);
    this.lastRequestAt = this.now();
  }

  /** The WAF answered with its block page. */
  blocked(): void {
    // Blocked again soon after a pause: the last one was too short.
    const recentlyPaused = this.blockedUntil > 0 && this.now() - this.blockedUntil < this.cooldownMs;
    if (recentlyPaused) {
      this.cooldownMs = Math.min(this.cooldownMs * 2, MAX_WAF_COOLDOWN_MS);
    }
    this.blockedUntil = this.now() + this.cooldownMs;
  }

  /** A request got through: the next block starts from the short pause. */
  passed(): void {
    this.cooldownMs = WAF_COOLDOWN_MS;
  }

  /** Milliseconds left in the current pause, 0 when requests may go. */
  get pausedFor(): number {
    return Math.max(0, this.blockedUntil - this.now());
  }
}
