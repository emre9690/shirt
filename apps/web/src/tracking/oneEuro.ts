/** One Euro filter (Casiez et al. 2012) for a fixed-length vector. */
export class OneEuroVector {
  private x: Float64Array | null = null;
  private dx: Float64Array;
  private last = 0;

  constructor(size: number, private minCutoff = 1.4, private beta = 0.6, private dCutoff = 1) {
    this.dx = new Float64Array(size);
  }

  reset(): void {
    this.x = null;
    this.dx.fill(0);
  }

  filter(value: ArrayLike<number>, timeSeconds: number): Float64Array {
    if (!this.x) {
      this.x = Float64Array.from(value as ArrayLike<number>);
      this.last = timeSeconds;
      return this.x;
    }
    const dt = Math.max(1e-3, timeSeconds - this.last);
    this.last = timeSeconds;
    const alpha = (cutoff: number) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));
    const ad = alpha(this.dCutoff);
    for (let i = 0; i < this.x.length; i++) {
      const rate = (value[i] - this.x[i]) / dt;
      this.dx[i] += ad * (rate - this.dx[i]);
      const a = alpha(this.minCutoff + this.beta * Math.abs(this.dx[i]));
      this.x[i] += a * (value[i] - this.x[i]);
    }
    return this.x;
  }
}
