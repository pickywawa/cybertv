import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * DEV ONLY — a fake Xtream Codes panel so the whole app (live, EPG, catch-up, VOD, series)
 * can be exercised without a real provider. Every stream redirects to public, freely
 * licensed test videos (Blender open movies, Apple/Mux/Akamai test streams).
 *
 * Server URL: http://localhost:5173/mock-xtream   user: demo   pass: demo
 * M3U:        http://localhost:5173/mock-xtream/get.php?username=demo&password=demo&type=m3u_plus
 */

const USER = 'demo';
const PASS = 'demo';

const STREAMS = {
  bbb: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8',
  bipbop: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8',
  tears: 'https://demo.unified-streaming.com/k8s/features/stable/video/tears-of-steel/tears-of-steel.ism/.m3u8',
  live1: 'https://cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8',
  mp4bbb: 'https://archive.org/download/BigBuckBunny_328/BigBuckBunny_512kb.mp4',
  mp4ed: 'https://archive.org/download/ElephantsDream/ed_1024_512kb.mp4',
  mp4sintel: 'https://archive.org/download/Sintel/sintel-2048-surround_512kb.mp4',
  mp4tos: 'https://archive.org/download/Tears-of-Steel/tears_of_steel_720p.mp4',
};
const LIVE_POOL = [STREAMS.live1, STREAMS.bbb, STREAMS.tears, STREAMS.bipbop];
const VOD_POOL = [STREAMS.mp4bbb, STREAMS.mp4ed, STREAMS.mp4sintel, STREAMS.mp4tos, STREAMS.bbb, STREAMS.tears];

const LIVE_CATS = [
  { id: '1', name: 'FR | Généralistes' },
  { id: '2', name: 'FR | Sport' },
  { id: '3', name: 'FR | Cinéma' },
  { id: '4', name: 'FR | Jeunesse' },
  { id: '5', name: 'FR | Infos' },
  { id: '6', name: 'FR | Séries' },
  { id: '7', name: 'FR | Découverte' },
  { id: '8', name: 'FR | Musique' },
];

const CHANNEL_NAMES: [string, string][] = [
  ['1', 'Nova Une'], ['1', 'Nova Deux'], ['1', 'Horizon TV'], ['1', 'Canal Azur'],
  ['2', 'Arena Sport 1'], ['2', 'Arena Sport 2'], ['2', 'Golf Plus'], ['2', 'Equi TV'],
  ['3', 'Ciné Club'], ['3', 'Ciné Frisson'], ['3', 'Ciné Classic'],
  ['4', 'Kids Planet'], ['4', 'Toon Zone'],
  ['5', 'Info Continu'], ['5', 'World News 24'],
  ['6', 'Séries Max'], ['6', 'Polar TV'],
  ['7', 'Planète Découverte'], ['7', 'Voyage HD'],
  ['8', 'Hits Music'], ['8', 'Jazz Lounge'],
];

const LIVE = CHANNEL_NAMES.flatMap(([cat, name], i) => {
  const base = {
    stream_id: 1000 + i * 10,
    name: `FR: ${name} FHD`,
    epg_channel_id: `${name.replace(/\s+/g, '')}.fr`,
    category_id: cat,
    tv_archive: i % 3 === 0 ? 0 : 1,
    tv_archive_duration: i % 3 === 0 ? 0 : 7,
    stream_icon: `https://placehold.co/400x240/1b1d24/ffffff/png?text=${encodeURIComponent(name)}&font=montserrat`,
    num: i + 1,
    added: String(1700000000 + i * 1000),
  };
  // second quality variant for a few channels → exercises quality grouping / fallback
  const out = [base];
  if (i % 4 === 0) out.push({ ...base, stream_id: base.stream_id + 1, name: `FR: ${name} HD`, num: 100 + i });
  return out;
});

const VOD_CATS = [
  { id: '10', name: 'VOD | Nouveautés' },
  { id: '11', name: 'VOD | Action' },
  { id: '12', name: 'VOD | Science-Fiction' },
  { id: '13', name: 'VOD | Drame' },
  { id: '14', name: 'VOD | Animation' },
  { id: '15', name: 'VOD | Comédie' },
];

const MOVIES: [string, number, number, string][] = [
  ['FR - Dune (2021) 4K', 2021, 438631, '12'], ['FR - Dune : Deuxième partie (2024)', 2024, 693134, '10'],
  ['FR - Oppenheimer (2023) MULTI', 2023, 872585, '13'], ['Inception (2010)', 2010, 27205, '12'],
  ['FR - Interstellar (2014) FHD', 2014, 157336, '12'], ['The Dark Knight (2008)', 2008, 155, '11'],
  ['|FR| Parasite (2019)', 2019, 496243, '13'], ['FR - Intouchables (2011)', 2011, 77338, '15'],
  ['Le Fabuleux Destin d\'Amélie Poulain (2001)', 2001, 194, '15'], ['FR - Avatar (2009) 4K HDR', 2009, 19995, '12'],
  ['Barbie (2023)', 2023, 346698, '15'], ['FR - Top Gun : Maverick (2022)', 2022, 361743, '11'],
  ['Spider-Man : Across the Spider-Verse (2023)', 2023, 569094, '14'], ['Matrix (1999)', 1999, 603, '12'],
  ['Pulp Fiction (1994)', 1994, 680, '13'], ['Fight Club (1999)', 1999, 550, '13'],
  ['FR - Le Comte de Monte-Cristo (2024)', 2024, 1084736, '10'], ['Anatomie d\'une chute (2023)', 2023, 915935, '10'],
  ['Mission : Impossible - Dead Reckoning (2023)', 2023, 575264, '11'], ['Gladiator (2000)', 2000, 98, '11'],
  ['Titanic (1997)', 1997, 597, '13'], ['Joker (2019)', 2019, 475557, '13'], ['Coco (2017)', 2017, 354912, '14'],
  ['Là-haut (2009)', 2009, 14160, '14'], ['Toy Story (1995)', 1995, 862, '14'],
  ['FR - Vice-Versa 2 (2024)', 2024, 1022789, '10'], ['Deadpool & Wolverine (2024)', 2024, 533535, '10'],
];

const NOW = Math.floor(Date.now() / 1000);
const VOD = MOVIES.map(([name, year, tmdb, cat], i) => ({
  stream_id: 5000 + i,
  name,
  year: String(year),
  stream_icon: '',
  rating: '',
  added: String(NOW - i * 86400 * 3),
  category_id: cat,
  container_extension: 'mp4',
  tmdb: String(tmdb),
}));

const SERIES_CATS = [
  { id: '20', name: 'SÉRIES | Drame' },
  { id: '21', name: 'SÉRIES | Science-Fiction' },
  { id: '22', name: 'SÉRIES | Comédie' },
];
const SERIES: [string, number, string, number][] = [
  ['Breaking Bad', 1396, '20', 5], ['Game of Thrones', 1399, '20', 8], ['Stranger Things', 66732, '21', 4],
  ['The Office (US)', 2316, '22', 9], ['FR - Lupin', 96677, '20', 3], ['The Last of Us', 100088, '21', 2],
  ['Dark', 70523, '21', 3], ['Arcane', 94605, '21', 2], ['Chernobyl', 87108, '20', 1],
];
const SERIES_LIST = SERIES.map(([name, tmdb, cat, seasons], i) => ({
  series_id: 8000 + i,
  name,
  cover: '',
  plot: '',
  rating: '',
  category_id: cat,
  last_modified: String(NOW - i * 86400 * 5),
  tmdb: String(tmdb),
  seasons_count: seasons,
}));

/**
 * user "big" / pass "big": a provider-sized catalogue (60 000 films, 15 000 series) to measure
 * how the app copes on slow TV boxes. Titles reuse the demo ones with real TMDB ids.
 */
const BIG_N = { vod: 60000, series: 15000 };
let bigCache: { vod: typeof VOD; series: typeof SERIES_LIST } | null = null;
function big() {
  if (bigCache) return bigCache;
  const vod = Array.from({ length: BIG_N.vod }, (_, i) => {
    const b = VOD[i % VOD.length];
    return { ...b, stream_id: 100000 + i, name: i < VOD.length ? b.name : `${b.name.replace(/ \(\d{4}\).*$/, '')} ${Math.floor(i / VOD.length)} (${2000 + (i % 25)})`, added: String(NOW - i * 600), tmdb: i < VOD.length ? b.tmdb : '' };
  });
  const series = Array.from({ length: BIG_N.series }, (_, i) => {
    const b = SERIES_LIST[i % SERIES_LIST.length];
    return { ...b, series_id: 200000 + i, name: i < SERIES_LIST.length ? b.name : `${b.name} ${Math.floor(i / SERIES_LIST.length)}`, tmdb: i < SERIES_LIST.length ? b.tmdb : '' };
  });
  return (bigCache = { vod, series });
}

function epgFor(ch: (typeof LIVE)[number], from: number, to: number) {
  const titles = ['Journal', 'Magazine', 'Documentaire', 'Film', 'Série', 'Sport en direct', 'Talk-show', 'Météo', 'Divertissement'];
  const out: { title: string; desc: string; start: number; stop: number }[] = [];
  const seed = ch.stream_id;
  let t = Math.floor(from / 1800) * 1800;
  let k = 0;
  while (t < to) {
    const dur = [1800, 3600, 5400, 2700][(seed + k) % 4];
    const title = `${titles[(seed + k) % titles.length]} ${((seed + k) % 50) + 1}`;
    out.push({
      title,
      desc: `Programme de démonstration « ${title} » diffusé sur ${ch.name.replace(/^FR: | FHD| HD$/g, '')}.`,
      start: t,
      stop: t + dur,
    });
    t += dur;
    k++;
  }
  return out;
}

const json = (res: ServerResponse, data: unknown) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end(JSON.stringify(data));
};
const redirect = (res: ServerResponse, to: string) => {
  res.statusCode = 302;
  res.setHeader('location', to);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.end();
};
const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const xmltvDate = (ts: number) => {
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}00 +0000`;
};

export function mockXtreamPlugin(): Plugin {
  return {
    name: 'cybertv-mock-xtream',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/mock-xtream', (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url || '/', 'http://x');
        const q = url.searchParams;
        const path = url.pathname;

        if (path === '/player_api.php') {
          const isBig = q.get('username') === 'big' && q.get('password') === 'big';
          if (!isBig && (q.get('username') !== USER || q.get('password') !== PASS)) return json(res, { user_info: { auth: 0 } });
          const action = q.get('action');
          const cat = q.get('category_id');
          const VODL = isBig ? big().vod : VOD;
          const SERL = isBig ? big().series : SERIES_LIST;
          switch (action) {
            case null:
            case '':
              return json(res, {
                user_info: {
                  username: USER, auth: 1, status: 'Active', exp_date: String(NOW + 86400 * 120),
                  max_connections: '2', active_cons: '0', allowed_output_formats: ['m3u8', 'ts'],
                },
                server_info: { url: 'localhost', port: '5173', server_protocol: 'http', timezone: 'UTC', timestamp_now: NOW },
              });
            case 'get_live_categories': return json(res, LIVE_CATS.map((c) => ({ category_id: c.id, category_name: c.name, parent_id: 0 })));
            case 'get_live_streams': return json(res, LIVE.filter((s) => !cat || s.category_id === cat));
            case 'get_vod_categories': return json(res, VOD_CATS.map((c) => ({ category_id: c.id, category_name: c.name, parent_id: 0 })));
            case 'get_vod_streams': return json(res, VODL.filter((s) => !cat || s.category_id === cat));
            case 'get_series_categories': return json(res, SERIES_CATS.map((c) => ({ category_id: c.id, category_name: c.name, parent_id: 0 })));
            case 'get_series': return json(res, SERL.filter((s) => !cat || s.category_id === cat));
            case 'get_vod_info': {
              const v = VODL.find((x) => String(x.stream_id) === q.get('vod_id'));
              if (!v) return json(res, {});
              return json(res, {
                info: { tmdb_id: v.tmdb, name: v.name, plot: '', releasedate: `${v.year}-01-01`, duration_secs: 5400 + (v.stream_id % 40) * 60 },
                movie_data: { stream_id: v.stream_id, name: v.name, added: v.added, container_extension: 'mp4' },
              });
            }
            case 'get_series_info': {
              const s = SERL.find((x) => String(x.series_id) === q.get('series_id'));
              if (!s) return json(res, {});
              const episodes: Record<string, unknown[]> = {};
              for (let season = 1; season <= s.seasons_count; season++) {
                episodes[String(season)] = Array.from({ length: 6 }, (_, e) => ({
                  id: String(s.series_id * 1000 + season * 100 + e + 1),
                  episode_num: e + 1,
                  title: `${s.name} - S${String(season).padStart(2, '0')}E${String(e + 1).padStart(2, '0')}`,
                  container_extension: 'mp4',
                  season,
                  info: { duration_secs: 2400 + e * 120, plot: '' },
                }));
              }
              return json(res, { info: { name: s.name, tmdb: s.tmdb, plot: '' }, seasons: [], episodes });
            }
            case 'get_short_epg':
            case 'get_simple_data_table': {
              const ch = LIVE.find((x) => String(x.stream_id) === q.get('stream_id'));
              if (!ch) return json(res, { epg_listings: [] });
              const list = epgFor(ch, NOW - 3600 * 6, NOW + 3600 * 12).map((p, i) => ({
                id: String(i), channel_id: ch.epg_channel_id,
                title: Buffer.from(p.title).toString('base64'), description: Buffer.from(p.desc).toString('base64'),
                start_timestamp: String(p.start), stop_timestamp: String(p.stop),
                has_archive: ch.tv_archive && p.stop < NOW ? 1 : 0,
              }));
              return json(res, { epg_listings: list });
            }
            default:
              return json(res, []);
          }
        }

        if (path === '/xmltv.php') {
          res.setHeader('content-type', 'application/xml; charset=utf-8');
          res.setHeader('Access-Control-Allow-Origin', '*');
          const seen = new Set<string>();
          let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<tv generator-info-name="cybertv-mock">\n';
          for (const ch of LIVE) {
            if (seen.has(ch.epg_channel_id)) continue;
            seen.add(ch.epg_channel_id);
            xml += `<channel id="${ch.epg_channel_id}"><display-name>${xmlEsc(ch.name)}</display-name><icon src="${xmlEsc(ch.stream_icon)}"/></channel>\n`;
          }
          seen.clear();
          for (const ch of LIVE) {
            if (seen.has(ch.epg_channel_id)) continue;
            seen.add(ch.epg_channel_id);
            for (const p of epgFor(ch, NOW - 86400 * 3, NOW + 86400 * 2)) {
              xml += `<programme start="${xmltvDate(p.start)}" stop="${xmltvDate(p.stop)}" channel="${ch.epg_channel_id}"><title lang="fr">${xmlEsc(p.title)}</title><desc lang="fr">${xmlEsc(p.desc)}</desc><category lang="fr">Démo</category></programme>\n`;
            }
          }
          xml += '</tv>\n';
          return res.end(xml);
        }

        if (path === '/get.php') {
          if (q.get('username') !== USER || q.get('password') !== PASS) {
            res.statusCode = 401;
            return res.end();
          }
          const base = `http://${req.headers.host || 'localhost:5173'}/mock-xtream`;
          let m3u = `#EXTM3U url-tvg="${base}/xmltv.php?username=${USER}&password=${PASS}"\n`;
          for (const ch of LIVE) {
            const cat = LIVE_CATS.find((c) => c.id === ch.category_id)!.name;
            const catchup = ch.tv_archive ? ` catchup="xc" catchup-days="${ch.tv_archive_duration}"` : '';
            m3u += `#EXTINF:-1 tvg-id="${ch.epg_channel_id}" tvg-name="${ch.name}" tvg-logo="${ch.stream_icon}" group-title="${cat}"${catchup},${ch.name}\n${base}/live/${USER}/${PASS}/${ch.stream_id}.m3u8\n`;
          }
          for (const v of VOD) {
            const cat = VOD_CATS.find((c) => c.id === v.category_id)!.name;
            m3u += `#EXTINF:-1 tvg-name="${v.name}" tvg-logo="" group-title="${cat}",${v.name}\n${base}/movie/${USER}/${PASS}/${v.stream_id}.mp4\n`;
          }
          for (const s of SERIES_LIST) {
            const cat = SERIES_CATS.find((c) => c.id === s.category_id)!.name;
            for (let e = 1; e <= 3; e++) {
              const id = s.series_id * 1000 + 100 + e;
              m3u += `#EXTINF:-1 tvg-name="${s.name} S01 E0${e}" group-title="${cat}",${s.name} S01 E0${e}\n${base}/series/${USER}/${PASS}/${id}.mp4\n`;
            }
          }
          res.setHeader('content-type', 'audio/x-mpegurl; charset=utf-8');
          res.setHeader('Access-Control-Allow-Origin', '*');
          return res.end(m3u);
        }

        // Streams: /live|movie|series/user/pass/id.ext  and /timeshift/user/pass/dur/start/id.ext
        const m = path.match(/^\/(live|movie|series|timeshift)\/([^/]+)\/([^/]+)\/(.+)$/);
        if (m) {
          if (m[2] !== USER || m[3] !== PASS) {
            res.statusCode = 403;
            return res.end();
          }
          const id = parseInt(m[4].split('/').pop()!.split('.')[0], 10) || 0;
          if (m[1] === 'live') return redirect(res, LIVE_POOL[Math.floor(id / 10) % LIVE_POOL.length]);
          if (m[1] === 'timeshift') return redirect(res, STREAMS.tears);
          return redirect(res, VOD_POOL[id % VOD_POOL.length]);
        }

        res.statusCode = 404;
        res.end('not found');
      });
    },
  };
}
