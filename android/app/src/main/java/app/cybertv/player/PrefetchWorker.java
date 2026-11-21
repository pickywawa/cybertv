package app.cybertv.player;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

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
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

/**
 * Background pre-download while the app is closed (WorkManager).
 *
 * The app hands over a "plan": the raw URLs its sync reads (M3U playlists, Xtream API answers,
 * XMLTV guides). This worker only downloads them into cache/prefetch/; at the next launch the JS
 * sync reads these local copies through LocalProxy's /cached endpoint instead of the network, so
 * only parsing remains. The plan holds Xtream credentials, so it is stored encrypted (SecureStore).
 *
 * Android picks the moment (Wi-Fi only by default, battery/storage not low) and keeps the schedule
 * across reboots.
 */
public class PrefetchWorker extends Worker {
    static final String TAG = "CyberPrefetch";
    static final String UNIQUE = "cyber-prefetch";
    static final String PLAN_KEY = "prefetch.plan";
    static final String PREFS = "cyber_prefetch";
    private static final String UA = "VLC/3.0.20 LibVLC/3.0.20";
    private static final long MAX_BYTES = 512L * 1024 * 1024;

    public PrefetchWorker(@NonNull Context ctx, @NonNull WorkerParameters params) {
        super(ctx, params);
    }

    static File dir(Context c) {
        File d = new File(c.getCacheDir(), "prefetch");
        //noinspection ResultOfMethodCallIgnored
        d.mkdirs();
        return d;
    }

    static String key(String url) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-1");
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest(url.getBytes(StandardCharsets.UTF_8))) sb.append(String.format(Locale.ROOT, "%02x", b));
            return sb.toString();
        } catch (Exception e) {
            return Integer.toHexString(url.hashCode());
        }
    }

    // ───────────────────────── scheduling ─────────────────────────

    static void schedule(Context c, String planJson, int intervalH, boolean wifiOnly) throws Exception {
        new SecureStore(c).set(PLAN_KEY, planJson);
        Constraints cons = new Constraints.Builder()
                .setRequiredNetworkType(wifiOnly ? NetworkType.UNMETERED : NetworkType.CONNECTED)
                .setRequiresBatteryNotLow(true)
                .setRequiresStorageNotLow(true)
                .build();
        long hours = Math.max(1, intervalH);
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(PrefetchWorker.class, hours, TimeUnit.HOURS, 1, TimeUnit.HOURS)
                .setConstraints(cons)
                .build();
        WorkManager.getInstance(c).enqueueUniquePeriodicWork(UNIQUE, ExistingPeriodicWorkPolicy.UPDATE, req);
    }

    /**
     * One run now ("Précharger maintenant"): asked for by the user, so no network constraint to
     * wait on (Android's "validated Internet" check can lag); a failure simply retries later.
     */
    static void runNow(Context c, boolean wifiOnly) {
        OneTimeWorkRequest req = new OneTimeWorkRequest.Builder(PrefetchWorker.class).build();
        WorkManager.getInstance(c).enqueueUniqueWork(UNIQUE + "-now", ExistingWorkPolicy.REPLACE, req);
    }

    static void cancel(Context c) {
        WorkManager.getInstance(c).cancelUniqueWork(UNIQUE);
        new SecureStore(c).remove(PLAN_KEY);
        File[] files = dir(c).listFiles();
        if (files != null) for (File f : files) //noinspection ResultOfMethodCallIgnored
            f.delete();
        c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply();
    }

    static JSONObject status(Context c) throws Exception {
        SharedPreferences p = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSONObject o = new JSONObject();
        o.put("lastRunAt", p.getLong("lastRunAt", 0));
        o.put("lastOkAt", p.getLong("lastOkAt", 0));
        o.put("files", p.getInt("files", 0));
        o.put("bytes", p.getLong("bytes", 0));
        o.put("errors", p.getInt("errors", 0));
        o.put("scheduled", new SecureStore(c).get(PLAN_KEY) != null);
        return o;
    }

    // ───────────────────────── work ─────────────────────────

    @NonNull
    @Override
    public Result doWork() {
        Context c = getApplicationContext();
        String plan = new SecureStore(c).get(PLAN_KEY);
        if (plan == null) return Result.success();
        int ok = 0;
        int errors = 0;
        long bytes = 0;
        try {
            JSONArray items = new JSONObject(plan).getJSONArray("items");
            for (int i = 0; i < items.length() && !isStopped(); i++) {
                String url = items.getJSONObject(i).getString("url");
                try {
                    bytes += fetch(c, url);
                    ok++;
                } catch (Exception e) {
                    errors++;
                    Log.w(TAG, "prefetch failed: " + e.getMessage());
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "bad plan", e);
            return Result.failure();
        }
        long now = System.currentTimeMillis();
        SharedPreferences.Editor ed = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putLong("lastRunAt", now).putInt("files", ok).putLong("bytes", bytes).putInt("errors", errors);
        if (ok > 0) ed.putLong("lastOkAt", now);
        ed.apply();
        // nothing reachable at all: let WorkManager retry with backoff
        return ok == 0 && errors > 0 ? Result.retry() : Result.success();
    }

    /** conditional download (ETag / Last-Modified) into prefetch/<sha1>, metadata in <sha1>.json */
    private static long fetch(Context c, String url) throws Exception {
        File d = dir(c);
        String k = key(url);
        File body = new File(d, k);
        File meta = new File(d, k + ".json");
        JSONObject old = meta.exists() ? new JSONObject(readText(meta)) : null;

        String cur = url;
        HttpURLConnection conn = null;
        for (int i = 0; i < 6; i++) {
            conn = (HttpURLConnection) new URL(cur).openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(90000);
            conn.setRequestProperty("User-Agent", UA);
            if (old != null && body.exists()) {
                if (old.has("etag")) conn.setRequestProperty("If-None-Match", old.getString("etag"));
                if (old.has("lastModified")) conn.setRequestProperty("If-Modified-Since", old.getString("lastModified"));
            }
            int code = conn.getResponseCode();
            if (code >= 300 && code < 400 && code != 304 && conn.getHeaderField("Location") != null) {
                cur = URI.create(cur).resolve(conn.getHeaderField("Location")).toString();
                conn.disconnect();
                conn = null;
                continue;
            }
            break;
        }
        if (conn == null) throw new IOException("too many redirects");
        int code = conn.getResponseCode();
        if (code == 304 && old != null) {
            conn.disconnect();
            old.put("fetchedAt", System.currentTimeMillis());
            writeText(meta, old.toString());
            return 0;
        }
        if (code >= 400) {
            conn.disconnect();
            throw new IOException("HTTP " + code);
        }
        File tmp = new File(d, k + ".part");
        long n = 0;
        try (InputStream is = conn.getInputStream(); OutputStream os = new FileOutputStream(tmp)) {
            byte[] buf = new byte[64 * 1024];
            int r;
            while ((r = is.read(buf)) > 0) {
                n += r;
                if (n > MAX_BYTES) throw new IOException("too large");
                os.write(buf, 0, r);
            }
        } finally {
            conn.disconnect();
        }
        if (n == 0) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            throw new IOException("empty body");
        }
        if (!tmp.renameTo(body)) throw new IOException("rename failed");
        JSONObject m = new JSONObject();
        m.put("url", url);
        m.put("fetchedAt", System.currentTimeMillis());
        m.put("size", n);
        String ct = conn.getContentType();
        if (ct != null) m.put("contentType", ct);
        String etag = conn.getHeaderField("ETag");
        if (etag != null) m.put("etag", etag);
        String lm = conn.getHeaderField("Last-Modified");
        if (lm != null) m.put("lastModified", lm);
        writeText(meta, m.toString());
        return n;
    }

    static String readText(File f) throws IOException {
        try (InputStream is = new FileInputStream(f)) {
            byte[] all = new byte[(int) f.length()];
            int off = 0;
            while (off < all.length) {
                int r = is.read(all, off, all.length - off);
                if (r < 0) break;
                off += r;
            }
            return new String(all, 0, off, StandardCharsets.UTF_8);
        }
    }

    private static void writeText(File f, String s) throws IOException {
        try (OutputStream os = new FileOutputStream(f)) {
            os.write(s.getBytes(StandardCharsets.UTF_8));
        }
    }
}
