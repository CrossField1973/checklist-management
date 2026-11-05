/** Zunehmende Sperre nach Fehlversuchen (F-04, Freigabe-Passwörter): ab 5 Fehlversuchen 1, 2, 4 … max. 15 Minuten. */
export class LoginThrottle {
  private entries = new Map<string, { fails: number; blockedUntil: number }>();
  retryAfterSeconds(key: string): number {
    const e = this.entries.get(key);
    return e && e.blockedUntil > Date.now() ? Math.ceil((e.blockedUntil - Date.now()) / 1000) : 0;
  }
  fail(key: string) {
    const e = this.entries.get(key) ?? { fails: 0, blockedUntil: 0 };
    e.fails += 1;
    if (e.fails >= 5) e.blockedUntil = Date.now() + Math.min(2 ** (e.fails - 5), 15) * 60_000;
    this.entries.set(key, e);
  }
  reset(key: string) {
    this.entries.delete(key);
  }
}
