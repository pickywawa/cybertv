import { db, getMeta, setMeta } from '../db';
import type { Channel, Universe } from '../types';
import { fetchJson, setPrefetchSince } from '../net/http';
import { cleanName, norm } from '../util/text';
import { toLang } from '../util/lang';

/**
 * iptv-org's open channel database (https://github.com/iptv-org/database, CC0):
 * logos, country, broadcast languages and category for ~30k channels.
 * Downloaded at most once a week (≈ 20 MB, also part of the background pre-download), reduced to
 * a compact index kept in IndexedDB, then applied to the profile's channels after every sync.
 */
export const IPTV_ORG = {
  channels: 'https://iptv-org.github.io/api/channels.json',
  logos: 'https://iptv-org.github.io/api/logos.json',
  feeds: 'https://iptv-org.github.io/api/feeds.json',
};

interface IndexEntry {
  id: string; // lowercase iptv-org id ("france2.fr")
  names: string[]; // normalised name + alternative names
  country: string;
  langs: string[];
  logo?: string;
  cat?: string;
}

const KEY = 'iptvorg:index';
const KEY_AT = 'iptvorg:at';

const nameKey = (s: string) => norm(cleanName(s)).replace(/\s+/g, '');

const CAT_UNIVERSE: Record<string, Universe> = {
  general: 'general', news: 'news', sports: 'sport', movies: 'cinema', series: 'series', kids: 'kids', animation: 'kids',
  documentary: 'docs', science: 'docs', travel: 'docs', outdoor: 'docs', music: 'music', entertainment: 'ent', comedy: 'ent',
  lifestyle: 'ent', cooking: 'ent', family: 'kids', xxx: 'adult',
};

/** downloads and compacts the database (weekly) */
export async function refreshIptvOrg(force = false): Promise<boolean> {
  const at = (await getMeta<number>(KEY_AT)) || 0;
  if (!force && Date.now() - at < 7 * 86400000 && (await getMeta(KEY))) return false;
  // a copy downloaded in the background since the last refresh is used when available
  setPrefetchSince(at);
  let channels: any[], logos: any[], feeds: any[];
  try {
    [channels, logos, feeds] = await Promise.all([
      fetchJson<any[]>(IPTV_ORG.channels, 120000),
      fetchJson<any[]>(IPTV_ORG.logos, 120000),
      fetchJson<any[]>(IPTV_ORG.feeds, 120000),
    ]);
  } finally {
    setPrefetchSince(null);
  }
  // best logo per channel: in use, main feed (no feed id), PNG/SVG, widest
  const logo = new Map<string, { url: string; score: number }>();
  for (const l of logos) {
    if (!l?.channel || !l.url) continue;
    const score = (l.in_use === false ? 0 : 1000) + (l.feed ? 0 : 500) + (/png|svg/i.test(l.format || '') ? 200 : 0) + Math.min(400, l.width || 0) / 4;
    const cur = logo.get(l.channel);
    if (!cur || score > cur.score) logo.set(l.channel, { url: l.url, score });
  }
  const langs = new Map<string, string[]>();
  for (const f of feeds) {
    if (!f?.channel) continue;
    const l = (f.languages || []).map((x: string) => toLang(x)).filter(Boolean) as string[];
    if (!l.length) continue;
    // main feed wins, otherwise the union of feeds
    if (f.is_main) langs.set(f.channel, [...new Set(l)]);
    else if (!langs.has(f.channel)) langs.set(f.channel, [...new Set(l)]);
  }
  const index: IndexEntry[] = [];
  for (const c of channels) {
    if (!c?.id || c.closed || c.is_nsfw) continue;
    index.push({
      id: String(c.id).toLowerCase(),
      names: [...new Set([c.name, ...(c.alt_names || [])].filter(Boolean).map(nameKey))],
      country: c.country,
      langs: langs.get(c.id) || [],
      logo: logo.get(c.id)?.url,
      cat: (c.categories || [])[0],
    });
  }
  await setMeta(KEY, index);
  await setMeta(KEY_AT, Date.now());
  return true;
}

/**
 * Applies the index to a profile's channels: matched by EPG id ("TF1.fr", "tf1.fr@SD"),
 * else by name within the channel's country. Fills a missing logo (or adds it as a fallback),
 * the real broadcast languages, the country and, for unclassified channels, the category.
 */
export async function applyIptvOrg(profileId: string): Promise<number> {
  const index = await getMeta<IndexEntry[]>(KEY);
  if (!index?.length) return 0;
  const byId = new Map(index.map((e) => [e.id, e]));
  const byName = new Map<string, IndexEntry[]>();
  for (const e of index) for (const n of e.names) (byName.get(n) || byName.set(n, []).get(n)!).push(e);

  const channels = await db.channels.where('profileId').equals(profileId).toArray();
  const patches: { id: string; p: Partial<Channel> }[] = [];
  for (const ch of channels) {
    let e = ch.epgId ? byId.get(ch.epgId.split('@')[0]) : undefined;
    if (!e) {
      const cands = byName.get(nameKey(ch.name)) || [];
      e = cands.length === 1 ? cands[0] : cands.find((x) => ch.country && x.country === ch.country);
    }
    if (!e) continue;
    const p: Partial<Channel> = { iptvId: e.id };
    // iptv-org's curated logo is shown first (logoAlt); the provider's stays as fallback — providers
    // sometimes put another channel's picture on a stream (CANAL+ on "TF1 FHD")
    if (e.logo) {
      if (!ch.logo) p.logo = e.logo;
      else if (ch.logo !== e.logo) p.logoAlt = e.logo;
    }
    if (e.langs.length) p.langs = e.langs;
    if (e.country) p.country = e.country === 'UK' ? 'GB' : e.country;
    if (ch.universe === 'other' && e.cat && CAT_UNIVERSE[e.cat]) p.universe = CAT_UNIVERSE[e.cat];
    patches.push({ id: ch.id, p });
  }
  await db.transaction('rw', db.channels, async () => {
    for (const x of patches) await db.channels.update(x.id, x.p);
  });
  return patches.length;
}
