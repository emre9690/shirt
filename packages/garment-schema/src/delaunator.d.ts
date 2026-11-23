declare module 'delaunator' {
  export default class Delaunator {
    static from(points: ArrayLike<readonly [number, number]>): Delaunator;
    triangles: Uint32Array;
  }
}
