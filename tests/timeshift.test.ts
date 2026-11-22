import { describe, expect, it } from 'vitest';
import { attrs, pickVariant } from '../dev-server/timeshift';
import { timeshiftUrl, setProxyBase } from '../src/core/net/http';

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Audio Description",LANGUAGE="qad",DEFAULT=NO,URI="ad.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",NAME="Français",LANGUAGE="fra",DEFAULT=YES,URI="fr.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="aac"
low.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.640029,mp4a.40.2",AUDIO="aac"
hd.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=16000000,RESOLUTION=3840x2160,AUDIO="aac"
uhd.m3u8
`;

describe('live timeshift', () => {
  it('reads attributes with quoted commas', () => {
    expect(attrs('#EXT-X-STREAM-INF:BANDWIDTH=1,CODECS="a,b",AUDIO="x"')).toEqual({ BANDWIDTH: '1', CODECS: '"a,b"', AUDIO: '"x"' });
  });

  it('records the best variant up to 1080p and its default audio', () => {
    const v = pickVariant(MASTER, 'https://cdn.example/live/master.m3u8')!;
    expect(v.video).toBe('https://cdn.example/live/hd.m3u8');
    expect(v.audio).toBe('https://cdn.example/live/fr.m3u8');
  });

  it('wraps only HLS urls, when a local proxy exists', () => {
    setProxyBase(null);
    expect(timeshiftUrl('https://x/live.m3u8', 1800)).toBeNull();
    setProxyBase('http://127.0.0.1:38517/proxy?u=');
    expect(timeshiftUrl('https://x/a/index.m3u8?token=1', 1800)).toBe('http://127.0.0.1:38517/tsh/start/live.m3u8?max=1800&u=' + encodeURIComponent('https://x/a/index.m3u8?token=1'));
    expect(timeshiftUrl('https://x/live/u/p/1.ts', 1800)).toBeNull();
    expect(timeshiftUrl('https://x/a.m3u8', 0)).toBeNull();
    setProxyBase(null);
  });
});
