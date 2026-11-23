package app.cybertv.player;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Build;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyPair;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * "Install on a TV" from the phone: finds the TVs of the Wi-Fi network (Google Cast / Android TV
 * announcements for their names, port 5555 for network debugging), downloads the APK and installs
 * it through ADB (AdbClient). The TV only has network debugging on and accepts the phone once.
 */
final class TvInstaller {
    private static final String TAG = "CyberTvInstall";
    private static final String PREFS = "cyber_tv_install";

    interface Progress {
        void step(String step, int pct, String detail);
    }

    static final class Tv {
        String ip;
        String name;
        /** classic network debugging (port 5555) */
        boolean adb;
        /** wireless debugging (Android 11+): TLS port, and the pairing port while its code is shown */
        int tlsPort;
        int pairPort;
    }

    /** IP → port of an adb mDNS service (wireless debugging) */
    private static final String TLS_CONNECT = "_adb-tls-connect._tcp", TLS_PAIRING = "_adb-tls-pairing._tcp";

    private TvInstaller() {}

    // ───────────────────────── discovery ─────────────────────────

    static List<Tv> scan(Context c) {
        String own = ownIp();
        Map<String, Integer> tls = new ConcurrentHashMap<>();
        Map<String, Integer> pairing = new ConcurrentHashMap<>();
        Map<String, String> names = discover(c, 2500, tls, pairing);
        Map<String, Tv> out = new LinkedHashMap<>();
        if (own != null) {
            String prefix = own.substring(0, own.lastIndexOf('.') + 1);
            ExecutorService pool = Executors.newFixedThreadPool(48);
            Map<String, Boolean> open = new ConcurrentHashMap<>();
            for (int i = 1; i < 255; i++) {
                String ip = prefix + i;
                if (ip.equals(own)) continue;
                pool.execute(() -> {
                    try (Socket s = new Socket()) {
                        s.connect(new InetSocketAddress(ip, 5555), 450);
                        open.put(ip, true);
                    } catch (IOException ignored) {
                    }
                });
            }
            pool.shutdown();
            try {
                pool.awaitTermination(8, TimeUnit.SECONDS);
            } catch (InterruptedException ignored) {
            }
            List<String> ips = new ArrayList<>(open.keySet());
            Collections.sort(ips);
            for (String ip : ips) {
                Tv t = new Tv();
                t.ip = ip;
                t.adb = true;
                t.name = names.get(ip);
                out.put(ip, t);
            }
        }
        // wireless debugging (no port 5555): reachable on their announced TLS port
        for (Map.Entry<String, Integer> e : tls.entrySet()) {
            if (e.getKey().equals(own)) continue;
            Tv t = out.get(e.getKey());
            if (t == null) {
                t = new Tv();
                t.ip = e.getKey();
                t.name = names.get(e.getKey());
                out.put(e.getKey(), t);
            }
            t.tlsPort = e.getValue();
        }
        for (Map.Entry<String, Integer> e : pairing.entrySet()) {
            Tv t = out.get(e.getKey());
            if (t != null) t.pairPort = e.getValue();
        }
        // TVs announced on the network but not reachable for debugging yet (shown with a hint)
        for (Map.Entry<String, String> e : names.entrySet()) {
            if (out.containsKey(e.getKey()) || e.getKey().equals(own)) continue;
            Tv t = new Tv();
            t.ip = e.getKey();
            t.name = e.getValue();
            t.adb = false;
            out.put(e.getKey(), t);
        }
        return new ArrayList<>(out.values());
    }

    /** this phone's Wi-Fi / Ethernet IPv4 */
    static String ownIp() {
        try {
            Enumeration<NetworkInterface> ifs = NetworkInterface.getNetworkInterfaces();
            String fallback = null;
            while (ifs != null && ifs.hasMoreElements()) {
                NetworkInterface n = ifs.nextElement();
                if (!n.isUp() || n.isLoopback()) continue;
                for (Enumeration<InetAddress> a = n.getInetAddresses(); a.hasMoreElements(); ) {
                    InetAddress x = a.nextElement();
                    if (!(x instanceof Inet4Address) || !x.isSiteLocalAddress()) continue;
                    if (n.getName().startsWith("wlan") || n.getName().startsWith("eth")) return x.getHostAddress();
                    if (fallback == null) fallback = x.getHostAddress();
                }
            }
            return fallback;
        } catch (Exception e) {
            return null;
        }
    }

    /** the pairing port announced by a TV while it shows its code ("Pair device with pairing code") */
    static int pairingPort(Context c, String ip) {
        Map<String, Integer> pairing = new ConcurrentHashMap<>();
        discover(c, 3000, new ConcurrentHashMap<>(), pairing);
        Integer p = pairing.get(ip);
        return p == null ? 0 : p;
    }

    /**
     * IP → friendly name, from the Google Cast ("Salon TV") and Android TV Remote announcements,
     * plus the wireless debugging ports (connect / pairing) announced by adb.
     */
    @SuppressWarnings("deprecation")
    private static Map<String, String> discover(Context c, long ms, Map<String, Integer> tls, Map<String, Integer> pairing) {
        Map<String, String> names = new ConcurrentHashMap<>();
        NsdManager nsd = (NsdManager) c.getSystemService(Context.NSD_SERVICE);
        if (nsd == null) return names;
        List<NsdManager.DiscoveryListener> listeners = new ArrayList<>();
        for (String type : new String[]{"_googlecast._tcp", "_androidtvremote2._tcp", TLS_CONNECT, TLS_PAIRING}) {
            NsdManager.DiscoveryListener l = new NsdManager.DiscoveryListener() {
                @Override
                public void onServiceFound(NsdServiceInfo info) {
                    try {
                        nsd.resolveService(info, new NsdManager.ResolveListener() {
                            @Override
                            public void onResolveFailed(NsdServiceInfo i, int err) {
                            }

                            @Override
                            public void onServiceResolved(NsdServiceInfo i) {
                                InetAddress h = i.getHost();
                                if (!(h instanceof Inet4Address)) return;
                                String st = i.getServiceType() == null ? "" : i.getServiceType();
                                if (st.contains("adb-tls-connect")) {
                                    tls.put(h.getHostAddress(), i.getPort());
                                    return;
                                }
                                if (st.contains("adb-tls-pairing")) {
                                    pairing.put(h.getHostAddress(), i.getPort());
                                    return;
                                }
                                String name = i.getServiceName();
                                byte[] fn = i.getAttributes() != null ? i.getAttributes().get("fn") : null;
                                if (fn != null) name = new String(fn, StandardCharsets.UTF_8);
                                names.putIfAbsent(h.getHostAddress(), name);
                            }
                        });
                    } catch (Exception ignored) {
                        // one resolution at a time on old Android versions
                    }
                }

                @Override
                public void onServiceLost(NsdServiceInfo info) {
                }

                @Override
                public void onDiscoveryStarted(String t) {
                }

                @Override
                public void onDiscoveryStopped(String t) {
                }

                @Override
                public void onStartDiscoveryFailed(String t, int e) {
                }

                @Override
                public void onStopDiscoveryFailed(String t, int e) {
                }
            };
            try {
                nsd.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, l);
                listeners.add(l);
            } catch (Exception e) {
                Log.d(TAG, "nsd " + type + ": " + e.getMessage());
            }
        }
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ignored) {
        }
        for (NsdManager.DiscoveryListener l : listeners) {
            try {
                nsd.stopServiceDiscovery(l);
            } catch (Exception ignored) {
            }
        }
        return names;
    }

    // ───────────────────────── install ─────────────────────────

    /** downloads the APK, connects to the TV (it may ask for approval) and installs; returns the TV model */
    static String install(Context c, String ip, int port, String url, String launchUri, Progress p) throws Exception {
        File apk = new File(c.getCacheDir(), "tv-install.apk");
        p.step("download", 0, null);
        download(url, apk, p);
        p.step("connect", 0, null);
        KeyPair key = key(c);
        String me = "cyberiptv@" + (Build.MODEL == null ? "phone" : Build.MODEL.replace(' ', '_'));
        try (AdbClient adb = AdbClient.connect(ip, port, key, me, 90000, new AdbClient.Listener() {
            @Override
            public void waitingForApproval() {
                p.step("approve", 0, null);
            }

            @Override
            public void uploaded(long sent, long total) {
                p.step("upload", (int) (sent * 100 / Math.max(1, total)), null);
            }
        })) {
            String model = adb.model();
            p.step("upload", 0, model);
            String res = adb.install(apk, new AdbClient.Listener() {
                @Override
                public void waitingForApproval() {
                }

                int last = -1;

                @Override
                public void uploaded(long sent, long total) {
                    int pct = (int) (sent * 100 / Math.max(1, total));
                    if (pct != last) {
                        last = pct;
                        p.step(pct >= 100 ? "install" : "upload", pct, model);
                    }
                }
            });
            if (!res.contains("Success")) throw new IOException(res.isEmpty() ? "install failed" : res);
            // start the app on the TV, with this phone's profile and sources when asked for
            p.step("launch", 0, model);
            String start = "am start -n app.cybertv.player/.MainActivity";
            if (launchUri != null && launchUri.matches("cyberiptv://import/[A-Za-z0-9_-]+")) start += " -a android.intent.action.VIEW -d " + launchUri;
            String out = adb.exec(start);
            if (out.contains("Error")) Log.w(TAG, "launch: " + out);
            return model;
        } finally {
            //noinspection ResultOfMethodCallIgnored
            apk.delete();
        }
    }

    /** pairing with the 6-digit code shown by the TV (wireless debugging, Android 12+ phone) */
    static void pair(Context c, String ip, int port, String code) throws Exception {
        if (Build.VERSION.SDK_INT < 31) throw new IOException("pairing unsupported");
        String me = "cyberiptv@" + (Build.MODEL == null ? "phone" : Build.MODEL.replace(' ', '_'));
        AdbPairing.pair(ip, port, code, key(c), me, (s, label, len) -> android.net.ssl.SSLSockets.exportKeyingMaterial(s, label, null, len));
    }

    /** this phone's ADB key, created once (the TV remembers it when "Always allow" is ticked) */
    private static KeyPair key(Context c) throws Exception {
        SharedPreferences sp = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String k = sp.getString("key", null);
        if (k != null) {
            try {
                return AdbClient.decode(k);
            } catch (Exception ignored) {
            }
        }
        KeyPair kp = AdbClient.newKey();
        sp.edit().putString("key", AdbClient.encode(kp)).apply();
        return kp;
    }

    private static void download(String url, File dest, Progress p) throws IOException {
        String cur = url;
        HttpURLConnection conn = null;
        for (int i = 0; i < 8; i++) {
            conn = (HttpURLConnection) new URL(cur).openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(60000);
            conn.setRequestProperty("User-Agent", "CyberIPTV-tv-install");
            int code = conn.getResponseCode();
            if (code >= 300 && code < 400 && conn.getHeaderField("Location") != null) {
                cur = URI.create(cur).resolve(conn.getHeaderField("Location")).toString();
                conn.disconnect();
                conn = null;
                continue;
            }
            if (code >= 400) throw new IOException("HTTP " + code);
            break;
        }
        if (conn == null) throw new IOException("too many redirects");
        long total = conn.getContentLengthLong();
        long got = 0;
        int last = -1;
        try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(dest)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                got += n;
                int pct = total > 0 ? (int) (got * 100 / total) : 0;
                if (pct != last) {
                    last = pct;
                    p.step("download", pct, null);
                }
            }
        } finally {
            conn.disconnect();
        }
    }
}
