import { expect, it } from 'vitest';
import { frameFilter } from './readonly.js';

function frame(opcode: number, text: string, final: boolean): Buffer {
  const payload = Buffer.from(text);
  const mask = Buffer.from([1, 2, 3, 4]);
  const header = Buffer.from([(final ? 0x80 : 0) | opcode, 0x80 | payload.length]);
  return Buffer.concat([header, mask, payload.map((byte, index) => byte ^ mask[index % 4]!)]);
}

it('keeps a write matching dropFrames out of the upstream when it arrives in continuation frames', () => {
  let dropped = 0;
  const filter = frameFilter([/"push"/], () => dropped++);
  // A legal fragmented WebSocket text message. Its continuation frame contains the write discriminator.
  const first = frame(1, '{', false);
  const continuation = frame(0, '"type":"push","mutation":"delete"}', true);
  const forwarded = Buffer.concat([filter(first), filter(continuation)]);
  expect(forwarded.length, 'The complete blocked write must not reach the backend').toBeLessThan(
    first.length + continuation.length,
  );
  expect(dropped).toBe(1);
});
