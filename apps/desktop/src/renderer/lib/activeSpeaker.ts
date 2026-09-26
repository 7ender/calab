/**
 * The call's «active speaker» for video (the large tile, the camera PiP, «Экономить трафик»):
 * someone becomes active only after speaking continuously for `holdMs` (2 s), and stays active
 * after they fall silent until someone else qualifies. Short interjections («ага», a cough) don't
 * switch the picture, and the one subscribed camera doesn't flicker (review M2 / L5).
 */
export const ACTIVE_SPEAKER_HOLD_MS = 2000;

export class ActiveSpeaker {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private current: string | null = null;

  constructor(
    private readonly onChange: (userId: string | null) => void,
    private readonly holdMs = ACTIVE_SPEAKER_HOLD_MS,
  ) {}

  get value(): string | null {
    return this.current;
  }

  /** The debounced speaking map (userId → speaking); missing ids are silent. */
  update(speaking: Readonly<Record<string, boolean>>): void {
    for (const [id, on] of Object.entries(speaking)) {
      if (!on || id === this.current || this.timers.has(id)) continue;
      this.timers.set(
        id,
        setTimeout(() => {
          this.timers.delete(id);
          this.current = id;
          this.onChange(id);
        }, this.holdMs),
      );
    }
    for (const [id, timer] of this.timers) {
      if (speaking[id]) continue;
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  /** Someone left the call: they can't stay the active speaker. */
  drop(userId: string): void {
    const timer = this.timers.get(userId);
    if (timer) clearTimeout(timer);
    this.timers.delete(userId);
    if (this.current === userId) {
      this.current = null;
      this.onChange(null);
    }
  }

  reset(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.current = null;
  }
}
