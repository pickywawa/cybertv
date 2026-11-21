import { proxify } from '../net/http';

const CHUNK = 65536;

/**
 * OpenSubtitles "moviehash": file size + sum of the 64-bit little-endian words of the first and
 * last 64 KB. Subtitles matching it were timed on this exact file, so they are in sync.
 */
export function computeHash(size: number, head: ArrayBuffer, tail: ArrayBuffer): string {
  let h = BigInt(size);
  const mask = (1n << 64n) - 1n;
  for (const buf of [head, tail]) {
    const v = new DataView(buf);
    for (let i = 0; i + 8 <= buf.byteLength; i += 8) h = (h + v.getBigUint64(i, true)) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

async function range(url: string, from: number, to: number): Promise<{ buf: ArrayBuffer; total?: number } | null> {
  const res = await fetch(proxify(url), { headers: { Range: `bytes=${from}-${to}` }, signal: AbortSignal.timeout(10000) });
  if (res.status !== 206) return null;
  const total = Number(res.headers.get('content-range')?.split('/')[1]);
  return { buf: await res.arrayBuffer(), total: Number.isFinite(total) ? total : undefined };
}

/** two small Range requests; null for streams that don't support them (HLS, live…) */
export async function movieHash(url: string): Promise<{ hash: string; size: number } | null> {
  if (/\.m3u8(\?|$)/i.test(url)) return null;
  try {
    const head = await range(url, 0, CHUNK - 1);
    if (!head?.total || head.total < CHUNK * 2 || head.buf.byteLength !== CHUNK) return null;
    const tail = await range(url, head.total - CHUNK, head.total - 1);
    if (!tail || tail.buf.byteLength !== CHUNK) return null;
    return { hash: computeHash(head.total, head.buf, tail.buf), size: head.total };
  } catch {
    return null;
  }
}
