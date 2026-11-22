import { fetchWithTimeout } from '../net/http';
import type { ReplayItem, ReplayRail } from './types';

/**
 * Free YouTube channels of well-known broadcasters and media, by theme, read from YouTube's public
 * RSS feeds (latest videos of a channel, no API key). Videos play in YouTube's own embedded player.
 * French app → French channels; English app → channels of the profile's country (UK or US).
 */
export type YtSection = 'docs' | 'sport' | 'news' | 'radio' | 'humor' | 'media';

interface YtChannel {
  id: string;
  name: string;
}

const FR: Record<YtSection, YtChannel[]> = {
  docs: [
    { id: 'UCwI-JbGNsojunnHbFAc0M4Q', name: 'ARTE' },
    { id: 'UCd5DKToXYTKAQ6khzewww2g', name: 'France Culture' },
  ],
  sport: [
    { id: 'UCyIV8rkza5Uk_sJIhqilBvQ', name: "L'Équipe" },
    { id: 'UCR5V8BTvlkyYtw6T_9swNEw', name: 'RMC Sport' },
    { id: 'UC8ggH3zU61XO0nMskSQwZdA', name: 'CANAL+ Sport' },
  ],
  news: [
    { id: 'UCXwDLMDV86ldKoFVc_g8P0g', name: 'BFMTV' },
    { id: 'UCO6K_kkdP-lnSCiO3tPx7WA', name: 'franceinfo' },
    { id: 'UCCCPCZNChQdGa9EkATeye4g', name: 'FRANCE 24' },
  ],
  radio: [
    { id: 'UC_ykXc7v9zZQdOG5QvJqpgg', name: 'RTL' },
    { id: 'UCJldRgT_D7Am-ErRHQZ90uw', name: 'France Inter' },
    { id: 'UCIMGfEAERXjmWwQeg15BFsg', name: 'Europe 1' },
    { id: 'UCCXCqCR3s-McFHDGnl4ta_A', name: 'NRJ' },
  ],
  humor: [
    { id: 'UCPHJfLg1VeNBsfzzTszpmmQ', name: 'Montreux Comedy' },
    { id: 'UCI5jJx0Mk7IgnYz9wxvoQLw', name: 'Jamel Comedy Club' },
    { id: 'UCoZoRz4-y6r87ptDp4Jk74g', name: 'Palmashow' },
    { id: 'UCww2zZWg4Cf5xcRKG-ThmXQ', name: 'Norman' },
    { id: 'UCyWqModMQlbIo8274Wh_ZsQ', name: 'Cyprien' },
  ],
  media: [
    { id: 'UCSKdvgqdnj72_SLggp7BDTg', name: 'Brut' },
    { id: 'UCHQda5vLxrH0Ff0I0kMq4zw', name: 'Konbini' },
    { id: 'UCYpRDnhk5H8h16jpS84uqsA', name: 'Le Monde' },
    { id: 'UC__xRB5L4toU9yYawt_lIKg', name: 'Blast' },
  ],
};

const US: Record<YtSection, YtChannel[]> = {
  docs: [
    { id: 'UC3ScyryU9Oy9Wse3a8OAmYQ', name: 'FRONTLINE PBS' },
    { id: 'UCpVm7bg6pXKo1Pr6k5kxG9A', name: 'National Geographic' },
    { id: 'UCW39zufHfsuGgpLviKh297Q', name: 'DW Documentary' },
  ],
  sport: [
    { id: 'UCiWLfSweyRNmLpgEHekhoAg', name: 'ESPN' },
    { id: 'UCqZQlzSHbVJrwrn5XvzrzcA', name: 'NBC Sports' },
    { id: 'UCDVYQ4Zhbm3S2dlz7P1GBDg', name: 'NFL' },
    { id: 'UCWJ2lWNubArHWmf3FIHbfcQ', name: 'NBA' },
  ],
  news: [
    { id: 'UCupvZG-5ko_eiXAupbDfxWw', name: 'CNN' },
    { id: 'UCeY0bbntWzzVIaj2z3QigXg', name: 'NBC News' },
    { id: 'UCBi2mrWuNuyYy4gbM6fU18Q', name: 'ABC News' },
    { id: 'UC8p1vwvWtl6T73JiExfWs1g', name: 'CBS News' },
  ],
  radio: [
    { id: 'UCJnS2EsPfv46u1JR8cnD0NA', name: 'NPR' },
    { id: 'UC49ta0RHXJUiID5KWRkcySw', name: 'SiriusXM' },
  ],
  humor: [
    { id: 'UCqFzWxSCi39LnW1JKFR3efg', name: 'Saturday Night Live' },
    { id: 'UC3XTzVzaHQEd30rQbuvCtTQ', name: 'Last Week Tonight' },
    { id: 'UCwWhs_6x42TyRM4Wstoq8HA', name: 'The Daily Show' },
    { id: 'UCVTyTA7-g9nopHeHbeuvpRA', name: 'Late Night with Seth Meyers' },
  ],
  media: [
    { id: 'UCLXo7UDZvByw2ixzpQCufnA', name: 'Vox' },
    { id: 'UCn8zNIfYAQNdrFRrr8oibKw', name: 'VICE' },
  ],
};

const GB: Record<YtSection, YtChannel[]> = {
  docs: [
    { id: 'UCooTDp-fERMGRHIQ4VL4qlg', name: 'Channel 4 Documentaries' },
    { id: 'UCu4XcDBdnZkV6-5z2f16M0g', name: 'Real Stories' },
    { id: 'UC2ccm1GajfSujz7T18d7cKA', name: 'BBC Studios' },
  ],
  sport: [
    { id: 'UCTU_wC79Dgi9rh4e9-baTqA', name: 'Sky Sports' },
    { id: 'UCW6-BQWFA70Dyyc7ZpZ9Xlg', name: 'BBC Sport' },
    { id: 'UC7HEj8odlxsmyyzmBFK6Znw', name: 'TNT Sports' },
  ],
  news: [
    { id: 'UC16niRr50-MSBwiO3YDb3RA', name: 'BBC News' },
    { id: 'UCoMdktPbSTixAyNGwb-UYkQ', name: 'Sky News' },
    { id: 'UCTrQ7HXWRRxr7OsOtodr2_w', name: 'Channel 4 News' },
    { id: 'UCIRYBXDze5krPDzAEOxFGVA', name: 'Guardian News' },
  ],
  radio: [
    { id: 'UC-FQUIVQ-bZiefzBiQAa8Fw', name: 'BBC Radio 1' },
    { id: 'UCGEIZdGkIYeU6FUwvkjCrIw', name: 'LBC' },
  ],
  humor: [
    { id: 'UCT5C7yaO3RVuOgwP8JVAujQ', name: 'Taskmaster' },
    { id: 'UC7foTxErVJKorAitAcJuqDA', name: 'BBC Comedy Greats' },
    { id: 'UCz1hQ68G3XPVYEBoFDgSjcQ', name: 'Channel 4 Entertainment' },
  ],
  media: [
    { id: 'UCYRE3PMYatMVXmqmulF0sgA', name: 'LADbible' },
    { id: 'UCn8zNIfYAQNdrFRrr8oibKw', name: 'VICE' },
  ],
};

export const YT_SECTIONS: YtSection[] = ['docs', 'news', 'sport', 'humor', 'media', 'radio'];

export function ytChannels(lang: string, country: string): Record<YtSection, YtChannel[]> {
  if (lang === 'fr') return FR;
  return ['GB', 'IE'].includes(country) ? GB : US;
}

/** one channel's latest videos (Shorts left out) from its RSS feed */
export function parseYtFeed(xml: string, channelName: string): ReplayItem[] {
  const out: ReplayItem[] = [];
  for (const entry of xml.split('<entry>').slice(1)) {
    const id = entry.match(/<yt:videoId>([\w-]{6,20})<\/yt:videoId>/)?.[1];
    const link = entry.match(/<link rel="alternate" href="([^"]+)"/)?.[1] || '';
    if (!id || link.includes('/shorts/')) continue;
    const title = decode(entry.match(/<title>([^<]*)<\/title>/)?.[1] || '');
    const published = Date.parse(entry.match(/<published>([^<]+)<\/published>/)?.[1] || '');
    const desc = decode(entry.match(/<media:description>([^<]*)<\/media:description>/)?.[1] || '');
    const views = parseInt(entry.match(/<media:statistics views="(\d+)"/)?.[1] || '0', 10);
    out.push({
      id: `yt:${id}`,
      provider: 'youtube',
      kind: 'video',
      title,
      subtitle: channelName,
      desc: desc.slice(0, 400) || undefined,
      image: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
      channel: channelName,
      published: Number.isNaN(published) ? undefined : published,
      views: views || undefined,
    });
  }
  return out;
}

const decode = (s: string) =>
  s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

async function feed(ch: YtChannel): Promise<ReplayItem[]> {
  const res = await fetchWithTimeout(`https://www.youtube.com/feeds/videos.xml?channel_id=${ch.id}`, { timeoutMs: 15000 });
  return parseYtFeed(await res.text(), ch.name);
}

/** one rail per theme: the newest videos of its channels, a few per channel at most */
export async function youtubeRails(lang: string, country: string, titles: Record<YtSection, string>): Promise<ReplayRail[]> {
  const conf = ytChannels(lang, country);
  const rails: ReplayRail[] = [];
  await Promise.all(
    YT_SECTIONS.map(async (sec) => {
      const lists = await Promise.all(conf[sec].map((ch) => feed(ch).catch(() => [] as ReplayItem[])));
      // the latest videos first, mixing channels (at most 8 per channel)
      const items = lists.flatMap((l) => l.slice(0, 8)).sort((a, b) => (b.published || 0) - (a.published || 0)).slice(0, 30);
      if (items.length >= 4) rails.push({ id: `yt:${sec}`, provider: 'youtube', title: titles[sec], items });
    }),
  );
  return YT_SECTIONS.map((s) => rails.find((r) => r.id === `yt:${s}`)).filter((r): r is ReplayRail => !!r);
}
