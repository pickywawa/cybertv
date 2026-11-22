package app.cybertv.player;

import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Local timeshift for live HLS (same design as dev-server/timeshift.ts used by the desktop app):
 * a recorder follows the live playlists, keeps every segment on disk for up to `max` seconds and
 * serves them as a local live playlist with that whole window, so ExoPlayer can pause and go back
 * even when the provider offers no catch-up.
 *
 *   GET /tsh/start/live.m3u8?u=<live url>&max=<seconds>  → local master playlist (or a redirect to the url itself)
 *   GET /tsh/<sid>/<track>.m3u8 · /tsh/<sid>/<track>/<seq> · /tsh/<sid>/<track>/init · /tsh/<sid>/key/<n>
 */
final class Timeshift {
    private static final String TAG = "CyberTimeshift";
    private static final String VLC_UA = "VLC/3.0.20 LibVLC/3.0.20";
    private static final String BROWSER_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
    private static final long IDLE_MS = 2 * 60000;
    private static final Pattern ATTR = Pattern.compile("([A-Z0-9-]+)=(\"[^\"]*\"|[^,]*)");

    private final File root;
    private final Map<String, Session> sessions = new ConcurrentHashMap<>();

    Timeshift(File cacheDir) {
        root = new File(cacheDir, "timeshift");
        deleteRecursive(root); // leftovers of a previous run
        Thread reaper = new Thread(() -> {
            while (true) {
                try {
                    Thread.sleep(15000);
                } catch (InterruptedException e) {
                    return;
                }
                for (Iterator<Session> it = sessions.values().iterator(); it.hasNext(); ) {
                    Session s = it.next();
                    if (System.currentTimeMillis() - s.last > IDLE_MS) {
                        s.stop();
                        it.remove();
                    }
                }
            }
        }, "cyber-timeshift-reaper");
        reaper.setDaemon(true);
        reaper.start();
    }

    // ───────────────────────── http ─────────────────────────

    private static String ua(String url) {
        try {
            String h = URI.create(url).getHost();
            if (h != null && (h.equals("ftven.fr") || h.endsWith(".ftven.fr"))) return BROWSER_UA;
        } catch (Exception ignored) {
        }
        return VLC_UA;
    }

    /** body + final url (redirects followed, http <-> https too) */
    private static Object[] get(String url) throws IOException {
        String cur = url;
        for (int i = 0; i < 6; i++) {
            HttpURLConnection c = (HttpURLConnection) new URL(cur).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setRequestProperty("User-Agent", ua(cur));
            int code = c.getResponseCode();
            if (code >= 300 && code < 400 && c.getHeaderField("Location") != null) {
                cur = URI.create(cur).resolve(c.getHeaderField("Location")).toString();
                c.disconnect();
                continue;
            }
            if (code >= 400) {
                c.disconnect();
                throw new IOException("HTTP " + code);
            }
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream b = new ByteArrayOutputStream();
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
                return new Object[]{b.toByteArray(), cur};
            } finally {
                c.disconnect();
            }
        }
        throw new IOException("too many redirects");
    }

    private static String resolve(String base, String u) {
        return URI.create(base).resolve(u.trim().replace(" ", "%20")).toString();
    }

    static Map<String, String> attrs(String line) {
        Map<String, String> out = new HashMap<>();
        Matcher m = ATTR.matcher(line.substring(line.indexOf(':') + 1));
        while (m.find()) out.put(m.group(1), m.group(2));
        return out;
    }

    private static String unq(String v) {
        return v == null ? "" : v.replaceAll("^\"|\"$", "");
    }

    private static void write(File f, byte[] data) throws IOException {
        try (OutputStream o = new FileOutputStream(f)) {
            o.write(data);
        }
    }

    // ───────────────────────── recording ─────────────────────────

    private static final class Seg {
        final long seq;
        final double dur;
        final File file;
        final boolean disc;
        final int key;

        Seg(long seq, double dur, File file, boolean disc, int key) {
            this.seq = seq;
            this.dur = dur;
            this.file = file;
            this.disc = disc;
            this.key = key;
        }
    }

    private final class Track {
        final Session s;
        final String name;
        final File dir;
        volatile String url;
        final List<Seg> segs = new ArrayList<>();
        long seq = 0;
        long discSeq = 0;
        double target = 6;
        File map;
        Long lastUp = null;
        boolean forceDisc = false;
        volatile boolean stopped = false;
        final Object ready = new Object();
        boolean isReady = false;

        Track(Session s, String name, String url) {
            this.s = s;
            this.name = name;
            this.url = url;
            this.dir = new File(s.dir, name);
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
            Thread t = new Thread(this::loop, "cyber-timeshift-" + name);
            t.setDaemon(true);
            t.start();
        }

        private void loop() {
            int failures = 0;
            while (!stopped) {
                try {
                    Object[] r = get(url);
                    url = (String) r[1];
                    ingest(new String((byte[]) r[0], StandardCharsets.UTF_8), url);
                    failures = 0;
                } catch (Exception e) {
                    Log.d(TAG, name + " poll failed: " + e.getMessage());
                    // refused (one-connection subscriptions answer 509 / 407…): back off, then give up
                    if (++failures >= 8) {
                        s.stop();
                        sessions.remove(s.id);
                        return;
                    }
                    try {
                        Thread.sleep(Math.min(15000, 1000L << failures));
                    } catch (InterruptedException ie) {
                        return;
                    }
                    continue;
                }
                synchronized (this) {
                    if (segs.size() >= 1 && !isReady) {
                        isReady = true;
                        synchronized (ready) {
                            ready.notifyAll();
                        }
                    }
                }
                try {
                    Thread.sleep((long) Math.max(1000, target * 500));
                } catch (InterruptedException e) {
                    return;
                }
            }
        }

        boolean awaitReady(long ms) {
            long until = System.currentTimeMillis() + ms;
            synchronized (ready) {
                while (!isReady && System.currentTimeMillis() < until) {
                    try {
                        ready.wait(Math.max(1, until - System.currentTimeMillis()));
                    } catch (InterruptedException e) {
                        return false;
                    }
                }
            }
            return isReady;
        }

        private void ingest(String text, String base) throws IOException {
            String[] lines = text.split("\r?\n");
            int count = 0;
            long first = 0;
            for (String raw : lines) {
                String l = raw.trim();
                if (l.isEmpty()) continue;
                if (l.startsWith("#EXT-X-MEDIA-SEQUENCE")) {
                    try {
                        first = Long.parseLong(l.substring(l.indexOf(':') + 1).trim());
                    } catch (NumberFormatException ignored) {
                    }
                } else if (!l.startsWith("#")) count++;
            }
            long lastInList = first + count - 1;
            // segments are identified by media sequence number (urls may change on every fetch)
            if (lastUp == null) lastUp = lastInList - Math.min(4, count); // fast start: the last few only
            else if (lastInList < lastUp - 2) {
                lastUp = first - 1; // numbering restarted
                forceDisc = true;
            }
            double dur = 0;
            boolean disc = false;
            String keyLine = null;
            long n = first;
            for (String raw : lines) {
                String l = raw.trim();
                if (l.isEmpty()) continue;
                if (l.startsWith("#EXT-X-TARGETDURATION")) {
                    try {
                        target = Double.parseDouble(l.substring(l.indexOf(':') + 1).trim());
                    } catch (NumberFormatException ignored) {
                    }
                } else if (l.startsWith("#EXT-X-KEY")) keyLine = l;
                else if (l.startsWith("#EXT-X-MAP") && map == null) {
                    String u = unq(attrs(l).get("URI"));
                    if (!u.isEmpty()) {
                        File f = new File(dir, "init");
                        write(f, (byte[]) get(resolve(base, u))[0]);
                        map = f;
                    }
                } else if (l.startsWith("#EXTINF")) {
                    try {
                        dur = Double.parseDouble(l.substring(8).split(",")[0].trim());
                    } catch (NumberFormatException e) {
                        dur = 0;
                    }
                } else if (l.startsWith("#EXT-X-DISCONTINUITY") && !l.startsWith("#EXT-X-DISCONTINUITY-SEQUENCE")) disc = true;
                else if (!l.startsWith("#")) {
                    long up = n++;
                    if (up > lastUp) {
                        int key = keyLine != null ? s.key(keyLine, base) : -1;
                        File f = new File(dir, String.valueOf(seq));
                        try {
                            write(f, (byte[]) get(resolve(base, l))[0]);
                        } catch (IOException e) {
                            return; // retried at the next poll, in order
                        }
                        synchronized (this) {
                            segs.add(new Seg(seq, dur, f, disc || forceDisc, key));
                            seq++;
                            lastUp = up;
                            forceDisc = false;
                            trim();
                        }
                    }
                    dur = 0;
                    disc = false;
                }
            }
        }

        private void trim() {
            double total = 0;
            for (Seg x : segs) total += x.dur;
            // keep 20 % of the free space at least
            boolean lowDisk = dir.getUsableSpace() < 300L * 1024 * 1024;
            while (segs.size() > 3 && (total > s.max || lowDisk)) {
                Seg old = segs.remove(0);
                total -= old.dur;
                if (old.disc) discSeq++;
                //noinspection ResultOfMethodCallIgnored
                old.file.delete();
                lowDisk = lowDisk && dir.getUsableSpace() < 300L * 1024 * 1024 && segs.size() > 3;
            }
        }

        synchronized String playlist() {
            double td = target;
            for (Seg x : segs) td = Math.max(td, x.dur);
            StringBuilder b = new StringBuilder("#EXTM3U\n#EXT-X-VERSION:6\n");
            b.append("#EXT-X-TARGETDURATION:").append((int) Math.ceil(td)).append('\n');
            b.append("#EXT-X-MEDIA-SEQUENCE:").append(segs.isEmpty() ? 0 : segs.get(0).seq).append('\n');
            b.append("#EXT-X-DISCONTINUITY-SEQUENCE:").append(discSeq).append('\n');
            if (map != null) b.append("#EXT-X-MAP:URI=\"/tsh/").append(s.id).append('/').append(name).append("/init\"\n");
            int key = -2;
            for (Seg x : segs) {
                if (x.disc) b.append("#EXT-X-DISCONTINUITY\n");
                if (x.key != key) {
                    b.append(x.key < 0 ? "#EXT-X-KEY:METHOD=NONE" : s.keyLine(x.key)).append('\n');
                    key = x.key;
                }
                b.append("#EXTINF:").append(String.format(java.util.Locale.ROOT, "%.3f", x.dur)).append(",\n");
                b.append("/tsh/").append(s.id).append('/').append(name).append('/').append(x.seq).append('\n');
            }
            return b.toString();
        }

        synchronized File segment(String which) {
            if ("init".equals(which)) return map;
            for (Seg x : segs) if (String.valueOf(x.seq).equals(which)) return x.file;
            return null;
        }
    }

    private final class Session {
        final String id = UUID.randomUUID().toString().substring(0, 8);
        final File dir = new File(root, id);
        final double max;
        final String url;
        volatile long last = System.currentTimeMillis();
        final Map<String, Track> tracks = new ConcurrentHashMap<>();
        String master = "";
        private final List<String> keyLines = new ArrayList<>();
        private final Map<String, Integer> keyIndex = new HashMap<>();
        private final List<File> keyFiles = new ArrayList<>();
        private final Map<String, Integer> keyFileIdx = new HashMap<>();

        Session(double max, String url) {
            this.max = max;
            this.url = url;
            //noinspection ResultOfMethodCallIgnored
            dir.mkdirs();
        }

        /** AES-128 keys: fetched once per url, served locally */
        synchronized int key(String line, String base) throws IOException {
            Map<String, String> a = attrs(line);
            if ("NONE".equals(a.get("METHOD")) || a.get("URI") == null) return -1;
            String abs = resolve(base, unq(a.get("URI")));
            String k = abs + "|" + a.get("IV");
            Integer known = keyIndex.get(k);
            if (known != null) return known;
            Integer fileIdx = keyFileIdx.get(abs);
            if (fileIdx == null) {
                fileIdx = keyFiles.size();
                File f = new File(dir, "key" + fileIdx);
                write(f, (byte[]) get(abs)[0]);
                keyFiles.add(f);
                keyFileIdx.put(abs, fileIdx);
            }
            int n = keyLines.size();
            keyLines.add(line.replaceAll("URI=\"[^\"]*\"", "URI=\"/tsh/" + id + "/key/" + fileIdx + "\""));
            keyIndex.put(k, n);
            return n;
        }

        synchronized String keyLine(int n) {
            return keyLines.get(n);
        }

        synchronized File keyFile(int n) {
            return n >= 0 && n < keyFiles.size() ? keyFiles.get(n) : null;
        }

        void stop() {
            for (Track t : tracks.values()) t.stopped = true;
            deleteRecursive(dir);
        }
    }

    private synchronized Session start(String url, double max) throws IOException {
        for (Session s : sessions.values()) {
            if (s.url.equals(url) && s.max == max) {
                s.last = System.currentTimeMillis();
                return s;
            }
        }
        // one recording at a time: many subscriptions allow a single stream, the previous one must stop first
        stopAll();
        Session s = new Session(max, url);
        try {
            // a subscription limited to one stream refuses (407 / 509 / 429) until the previous one is released
            Object[] r = null;
            for (int attempt = 0; r == null; attempt++) {
                try {
                    r = get(url);
                } catch (IOException e) {
                    String m = String.valueOf(e.getMessage());
                    // up to ~15 s: one-connection subscriptions keep the previous stream "active" for a while after it stops
                    if (attempt >= 10 || !(m.contains("407") || m.contains("509") || m.contains("429") || m.contains("PROXY_AUTH"))) throw e;
                    try {
                        Thread.sleep(1500);
                    } catch (InterruptedException ie) {
                        throw e;
                    }
                }
            }
            String text = new String((byte[]) r[0], StandardCharsets.UTF_8);
            String base = (String) r[1];
            if (!text.trim().startsWith("#EXTM3U")) throw new IOException("not HLS");
            if (text.contains("#EXT-X-STREAM-INF")) buildMaster(s, text, base);
            else {
                s.tracks.put("v", new Track(s, "v", base));
                s.master = "#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-STREAM-INF:BANDWIDTH=4000000\n/tsh/" + s.id + "/v.m3u8\n";
            }
        } catch (IOException e) {
            s.stop();
            throw e;
        }
        sessions.put(s.id, s);
        return s;
    }

    /** best variant up to 1080p and its default audio rendition */
    private void buildMaster(Session s, String text, String base) throws IOException {
        String[] lines = text.split("\r?\n");
        String bestUri = null;
        Map<String, String> bestInf = null;
        long bestScore = Long.MIN_VALUE;
        for (int i = 0; i < lines.length; i++) {
            if (!lines[i].startsWith("#EXT-X-STREAM-INF")) continue;
            Map<String, String> inf = attrs(lines[i]);
            String uri = null;
            for (int j = i + 1; j < lines.length; j++) {
                String l = lines[j].trim();
                if (!l.isEmpty() && !l.startsWith("#")) {
                    uri = l;
                    break;
                }
            }
            if (uri == null) continue;
            int h = 0;
            try {
                String res = inf.get("RESOLUTION");
                if (res != null) h = Integer.parseInt(res.split("x")[1]);
            } catch (Exception ignored) {
            }
            long bw = 0;
            try {
                bw = Long.parseLong(inf.get("BANDWIDTH"));
            } catch (Exception ignored) {
            }
            long score = (h > 1080 ? -1_000_000_000_000L : 0) + bw;
            if (score > bestScore) {
                bestScore = score;
                bestUri = uri;
                bestInf = inf;
            }
        }
        if (bestUri == null) throw new IOException("no variant");
        s.tracks.put("v", new Track(s, "v", resolve(base, bestUri)));
        StringBuilder m = new StringBuilder("#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-INDEPENDENT-SEGMENTS\n");
        List<String> inf = new ArrayList<>();
        for (Map.Entry<String, String> e : bestInf.entrySet()) {
            if (!e.getKey().equals("SUBTITLES") && !e.getKey().equals("AUDIO")) inf.add(e.getKey() + "=" + e.getValue());
        }
        String group = unq(bestInf.get("AUDIO"));
        if (!group.isEmpty()) {
            Map<String, String> media = null;
            for (String l : lines) {
                if (!l.startsWith("#EXT-X-MEDIA") || !l.contains("TYPE=AUDIO")) continue;
                Map<String, String> a = attrs(l);
                if (!group.equals(unq(a.get("GROUP-ID"))) || a.get("URI") == null) continue;
                if (media == null || "YES".equals(a.get("DEFAULT"))) media = a;
                if ("YES".equals(a.get("DEFAULT"))) break;
            }
            if (media != null) {
                s.tracks.put("a", new Track(s, "a", resolve(base, unq(media.get("URI")))));
                String name = media.get("NAME") != null ? media.get("NAME") : "\"Audio\"";
                String lang = media.get("LANGUAGE") != null ? ",LANGUAGE=" + media.get("LANGUAGE") : "";
                m.append("#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"a\",NAME=").append(name).append(lang)
                        .append(",DEFAULT=YES,AUTOSELECT=YES,URI=\"/tsh/").append(s.id).append("/a.m3u8\"\n");
                inf.add("AUDIO=\"a\"");
            }
        }
        m.append("#EXT-X-STREAM-INF:").append(String.join(",", inf)).append('\n');
        m.append("/tsh/").append(s.id).append("/v.m3u8\n");
        s.master = m.toString();
    }

    /** player closed / another kind of stream: nothing may keep using the subscription */
    synchronized void stopAll() {
        for (Session s : sessions.values()) s.stop();
        sessions.clear();
    }

    // ───────────────────────── serving ─────────────────────────

    interface Writer {
        void head(int code, String msg, Map<String, String> h, long len) throws IOException;
    }

    void handle(OutputStream out, String path, Map<String, String> q, Writer w) throws IOException {
        String[] parts = path.substring(1).split("/"); // tsh, ...
        Map<String, String> h = new HashMap<>();
        h.put("Cache-Control", "no-store");
        if (parts.length >= 2 && "stop".equals(parts[1])) {
            stopAll();
            w.head(204, "No Content", h, 0);
            return;
        }
        if (parts.length >= 2 && "start".equals(parts[1])) {
            String u = q.get("u");
            double max = 1800;
            try {
                max = Math.min(4 * 3600, Math.max(60, Double.parseDouble(q.get("max"))));
            } catch (Exception ignored) {
            }
            try {
                Session s = start(u, max);
                // first segment of every track (outside the lock: other requests keep flowing)
                for (Track t : s.tracks.values()) {
                    if (!t.awaitReady(15000)) {
                        synchronized (this) {
                            s.stop();
                            sessions.remove(s.id);
                        }
                        throw new IOException("timeout");
                    }
                }
                byte[] b = s.master.getBytes(StandardCharsets.UTF_8);
                h.put("Content-Type", "application/vnd.apple.mpegurl");
                w.head(200, "OK", h, b.length);
                out.write(b);
            } catch (Exception e) {
                // not HLS / unreachable: play the stream itself
                Log.d(TAG, "start failed: " + e.getMessage());
                h.put("Location", u == null ? "/" : u);
                w.head(302, "Found", h, 0);
            }
            return;
        }
        Session s = parts.length >= 3 ? sessions.get(parts[1]) : null;
        if (s == null) {
            w.head(404, "Not Found", h, 0);
            return;
        }
        s.last = System.currentTimeMillis();
        File file = null;
        if ("key".equals(parts[2]) && parts.length >= 4) {
            try {
                file = s.keyFile(Integer.parseInt(parts[3]));
            } catch (NumberFormatException ignored) {
            }
        } else if (parts[2].endsWith(".m3u8")) {
            Track t = s.tracks.get(parts[2].replace(".m3u8", ""));
            if (t != null) {
                byte[] b = t.playlist().getBytes(StandardCharsets.UTF_8);
                h.put("Content-Type", "application/vnd.apple.mpegurl");
                w.head(200, "OK", h, b.length);
                out.write(b);
                return;
            }
        } else if (parts.length >= 4) {
            Track t = s.tracks.get(parts[2]);
            if (t != null) file = t.segment(parts[3]);
        }
        if (file == null || !file.exists()) {
            w.head(404, "Not Found", h, 0);
            return;
        }
        w.head(200, "OK", h, file.length());
        try (InputStream in = new FileInputStream(file)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        }
    }

    private static void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteRecursive(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
