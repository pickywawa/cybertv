package app.cybertv.player;

import android.util.Log;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URI;
import java.net.URL;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Tiny localhost HTTP server used by the WebView:
 *  - GET /proxy?u=<url>  CORS proxy for provider APIs / playlists / EPG (streams the body, forwards Range,
 *                        rewrites HLS playlists so segments also go through the proxy)
 *  - GET /img?u=<url>    image proxy with an LRU disk cache (provider logos rarely send cache headers)
 * Mirrors dev-server/proxy.ts used in the browser.
 */
public class LocalProxy {
    private static final String TAG = "CyberProxy";
    private static final String UA = "VLC/3.0.20 LibVLC/3.0.20";
    private static final long IMG_CACHE_MAX = 400L * 1024 * 1024;
    private static final int FIXED_PORT = 38517;
    private static final String WIKI_UA = "CyberIPTV/1.0 (https://github.com/pickywawa/cybertv; IPTV player channel logos)";
    /** broken logos are remembered so they never hold one of the WebView's 6 connections again */
    private static final long IMG_ERROR_TTL = 12L * 3600 * 1000;

    private final File imgDir;
    private final ExecutorService pool = Executors.newCachedThreadPool();
    private final AtomicInteger writes = new AtomicInteger();
    private ServerSocket server;
    private int port;

    private final File prefetchDir;

    public LocalProxy(File cacheDir) {
        this.prefetchDir = new File(cacheDir, "prefetch");
        this.imgDir = new File(cacheDir, "img");
        //noinspection ResultOfMethodCallIgnored
        imgDir.mkdirs();
    }

    public synchronized int start() throws IOException {
        if (server != null) return port;
        // stable port across launches so the WebView HTTP cache keeps hitting the same /img urls
        for (int p = FIXED_PORT; p < FIXED_PORT + 4 && server == null; p++) {
            try {
                server = new ServerSocket(p, 64, InetAddress.getByName("127.0.0.1"));
            } catch (IOException ignored) {
            }
        }
        if (server == null) server = new ServerSocket(0, 64, InetAddress.getByName("127.0.0.1"));
        port = server.getLocalPort();
        Thread t = new Thread(() -> {
            while (!server.isClosed()) {
                try {
                    Socket s = server.accept();
                    pool.execute(() -> handle(s));
                } catch (IOException e) {
                    if (!server.isClosed()) Log.w(TAG, "accept failed", e);
                }
            }
        }, "cyber-proxy");
        t.setDaemon(true);
        t.start();
        return port;
    }

    public int getPort() {
        return port;
    }

    public void clearImageCache() {
        File[] files = imgDir.listFiles();
        if (files != null) for (File f : files) //noinspection ResultOfMethodCallIgnored
            f.delete();
    }

    // ───────────────────────── request handling ─────────────────────────

    private void handle(Socket sock) {
        try (Socket s = sock) {
            s.setSoTimeout(30000);
            InputStream in = new BufferedInputStream(s.getInputStream());
            OutputStream out = s.getOutputStream();
            String requestLine = readLine(in);
            if (requestLine == null) return;
            Map<String, String> headers = new HashMap<>();
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int i = line.indexOf(':');
                if (i > 0) headers.put(line.substring(0, i).trim().toLowerCase(Locale.ROOT), line.substring(i + 1).trim());
            }
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) return;
            String method = parts[0];
            String target = parts[1];
            if ("OPTIONS".equals(method)) {
                writeHead(out, 204, "No Content", new HashMap<>(), -1);
                return;
            }
            String path = target.contains("?") ? target.substring(0, target.indexOf('?')) : target;
            Map<String, String> q = parseQuery(target.contains("?") ? target.substring(target.indexOf('?') + 1) : "");
            String u = q.get("u");
            if (u == null || !(u.startsWith("http://") || u.startsWith("https://"))) {
                writeText(out, 400, "Bad Request", "missing u");
                return;
            }
            if ("/cached".equals(path)) serveCached(out, u, q.get("since"));
            else if ("/img".equals(path)) serveImage(out, u);
            else if ("/proxy".equals(path)) proxy(out, u, headers.get("range"), q.get("ua"), "HEAD".equals(method));
            else writeText(out, 404, "Not Found", "not found");
        } catch (Exception e) {
            Log.d(TAG, "request failed: " + e.getMessage());
        }
    }

    private HttpURLConnection open(String url, String range, String ua) throws IOException {
        String cur = url;
        for (int i = 0; i < 6; i++) {
            HttpURLConnection c = (HttpURLConnection) new URL(cur).openConnection();
            c.setInstanceFollowRedirects(false); // we follow manually (also http <-> https)
            c.setConnectTimeout(15000);
            c.setReadTimeout(30000);
            c.setRequestProperty("User-Agent", ua != null ? ua : UA);
            c.setRequestProperty("Accept", "*/*");
            if (range != null) c.setRequestProperty("Range", range);
            int code = c.getResponseCode();
            if (code >= 300 && code < 400 && c.getHeaderField("Location") != null) {
                cur = URI.create(cur).resolve(c.getHeaderField("Location")).toString();
                c.disconnect();
                continue;
            }
            return c;
        }
        throw new IOException("too many redirects");
    }

    private void proxy(OutputStream out, String url, String range, String ua, boolean head) throws IOException {
        HttpURLConnection c = open(url, range, ua);
        int code = c.getResponseCode();
        String ct = c.getContentType();
        String finalUrl = c.getURL().toString();
        Map<String, String> h = new HashMap<>();
        for (String k : new String[]{"Content-Type", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"}) {
            String v = c.getHeaderField(k);
            if (v != null) h.put(k, v);
        }
        InputStream body = code >= 400 ? c.getErrorStream() : c.getInputStream();
        try {
            if (isM3u8(finalUrl, ct) && code < 400) {
                String text = new String(readAll(body), StandardCharsets.UTF_8);
                byte[] rewritten = rewriteM3u8(text, finalUrl).getBytes(StandardCharsets.UTF_8);
                h.put("Content-Type", "application/vnd.apple.mpegurl");
                writeHead(out, code, "OK", h, rewritten.length);
                if (!head) out.write(rewritten);
                return;
            }
            long len = c.getContentLengthLong();
            writeHead(out, code, code >= 400 ? "Error" : "OK", h, len);
            if (head || body == null) return;
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = body.read(buf)) > 0) out.write(buf, 0, n);
            out.flush();
        } finally {
            if (body != null) body.close();
            c.disconnect();
        }
    }

    /**
     * Copy pre-downloaded by PrefetchWorker, if newer than `since` (ms): 200 + X-Fetched-At, else 404
     * (the caller then uses the network as usual).
     */
    private void serveCached(OutputStream out, String url, String since) throws IOException {
        String k = PrefetchWorker.key(url);
        File body = new File(prefetchDir, k);
        File meta = new File(prefetchDir, k + ".json");
        if (!body.exists() || !meta.exists()) {
            writeText(out, 404, "Not Found", "not prefetched");
            return;
        }
        long fetchedAt;
        String ct = "application/octet-stream";
        try {
            org.json.JSONObject m = new org.json.JSONObject(PrefetchWorker.readText(meta));
            if (!url.equals(m.optString("url"))) {
                writeText(out, 404, "Not Found", "not prefetched");
                return;
            }
            fetchedAt = m.optLong("fetchedAt", 0);
            ct = m.optString("contentType", ct);
        } catch (Exception e) {
            writeText(out, 404, "Not Found", "bad meta");
            return;
        }
        long min = 0;
        try {
            if (since != null) min = Long.parseLong(since);
        } catch (NumberFormatException ignored) {
        }
        if (fetchedAt <= min) {
            writeText(out, 404, "Not Found", "stale");
            return;
        }
        Map<String, String> h = new HashMap<>();
        h.put("Content-Type", ct);
        h.put("Cache-Control", "no-store");
        h.put("X-Fetched-At", String.valueOf(fetchedAt));
        writeHead(out, 200, "OK", h, body.length());
        try (FileInputStream fis = new FileInputStream(body)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = fis.read(buf)) > 0) out.write(buf, 0, n);
        }
        out.flush();
    }

    private void serveImage(OutputStream out, String url) throws IOException {
        String key = sha1(url);
        File f = new File(imgDir, key);
        File ctf = new File(imgDir, key + ".ct");
        if (f.exists() && f.length() > 0) {
            //noinspection ResultOfMethodCallIgnored
            f.setLastModified(System.currentTimeMillis());
            String ct = ctf.exists() ? new String(readAll(new FileInputStream(ctf)), StandardCharsets.UTF_8) : "image/*";
            Map<String, String> h = new HashMap<>();
            h.put("Content-Type", ct);
            h.put("Cache-Control", "public, max-age=31536000, immutable");
            writeHead(out, 200, "OK", h, f.length());
            try (FileInputStream fis = new FileInputStream(f)) {
                byte[] buf = new byte[32 * 1024];
                int n;
                while ((n = fis.read(buf)) > 0) out.write(buf, 0, n);
            }
            return;
        }
        File errf = new File(imgDir, key + ".err");
        if (errf.exists() && System.currentTimeMillis() - errf.lastModified() < IMG_ERROR_TTL) {
            writeText(out, 404, "Not Found", "cached error");
            return;
        }
        HttpURLConnection c;
        byte[] data;
        try {
            // Wikimedia (iptv-org logos) throttles generic agents: identify the app as its policy asks
            c = open(url, null, url.contains("wikimedia.org") ? WIKI_UA : null);
            int code = c.getResponseCode();
            if (code >= 400) {
                c.disconnect();
                // only real "not found / forbidden" answers are remembered; 429 / 5xx are transient
                if (code < 500 && code != 429 && code != 408) markError(errf);
                writeText(out, code, "Error", "upstream " + code);
                return;
            }
            try (InputStream is = c.getInputStream()) {
                data = readAll(is);
            } finally {
                c.disconnect();
            }
            if (data.length == 0) throw new IOException("empty image");
        } catch (IOException e) {
            // timeouts / resets: remembered for 30 min only (a dead host must not hold connections)
            markError(errf);
            //noinspection ResultOfMethodCallIgnored
            errf.setLastModified(System.currentTimeMillis() - IMG_ERROR_TTL + 30 * 60 * 1000);
            writeText(out, 502, "Bad Gateway", "image unavailable");
            return;
        }
        String ct = c.getContentType() != null ? c.getContentType() : "image/*";
        Map<String, String> h = new HashMap<>();
        h.put("Content-Type", ct);
        h.put("Cache-Control", "public, max-age=31536000, immutable");
        writeHead(out, 200, "OK", h, data.length);
        out.write(data);
        out.flush();
        // persist after responding
        try {
            File tmp = new File(imgDir, key + ".tmp");
            try (FileOutputStream fos = new FileOutputStream(tmp)) {
                fos.write(data);
            }
            //noinspection ResultOfMethodCallIgnored
            tmp.renameTo(f);
            try (FileOutputStream fos = new FileOutputStream(ctf)) {
                fos.write(ct.getBytes(StandardCharsets.UTF_8));
            }
            if (writes.incrementAndGet() % 50 == 0) trimCache();
        } catch (IOException ignored) {
        }
    }

    private static void markError(File f) {
        try {
            //noinspection ResultOfMethodCallIgnored
            f.delete();
            //noinspection ResultOfMethodCallIgnored
            f.createNewFile();
        } catch (IOException ignored) {
        }
    }

    private void trimCache() {
        File[] files = imgDir.listFiles((d, n) -> !n.endsWith(".ct") && !n.endsWith(".tmp") && !n.endsWith(".err"));
        if (files == null) return;
        long total = 0;
        for (File f : files) total += f.length();
        if (total <= IMG_CACHE_MAX) return;
        Arrays.sort(files, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
        for (File f : files) {
            if (total <= IMG_CACHE_MAX * 0.8) break;
            total -= f.length();
            //noinspection ResultOfMethodCallIgnored
            f.delete();
            //noinspection ResultOfMethodCallIgnored
            new File(imgDir, f.getName() + ".ct").delete();
        }
    }

    // ───────────────────────── HLS rewrite (same as src/core/net/m3u8Rewrite.ts) ─────────────────────────

    static boolean isM3u8(String url, String ct) {
        if (ct != null && ct.toLowerCase(Locale.ROOT).contains("mpegurl")) return true;
        String p = url.split("\\?")[0].toLowerCase(Locale.ROOT);
        return p.endsWith(".m3u8");
    }

    private String proxify(String abs) {
        try {
            return "http://127.0.0.1:" + port + "/proxy?u=" + URLEncoder.encode(abs, "UTF-8");
        } catch (Exception e) {
            return abs;
        }
    }

    String rewriteM3u8(String body, String base) {
        URI b = URI.create(base);
        StringBuilder sb = new StringBuilder(body.length() + 1024);
        for (String raw : body.split("\r?\n")) {
            String t = raw.trim();
            if (t.isEmpty()) {
                sb.append(raw).append('\n');
                continue;
            }
            if (t.startsWith("#")) {
                int i = raw.indexOf("URI=\"");
                if (i >= 0) {
                    int s0 = i + 5;
                    int e = raw.indexOf('"', s0);
                    if (e > s0) {
                        String u = raw.substring(s0, e);
                        raw = raw.substring(0, s0) + proxify(resolve(b, u)) + raw.substring(e);
                    }
                }
                sb.append(raw).append('\n');
            } else {
                sb.append(proxify(resolve(b, t))).append('\n');
            }
        }
        return sb.toString();
    }

    private static String resolve(URI base, String u) {
        try {
            return base.resolve(u.replace(" ", "%20")).toString();
        } catch (Exception e) {
            return u;
        }
    }

    // ───────────────────────── helpers ─────────────────────────

    private static void writeHead(OutputStream out, int code, String msg, Map<String, String> h, long len) throws IOException {
        StringBuilder sb = new StringBuilder();
        sb.append("HTTP/1.1 ").append(code).append(' ').append(msg).append("\r\n");
        sb.append("Access-Control-Allow-Origin: *\r\n");
        sb.append("Access-Control-Allow-Headers: *\r\n");
        sb.append("Access-Control-Expose-Headers: *\r\n");
        sb.append("Connection: close\r\n");
        for (Map.Entry<String, String> e : h.entrySet()) sb.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
        if (len >= 0) sb.append("Content-Length: ").append(len).append("\r\n");
        sb.append("\r\n");
        out.write(sb.toString().getBytes(StandardCharsets.ISO_8859_1));
    }

    private static void writeText(OutputStream out, int code, String msg, String text) throws IOException {
        byte[] b = text.getBytes(StandardCharsets.UTF_8);
        Map<String, String> h = new HashMap<>();
        h.put("Content-Type", "text/plain; charset=utf-8");
        writeHead(out, code, msg, h, b.length);
        out.write(b);
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') b.write(c);
            if (b.size() > 16384) throw new IOException("line too long");
        }
        if (c == -1 && b.size() == 0) return null;
        return b.toString("ISO-8859-1");
    }

    private static Map<String, String> parseQuery(String q) {
        Map<String, String> m = new HashMap<>();
        for (String p : q.split("&")) {
            int i = p.indexOf('=');
            if (i <= 0) continue;
            try {
                m.put(URLDecoder.decode(p.substring(0, i), "UTF-8"), URLDecoder.decode(p.substring(i + 1), "UTF-8"));
            } catch (Exception ignored) {
            }
        }
        return m;
    }

    private static byte[] readAll(InputStream in) throws IOException {
        if (in == null) return new byte[0];
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        byte[] buf = new byte[32 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
        in.close();
        return b.toByteArray();
    }

    private static String sha1(String s) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-1");
            byte[] d = md.digest(s.getBytes(StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder();
            for (byte x : d) sb.append(String.format("%02x", x));
            return sb.toString();
        } catch (Exception e) {
            return Integer.toHexString(s.hashCode());
        }
    }
}
