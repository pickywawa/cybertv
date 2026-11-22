import { describe, expect, it } from 'vitest';
import { arteItem } from '../src/core/replay/arte';
import { ftvItem } from '../src/core/replay/francetv';
import { officialFor } from '../src/core/replay';
import { channelGroupKey } from '../src/core/util/text';

describe('replay parsing', () => {
  it('reads ARTE teasers (videos and collections)', () => {
    const v = arteItem({
      programId: '117142-000-A', title: 'Les cigales', subtitle: 'Sous-titre', duration: 5660, ageRating: 0,
      mainImage: { url: 'https://api-cdn.arte.tv/img/v2/image/X/__SIZE__?type=TEXT' },
      availability: { end: '2027-02-18T04:00:00Z', hasVideoStreams: true }, player: { config: 'x' }, kind: { code: 'SHOW', isCollection: false },
    });
    expect(v).toMatchObject({ id: 'arte:117142-000-A', kind: 'video', durationSec: 5660, channel: 'ARTE', age: 0 });
    expect(v?.image).toContain('/940x530');
    expect(v?.expires).toBe(Date.parse('2027-02-18T04:00:00Z'));
    expect(arteItem({ programId: 'RC-027966', title: 'Beforeigners', kind: { isCollection: true } })?.kind).toBe('show');
    expect(arteItem({ title: 'no id' })).toBeNull();
  });

  it('reads france.tv videos and programs, skips lives and expired ones', () => {
    const v = ftvItem({
      type: 'integrale', si_id: 'abc', title: 'Chute libre', episode_title: 'Chute libre', episode: 4, season: 1, duration: 5245,
      end_date: Date.now() / 1000 + 86400, rating_csa_code: 'TP', program: { label: 'Noir comme neige' }, channel: { label: 'France 2' },
      description: '<p>Un <strong>texte</strong></p>',
    });
    expect(v).toMatchObject({ id: 'ftv:abc', title: 'Noir comme neige', subtitle: 'S1 E4 · Chute libre', age: 0, channel: 'France 2', desc: 'Un texte' });
    expect(ftvItem({ type: 'program', program_path: 'france-2_x', label: 'X' })).toMatchObject({ id: 'ftvp:france-2_x', kind: 'show' });
    expect(ftvItem({ type: 'integrale', si_id: 'a', title: 't', is_live: true })).toBeNull();
    expect(ftvItem({ type: 'integrale', si_id: 'a', title: 't', end_date: 1000 })).toBeNull();
  });
});

describe('official live streams', () => {
  it('matches public channels by name or iptv-org id', () => {
    expect(officialFor({ groupKey: channelGroupKey('FR: France 2 FHD') })?.key).toBe('france2');
    expect(officialFor({ groupKey: channelGroupKey('|FR| ARTE HD') })?.key).toBe('arte');
    expect(officialFor({ groupKey: 'ch:whatever', iptvId: 'France5.fr@SD' })?.key).toBe('france5');
    expect(officialFor({ groupKey: channelGroupKey('TF1 HD') })).toBeUndefined();
    expect(officialFor({ groupKey: channelGroupKey('France 3 Alpes') })).toBeUndefined();
  });
});

import { parseYtFeed, ytChannels } from '../src/core/replay/youtube';
describe('YouTube feeds', () => {
  it('reads videos and leaves Shorts out', () => {
    const xml = `<feed><title>BFMTV</title>
<entry><yt:videoId>EQ3zCQe9Pm0</yt:videoId><title>Affaire &amp; mystère</title><link rel="alternate" href="https://www.youtube.com/watch?v=EQ3zCQe9Pm0"/><published>2026-11-22T08:00:58+00:00</published><media:group><media:description>Résumé</media:description><media:community><media:statistics views="132"/></media:community></media:group></entry>
<entry><yt:videoId>ymhpyZH0KFE</yt:videoId><title>Short</title><link rel="alternate" href="https://www.youtube.com/shorts/ymhpyZH0KFE"/><published>2026-11-22T07:30:19+00:00</published></entry>
</feed>`;
    const items = parseYtFeed(xml, 'BFMTV');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'yt:EQ3zCQe9Pm0', provider: 'youtube', title: 'Affaire & mystère', channel: 'BFMTV', views: 132, desc: 'Résumé' });
    expect(items[0].image).toBe('https://i.ytimg.com/vi/EQ3zCQe9Pm0/mqdefault.jpg');
  });
  it('picks channels by language and country', () => {
    expect(ytChannels('fr', 'FR').news[0].name).toBe('BFMTV');
    expect(ytChannels('en', 'GB').news[0].name).toBe('BBC News');
    expect(ytChannels('en', 'US').news[0].name).toBe('CNN');
    expect(ytChannels('en', 'AU').news[0].name).toBe('CNN');
  });
});
