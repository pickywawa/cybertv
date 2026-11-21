import { SaxesParser } from 'saxes';
import type { Program } from '../types';

export interface XmltvChannel {
  id: string;
  names: string[];
  icon?: string;
}

/** "20240101120000 +0100" -> epoch ms */
export function parseXmltvDate(s: string): number {
  const m = s.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*(?:([+-]\d{2}):?(\d{2})?)?/);
  if (!m) return NaN;
  const [, Y, Mo, D, H, Mi, S = '00', tzh = '+00', tzm = '00'] = m;
  const utc = Date.UTC(+Y, +Mo - 1, +D, +H, +Mi, +S);
  const sign = tzh.startsWith('-') ? -1 : 1;
  const off = sign * (Math.abs(parseInt(tzh, 10)) * 60 + parseInt(tzm, 10));
  return utc - off * 60000;
}

export interface XmltvOptions {
  /** called once, when the first <programme> is reached, with all <channel> definitions.
   *  Must return a map xmltvId -> our epgId (programmes for unmapped ids are skipped). null = keep all */
  onChannels: (channels: XmltvChannel[]) => Map<string, string> | null;
  onPrograms: (batch: Program[]) => Promise<void> | void;
  from: number;
  to: number;
  batchSize?: number;
}

/** Streaming XMLTV parser (works on 100+ MB guides with constant memory) */
export async function parseXmltv(stream: ReadableStream<string>, o: XmltvOptions): Promise<{ channels: number; programs: number }> {
  const parser = new SaxesParser({ xmlns: false });
  const channels: XmltvChannel[] = [];
  let mapping: Map<string, string> | null | undefined;
  let cur: XmltvChannel | null = null;
  let prog: (Program & { _xid?: string }) | null = null;
  let field: string | null = null;
  let text = '';
  let batch: Program[] = [];
  let total = 0;
  const pendingFlush: Program[][] = [];
  const size = o.batchSize ?? 2000;

  parser.on('opentag', (t) => {
    const a = t.attributes as Record<string, string>;
    switch (t.name) {
      case 'channel':
        cur = { id: a.id, names: [] };
        break;
      case 'display-name':
        if (cur) { field = 'display-name'; text = ''; }
        break;
      case 'icon':
        if (prog) prog.icon = prog.icon || a.src;
        else if (cur) cur.icon = a.src;
        break;
      case 'programme': {
        if (mapping === undefined) mapping = o.onChannels(channels);
        const start = parseXmltvDate(a.start || '');
        const stop = parseXmltvDate(a.stop || '') || start + 3600000;
        const target = mapping ? mapping.get(a.channel) : a.channel?.toLowerCase();
        if (!target || !(stop > o.from && start < o.to)) {
          prog = null; // skipped: children are ignored because prog is null
          break;
        }
        prog = { epgId: target, start, stop, title: '' };
        break;
      }
      case 'title':
      case 'sub-title':
      case 'desc':
      case 'category':
      case 'episode-num':
        if (prog) { field = t.name; text = ''; }
        break;
    }
  });
  parser.on('text', (t) => {
    if (field) text += t;
  });
  parser.on('cdata', (t) => {
    if (field) text += t;
  });
  parser.on('closetag', (t) => {
    if (field && t.name === field) {
      const v = text.trim();
      if (cur && field === 'display-name') cur.names.push(v);
      else if (prog) {
        if (field === 'title') prog.title = prog.title || v;
        else if (field === 'sub-title') prog.subTitle = prog.subTitle || v;
        else if (field === 'desc') prog.desc = prog.desc || v;
        else if (field === 'category') prog.category = prog.category || v;
        else if (field === 'episode-num') prog.episodeNum = prog.episodeNum || v;
      }
      field = null;
      return;
    }
    if (t.name === 'channel' && cur) {
      channels.push(cur);
      cur = null;
    } else if (t.name === 'programme' && prog) {
      batch.push(prog);
      total++;
      prog = null;
      if (batch.length >= size) {
        pendingFlush.push(batch);
        batch = [];
      }
    }
  });

  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    parser.write(value);
    while (pendingFlush.length) await o.onPrograms(pendingFlush.shift()!);
  }
  parser.close();
  if (mapping === undefined) o.onChannels(channels);
  while (pendingFlush.length) await o.onPrograms(pendingFlush.shift()!);
  if (batch.length) await o.onPrograms(batch);
  return { channels: channels.length, programs: total };
}
