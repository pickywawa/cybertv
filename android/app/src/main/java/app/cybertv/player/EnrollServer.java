package app.cybertv.player;

import android.content.Context;
import android.util.Log;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Collections;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * QR-code enrolment: a tiny HTTP server on the TV's local network address.
 *
 *   GET  /e/<token>       the phone form (assets/public/enroll.html)
 *   GET  /e/<token>/ping  {"ok":true} (the phone app checks it reached the right TV)
 *   POST /e/<token>       JSON settings from the phone (form or CyberIPTV app)
 *
 * One random token per session, nothing served without it, 256 KB max body,
 * stops by itself after 15 minutes or once settings were received.
 */
final class EnrollServer {
    interface Listener {
        void onPayload(String json);
    }

    private static final String TAG = "CyberEnroll";
    private static final long LIFETIME_MS = 15 * 60 * 1000;
    private static final int MAX_BODY = 256 * 1024;

    private final Context ctx;
    private final Listener listener;
    private final ExecutorService pool = Executors.newFixedThreadPool(4);
    private ServerSocket server;
    private String token;
    private String url;
    private volatile String payload;
    private long startedAt;

    EnrollServer(Context ctx, Listener listener) {
        this.ctx = ctx.getApplicationContext();
        this.listener = listener;
    }

    synchronized String start() throws IOException {
        stop();
        String ip = lanAddress();
        if (ip == null) throw new IOException("no local network");
        server = new ServerSocket(0, 16, InetAddress.getByName("0.0.0.0"));
        token = randomToken();
        payload = null;
        startedAt = System.currentTimeMillis();
        url = "http://" + ip + ":" + server.getLocalPort() + "/e/" + token;
        final ServerSocket s = server;
        Thread t = new Thread(() -> {
            while (!s.isClosed()) {
                try {
                    Socket c = s.accept();
                    if (System.currentTimeMillis() - startedAt > LIFETIME_MS) {
                        c.close();
                        stop();
                        break;
                    }
                    pool.execute(() -> handle(c));
                } catch (IOException e) {
                    if (!s.isClosed()) Log.w(TAG, "accept failed", e);
                }
            }
        }, "cyber-enroll");
        t.setDaemon(true);
        t.start();
        return url;
    }

    synchronized void stop() {
        if (server != null) {
            try {
                server.close();
            } catch (IOException ignored) {
            }
        }
        server = null;
    }

    String url() {
        return server != null ? url : null;
    }

    /** last settings received (cleared once read) */
    String takePayload() {
        String p = payload;
        payload = null;
        return p;
    }

    // ───────────────────────── HTTP ─────────────────────────

    private void handle(Socket sock) {
        try (Socket s = sock) {
            s.setSoTimeout(15000);
            InputStream in = new BufferedInputStream(s.getInputStream());
            OutputStream out = s.getOutputStream();
            String line = readLine(in);
            if (line == null) return;
            String[] parts = line.split(" ");
            if (parts.length < 2) return;
            String method = parts[0];
            String path = parts[1].split("\\?")[0];
            int length = 0;
            String h;
            while ((h = readLine(in)) != null && !h.isEmpty()) {
                int i = h.indexOf(':');
                if (i > 0 && h.substring(0, i).trim().equalsIgnoreCase("content-length")) {
                    try {
                        length = Integer.parseInt(h.substring(i + 1).trim());
                    } catch (NumberFormatException ignored) {
                    }
                }
            }
            if ("OPTIONS".equals(method)) {
                respond(out, 204, "text/plain", new byte[0]);
                return;
            }
            String base = "/e/" + token;
            if (path.equals(base) && "GET".equals(method)) {
                respond(out, 200, "text/html; charset=utf-8", readAsset("public/enroll.html"));
            } else if (path.equals(base + "/ping") && "GET".equals(method)) {
                respond(out, 200, "application/json", "{\"ok\":true,\"app\":\"CyberIPTV\"}".getBytes(StandardCharsets.UTF_8));
            } else if (path.equals(base) && "POST".equals(method)) {
                if (length <= 0 || length > MAX_BODY) {
                    respond(out, 413, "application/json", "{\"ok\":false}".getBytes(StandardCharsets.UTF_8));
                    return;
                }
                byte[] body = readN(in, length);
                String json = new String(body, StandardCharsets.UTF_8).trim();
                if (!json.startsWith("{")) {
                    respond(out, 400, "application/json", "{\"ok\":false}".getBytes(StandardCharsets.UTF_8));
                    return;
                }
                payload = json;
                respond(out, 200, "application/json", "{\"ok\":true}".getBytes(StandardCharsets.UTF_8));
                listener.onPayload(json);
            } else {
                respond(out, 404, "text/plain", "not found".getBytes(StandardCharsets.UTF_8));
            }
        } catch (Exception e) {
            Log.d(TAG, "request failed: " + e.getMessage());
        }
    }

    private byte[] readAsset(String name) throws IOException {
        try (InputStream is = ctx.getAssets().open(name)) {
            ByteArrayOutputStream bo = new ByteArrayOutputStream();
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = is.read(buf)) > 0) bo.write(buf, 0, n);
            return bo.toByteArray();
        }
    }

    private static void respond(OutputStream out, int code, String type, byte[] body) throws IOException {
        String head = "HTTP/1.1 " + code + " " + (code < 300 ? "OK" : "Error") + "\r\n"
                + "Content-Type: " + type + "\r\n"
                + "Content-Length: " + body.length + "\r\n"
                + "Cache-Control: no-store\r\n"
                // the CyberIPTV app on the phone posts from its own WebView origin
                + "Access-Control-Allow-Origin: *\r\n"
                + "Access-Control-Allow-Headers: content-type\r\n"
                + "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
                + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.UTF_8));
        out.write(body);
        out.flush();
    }

    private static String readLine(InputStream in) throws IOException {
        StringBuilder sb = new StringBuilder();
        int c;
        while ((c = in.read()) != -1) {
            if (c == '\n') break;
            if (c != '\r') sb.append((char) c);
            if (sb.length() > 8192) throw new IOException("line too long");
        }
        return c == -1 && sb.length() == 0 ? null : sb.toString();
    }

    private static byte[] readN(InputStream in, int n) throws IOException {
        byte[] buf = new byte[n];
        int off = 0;
        while (off < n) {
            int r = in.read(buf, off, n - off);
            if (r < 0) break;
            off += r;
        }
        return buf;
    }

    private static String randomToken() {
        byte[] b = new byte[18];
        new SecureRandom().nextBytes(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format(Locale.ROOT, "%02x", x));
        return sb.toString();
    }

    /** IPv4 address of the Wi-Fi / Ethernet interface */
    static String lanAddress() {
        try {
            String fallback = null;
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback() || ni.isVirtual()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (!(a instanceof Inet4Address) || a.isLoopbackAddress() || !a.isSiteLocalAddress()) continue;
                    String name = ni.getName().toLowerCase(Locale.ROOT);
                    if (name.startsWith("wlan") || name.startsWith("eth")) return a.getHostAddress();
                    if (fallback == null) fallback = a.getHostAddress();
                }
            }
            return fallback;
        } catch (Exception e) {
            return null;
        }
    }
}
