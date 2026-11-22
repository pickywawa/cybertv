import { describe, expect, it } from 'vitest';
import { channelCountry, channelLangs, detectLangs, langScore, sortByLang, toLang } from '../src/core/util/lang';
import { channelRank, programBoost, rankChannels } from '../src/core/channelRank';
import type { Channel } from '../src/core/types';

describe('language detection', () => {
  it('reads provider tags', () => {
    expect(detectLangs('FR: Dune (2021)').audio).toEqual(['fr']);
    expect(detectLangs('Dune 2021 VOSTFR')).toMatchObject({ audio: [], subs: ['fr'] });
    expect(detectLangs('Dune MULTI 4K')).toMatchObject({ audio: ['fr'], multi: true });
    expect(detectLangs('|EN| The Batman').audio).toEqual(['en']);
    expect(detectLangs('It (2017)').audio).toEqual([]); // not Italian
    expect(detectLangs('The Batman', 'FRANCE | FILMS').audio).toEqual(['fr']);
  });
  it('normalises track languages', () => {
    expect(toLang('fre')).toBe('fr');
    expect(toLang('fr-FR')).toBe('fr');
    expect(toLang('English')).toBe('en');
    expect(toLang('und')).toBeUndefined();
  });
  it('detects channel country and language', () => {
    expect(channelCountry('TF1 HD', 'TNT', 'tf1.fr')).toBe('FR');
    expect(channelCountry('UK: BBC One')).toBe('GB');
    expect(channelLangs('BBC One', undefined, 'bbcone.uk')).toEqual(['en']);
    expect(channelLangs('Al Jazeera', undefined, undefined, 'Arabic')).toEqual(['ar']);
  });
  it('scores and sorts by preference', () => {
    const prefs = { audio: ['fr', 'en'], subs: ['fr'] };
    expect(langScore({ langs: ['fr'] }, prefs)).toBe(0);
    expect(langScore({ langs: ['en'] }, prefs)).toBe(1);
    expect(langScore({ langs: [], subs: ['fr'] }, prefs)).toBe(2);
    expect(langScore({}, prefs)).toBe(3);
    expect(langScore({ langs: ['de'] }, prefs)).toBe(4);
    const rows = [{ id: 'de', langs: ['de'] }, { id: 'x' }, { id: 'en', langs: ['en'] }, { id: 'fr', langs: ['fr'] }];
    expect(sortByLang(rows, prefs).map((r) => r.id)).toEqual(['fr', 'en', 'x', 'de']);
  });
});

describe('channel ranking', () => {
  const ch = (name: string, num: number, extra: Partial<Channel> = {}): Channel => ({
    id: name, sourceId: 's', profileId: 'p', extId: name, rawName: name, name, universe: 'general', catchupDays: 0, catchupMode: null,
    quality: null, groupKey: name, num, langs: ['fr'], country: 'FR', ...extra,
  });
  it('knows the main French channels', () => {
    expect(channelRank({ name: 'TF1' }, 'FR')).toBe(0);
    expect(channelRank({ name: 'France 2' }, 'FR')).toBe(1);
    expect(channelRank({ name: 'Canal+' }, 'FR')).toBeDefined();
    expect(channelRank({ name: 'France 3 Paris Île-de-France' }, 'FR')).toBeGreaterThan(channelRank({ name: 'France 3' }, 'FR')!);
  });
  it('keeps national channels first; a live match only passes channels of similar audience', () => {
    const list = [ch('Some Local TV', 1), ch('France 2', 2), ch('TF1', 3), ch('RMC Sport 1', 4, { epgId: 'rmc' })];
    const prefs = { audio: ['fr'], subs: ['fr'] };
    expect(rankChannels(list, { country: 'FR', prefs }).map((c) => c.name).slice(0, 2)).toEqual(['TF1', 'France 2']);
    const at = Date.now();
    const programs = new Map([['rmc', { epgId: 'rmc', start: at - 600000, stop: at + 5400000, title: 'PSG - OM', category: 'Football' }]]);
    expect(programBoost(programs.get('rmc'), at)).toBeGreaterThan(0);
    expect(rankChannels(list, { country: 'FR', prefs, programs, at })[0].name).toBe('TF1');
    // L'Équipe and RMC Sport are close in audience: the one showing the match comes first
    const sport = [ch('RMC Sport 1', 1), ch("L'Equipe", 2, { epgId: 'eq' })];
    const p2 = new Map([['eq', { epgId: 'eq', start: at - 600000, stop: at + 5400000, title: 'Nantes - Lens', category: 'Football' }]]);
    expect(rankChannels(sport, { country: 'FR', prefs, programs: p2, at })[0].name).toBe("L'Equipe");
    // provider junk around names
    expect(rankChannels([ch('TF1 //', 1), ch('FRANCE 2 /', 2)], { country: 'FR', prefs })[0].name).toBe('TF1 //');
  });
  it('pushes foreign-language channels down', () => {
    const list = [ch('BBC One', 1, { langs: ['en'], country: 'GB' }), ch('W9', 2)];
    expect(rankChannels(list, { country: 'FR', prefs: { audio: ['fr'], subs: [] } })[0].name).toBe('W9');
  });
});
