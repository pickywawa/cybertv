import { describe, expect, it } from 'vitest';
import { parseVoice, wordsToDigits } from '../src/core/voice/parse';

describe('voice commands', () => {
  it('spells numbers', () => {
    expect(wordsToDigits('france deux')).toBe('france 2');
    expect(wordsToDigits('quarante cinq secondes')).toBe('45 secondes');
    expect(wordsToDigits('trente et un')).toBe('31');
  });

  it('switches tabs', () => {
    expect(parseVoice('Accueil')).toEqual({ type: 'tab', tab: 'home' });
    expect(parseVoice('va sur l’accueil')).toEqual({ type: 'tab', tab: 'home' });
    expect(parseVoice('En direct')).toEqual({ type: 'tab', tab: 'tv' });
    expect(parseVoice('ouvre le replay')).toEqual({ type: 'tab', tab: 'replay' });
    expect(parseVoice('mes vidéos')).toEqual({ type: 'tab', tab: 'myvideos' });
    expect(parseVoice('Paramètres')).toEqual({ type: 'tab', tab: 'settings' });
    expect(parseVoice('go home')).toEqual({ type: 'tab', tab: 'home' });
  });

  it('plays channels, movies and series', () => {
    expect(parseVoice('Mets Canal+')).toEqual({ type: 'play', query: 'canal' });
    expect(parseVoice('mets canal plus')).toEqual({ type: 'play', query: 'canal' });
    expect(parseVoice('mets France deux')).toEqual({ type: 'play', query: 'france 2' });
    expect(parseVoice('TF1')).toEqual({ type: 'play', query: 'tf1' });
    expect(parseVoice('mets la chaîne 5')).toEqual({ type: 'channel', query: '5', num: 5 });
    expect(parseVoice('lance le film Dune')).toEqual({ type: 'movie', query: 'dune' });
    expect(parseVoice('mets la série Lupin')).toEqual({ type: 'series', query: 'lupin' });
    expect(parseVoice('play the movie Inception')).toEqual({ type: 'movie', query: 'inception' });
  });

  it('searches', () => {
    expect(parseVoice('Recherche Le Seigneur des anneaux')).toEqual({ type: 'search', query: 'seigneur des anneaux' });
    expect(parseVoice('recherche')).toEqual({ type: 'tab', tab: 'search' });
  });

  it('drives the player only while watching', () => {
    const p = { inPlayer: true };
    expect(parseVoice('pause', p)).toEqual({ type: 'player', action: 'pause' });
    expect(parseVoice('reprends', p)).toEqual({ type: 'player', action: 'resume' });
    expect(parseVoice('recule de 30 secondes', p)).toEqual({ type: 'player', action: 'back', seconds: 30 });
    expect(parseVoice('reviens en arrière de deux minutes', p)).toEqual({ type: 'player', action: 'back', seconds: 120 });
    expect(parseVoice('avance', p)).toEqual({ type: 'player', action: 'forward', seconds: 30 });
    expect(parseVoice('reviens au direct', p)).toEqual({ type: 'player', action: 'live' });
    expect(parseVoice('chaîne suivante', p)).toEqual({ type: 'player', action: 'next' });
    expect(parseVoice('stop', p)).toEqual({ type: 'player', action: 'stop' });
    // outside the player, "en direct" is the tab
    expect(parseVoice('en direct')).toEqual({ type: 'tab', tab: 'tv' });
    // in the player, other commands still work
    expect(parseVoice('mets France 3', p)).toEqual({ type: 'play', query: 'france 3' });
  });
});
