import { describe, expect, it } from 'vitest';
import { cmpVersion, decide } from '../src/core/updater';
import { isFinished } from '../src/core/repo';

describe('self-update decision', () => {
  const m = { version: '0.3.1', versionCode: 3, minVersionCode: 3, apk: 'a', web: 'w' };
  it('compares versions', () => {
    expect(cmpVersion('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(cmpVersion('1.0', '1.0.0')).toBe(0);
  });
  it('installs a newer web bundle silently when the APK is recent enough', () => {
    expect(decide(m, { versionCode: 3, webVersion: '0.3.0' })).toBe('web');
  });
  it('asks for the APK when the web bundle needs a newer native side', () => {
    expect(decide(m, { versionCode: 2, webVersion: '0.2.0' })).toBe('apk');
  });
  it('does nothing when up to date', () => {
    expect(decide(m, { versionCode: 3, webVersion: '0.3.1' })).toBe('none');
  });
});

describe('finished detection (credits)', () => {
  it('treats leaving during the end credits as finished', () => {
    expect(isFinished(82 * 60, 90 * 60)).toBe(true); // 8 min left of 90
    expect(isFinished(70 * 60, 90 * 60)).toBe(false);
    expect(isFinished(20.5 * 60, 22 * 60)).toBe(true); // 1.5 min left of an episode
    expect(isFinished(15 * 60, 22 * 60)).toBe(false);
    expect(isFinished(100, 0)).toBe(false);
  });
});

import { serversOf } from '../src/core/sources/servers';

describe('source servers', () => {
  it('puts the server in use first, then the others in order', () => {
    expect(serversOf({ type: 'xtream', url: 'b.tv:8080', servers: ['http://a.tv', 'http://b.tv:8080', 'http://c.tv/'] })).toEqual([
      'http://b.tv:8080', 'http://a.tv', 'http://c.tv',
    ]);
    expect(serversOf({ type: 'm3u', url: 'https://x/list.m3u' })).toEqual(['https://x/list.m3u']);
  });
});
