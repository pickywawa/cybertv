import { describe, expect, it } from 'vitest';
import { certToAge } from '../src/core/enrich/cert';
import { matchEvent, scoreLabel, type LiveEvent } from '../src/core/sports';

describe('age ratings', () => {
  it('normalises the main systems', () => {
    expect(certToAge('FR', '12')).toBe(12);
    expect(certToAge('FR', 'U')).toBe(0);
    expect(certToAge('US', 'PG-13')).toBe(13);
    expect(certToAge('US', 'TV-MA')).toBe(17);
    expect(certToAge('GB', '12A')).toBe(12);
    expect(certToAge('DE', '16')).toBe(16);
    expect(certToAge('XX', 'weird')).toBeUndefined();
  });
});

describe('live scores', () => {
  const at = Date.parse('2026-11-21T20:00:00Z');
  const ev: LiveEvent = {
    id: '1', start: at, state: 'in', detail: "67'",
    home: { name: 'Paris Saint-Germain', short: 'PSG', score: '2', keys: ['paris saint germain', 'psg', 'paris sg', 'paris'] },
    away: { name: 'Marseille', short: 'MAR', score: '1', keys: ['marseille', 'om', 'olympique de marseille'] },
  };
  const prog = (title: string, start = at - 15 * 60000) => ({ epgId: 'x', start, stop: start + 2 * 3600000, title });
  it('matches a programme naming both teams during the slot', () => {
    expect(matchEvent(prog('Football : PSG / OM'), [ev])?.id).toBe('1');
    expect(matchEvent(prog('Ligue 1 - Paris SG - Olympique de Marseille'), [ev])?.id).toBe('1');
  });
  it('ignores other programmes and other days', () => {
    expect(matchEvent(prog('Le journal de 20h'), [ev])).toBeUndefined();
    expect(matchEvent(prog('PSG - OM', at + 86400000), [ev])).toBeUndefined();
    expect(matchEvent(prog('Paris, la ville lumière : promenade'), [ev])).toBeUndefined();
  });
  it('understands French names of national teams', () => {
    const rugby: LiveEvent = {
      id: '2', start: at, state: 'post', detail: 'FT',
      home: { name: 'England', short: 'ENG', score: '24', keys: ['england', 'angleterre'] },
      away: { name: 'New Zealand', short: 'NZ', score: '22', keys: ['new zealand', 'nouvelle zelande'] },
    };
    expect(matchEvent(prog('Rugby : Championnat des nations | Angleterre / Nouvelle-Zélande'), [rugby])?.id).toBe('2');
  });
  it('formats the score', () => {
    expect(scoreLabel(ev)).toBe("PSG 2 – 1 MAR · 67'");
  });
});

import { pruneLooksSafe } from '../src/core/sync/sync';

describe('catalogue protection', () => {
  it('never wipes a catalogue on an empty or collapsed list', () => {
    expect(pruneLooksSafe(0, 0)).toBe(true);
    expect(pruneLooksSafe(5000, 0)).toBe(false);
    expect(pruneLooksSafe(5000, 800)).toBe(false);
    expect(pruneLooksSafe(5000, 4200)).toBe(true);
    expect(pruneLooksSafe(50, 10)).toBe(true);
  });
});

import { resizeTmdb } from '../src/core/enrich/tmdb';
import { cleanName } from '../src/core/util/text';
import { genreKeys } from '../src/core/util/genres';

describe('device fixes', () => {
  it('resizes every TMDB url form', () => {
    expect(resizeTmdb('https://image.tmdb.org/t/p/w600_and_h900_bestv2/abc.jpg', 'w342')).toBe('https://image.tmdb.org/t/p/w342/abc.jpg');
    expect(resizeTmdb('https://image.tmdb.org/t/p/original/abc.jpg', 'w780')).toBe('https://image.tmdb.org/t/p/w780/abc.jpg');
    expect(resizeTmdb('http://1.2.3.4/p.jpg', 'w342')).toBe('http://1.2.3.4/p.jpg');
  });
  it('cleans trailing slashes of channel names', () => {
    expect(cleanName('TF1 //')).toBe('TF1');
    expect(cleanName('FRANCE 2 /')).toBe('FRANCE 2');
  });
  it('finds genres from TMDB or the provider category', () => {
    expect(genreKeys({ genres: ['Drame', 'Comédie'] })).toEqual(['comedy', 'drama']);
    expect(genreKeys({}, 'COMEDIE [FR]')).toEqual(['comedy']);
    expect(genreKeys({}, 'CRIME-THRILLER [FR]')).toEqual(['thriller']);
    expect(genreKeys({}, 'NETFLIX [NL]')).toEqual([]);
  });
});

import { cleanEpisodeTitle, isGenericEpisodeTitle } from '../src/core/util/text';
describe('episode titles', () => {
  it('drops the show name and number', () => {
    expect(cleanEpisodeTitle("Where's Wanda? (2024) - S01E01 - Les Klatt")).toBe('Les Klatt');
    expect(cleanEpisodeTitle('Lupin S02 E05')).toBe('Lupin S02 E05');
    expect(cleanEpisodeTitle('Le pilote')).toBe('Le pilote');
    expect(isGenericEpisodeTitle('Show (2020) - S01E02')).toBe(true);
  });
});
