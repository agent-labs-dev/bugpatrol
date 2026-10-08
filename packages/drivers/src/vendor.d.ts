declare module 'gifenc' {
  type Palette = number[][];
  type Encoder = {
    GIFEncoder(): {
      writeFrame(
        index: Uint8Array,
        width: number,
        height: number,
        options?: { palette?: Palette; delay?: number; repeat?: number },
      ): void;
      finish(): void;
      bytes(): Uint8Array;
    };
  };
  export const GIFEncoder: Encoder['GIFEncoder'] | undefined;
  const gifenc: Encoder;
  export default gifenc;
}

/** One glyph of a BDF font from the bdf-fonts package: rows of bits, the leftmost pixel in the highest bit. */
declare module 'bdf-fonts/fonts/Terminus/16.js' {
  const font: { BITMAP: number[] }[];
  export default font;
}
declare module 'bdf-fonts/fonts/Terminus/16-b.js' {
  const font: { BITMAP: number[] }[];
  export default font;
}
