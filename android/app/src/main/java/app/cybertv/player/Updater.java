package app.cybertv.player;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Log;

import androidx.core.content.FileProvider;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Self-update without a store:
 * - web content: a zip of `dist/` is downloaded, verified (SHA-256), unpacked in filesDir/web/<version>
 *   and registered as Capacitor's server base path (applied on next start, or right away on request).
 *   Capacitor drops it automatically when a newer APK is installed.
 * - native: the APK is downloaded to the cache and handed to the system installer
 *   (Android always asks the user to confirm; the first time it also asks to allow this source).
 * - safety: a new web bundle must call bootOk(); after 2 launches without it we go back to the built-in one.
 */
final class Updater {
    private static final String TAG = "CyberUpdater";
    /** Capacitor's own prefs (see com.getcapacitor.plugin.WebView) */
    private static final String CAP_PREFS = "CapWebViewSettings";
    private static final String CAP_SERVER_PATH = "serverBasePath";
    private static final String PREFS = "cyber_updater";

    private Updater() {}

    static SharedPreferences prefs(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static long versionCode(Context c) {
        try {
            PackageInfo p = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode;
        } catch (PackageManager.NameNotFoundException e) {
            return 0;
        }
    }

    static String versionName(Context c) {
        try {
            return c.getPackageManager().getPackageInfo(c.getPackageName(), 0).versionName;
        } catch (PackageManager.NameNotFoundException e) {
            return "";
        }
    }

    /** web bundle currently registered (null = the one inside the APK) */
    static String activeWebVersion(Context c) {
        String path = c.getSharedPreferences(CAP_PREFS, Context.MODE_PRIVATE).getString(CAP_SERVER_PATH, null);
        if (path == null || path.isEmpty() || !new File(path).exists()) return null;
        // bundles installed for an older APK are ignored by Capacitor
        if (prefs(c).getLong("webForCode", -1) != versionCode(c)) return null;
        return prefs(c).getString("webVersion", null);
    }

    /** called from the plugin's load(), before the WebView reads the server path */
    static void onLaunch(Context c) {
        SharedPreferences p = prefs(c);
        String pending = p.getString("pending", null);
        if (pending == null) return;
        int tries = p.getInt("pendingTries", 0) + 1;
        if (tries > 2) {
            Log.w(TAG, "web bundle " + pending + " never reported a successful boot, rolling back");
            rollback(c);
            return;
        }
        p.edit().putInt("pendingTries", tries).apply();
    }

    static void bootOk(Context c) {
        prefs(c).edit().remove("pending").remove("pendingTries").apply();
    }

    static void rollback(Context c) {
        c.getSharedPreferences(CAP_PREFS, Context.MODE_PRIVATE).edit().remove(CAP_SERVER_PATH).apply();
        prefs(c).edit().remove("pending").remove("pendingTries").remove("webVersion").remove("webForCode").apply();
    }

    // ───────────────────────── web bundle ─────────────────────────

    /** downloads + unpacks a web bundle; returns its directory (registered for the next launch) */
    static File installWebBundle(Context c, String url, String version, String sha256) throws Exception {
        File root = new File(c.getFilesDir(), "web");
        //noinspection ResultOfMethodCallIgnored
        root.mkdirs();
        File zip = new File(root, version + ".zip");
        download(url, zip);
        if (sha256 != null && !sha256.isEmpty()) {
            String got = sha256(zip);
            if (!got.equalsIgnoreCase(sha256)) {
                //noinspection ResultOfMethodCallIgnored
                zip.delete();
                throw new IOException("checksum mismatch");
            }
        }
        File dir = new File(root, version);
        deleteRecursive(dir);
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        String canonical = dir.getCanonicalPath() + File.separator;
        try (ZipInputStream zis = new ZipInputStream(new BufferedInputStream(new FileInputStream(zip)))) {
            ZipEntry e;
            byte[] buf = new byte[64 * 1024];
            while ((e = zis.getNextEntry()) != null) {
                File out = new File(dir, e.getName());
                // zip-slip guard
                if (!out.getCanonicalPath().startsWith(canonical)) throw new IOException("bad zip entry " + e.getName());
                if (e.isDirectory()) {
                    //noinspection ResultOfMethodCallIgnored
                    out.mkdirs();
                    continue;
                }
                //noinspection ResultOfMethodCallIgnored
                out.getParentFile().mkdirs();
                try (OutputStream os = new FileOutputStream(out)) {
                    int n;
                    while ((n = zis.read(buf)) > 0) os.write(buf, 0, n);
                }
            }
        }
        //noinspection ResultOfMethodCallIgnored
        zip.delete();
        if (!new File(dir, "index.html").exists()) {
            deleteRecursive(dir);
            throw new IOException("index.html missing in bundle");
        }
        // keep only this bundle and the active one
        String active = c.getSharedPreferences(CAP_PREFS, Context.MODE_PRIVATE).getString(CAP_SERVER_PATH, "");
        File[] old = root.listFiles();
        if (old != null) for (File f : old) {
            if (!f.equals(dir) && !f.getAbsolutePath().equals(active)) deleteRecursive(f);
        }
        c.getSharedPreferences(CAP_PREFS, Context.MODE_PRIVATE).edit().putString(CAP_SERVER_PATH, dir.getAbsolutePath()).apply();
        prefs(c).edit()
                .putString("webVersion", version)
                .putLong("webForCode", versionCode(c))
                .putString("pending", version)
                .putInt("pendingTries", 0)
                .apply();
        return dir;
    }

    // ───────────────────────── APK ─────────────────────────

    static File downloadApk(Context c, String url) throws Exception {
        File dir = new File(c.getCacheDir(), "updates");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        File apk = new File(dir, "update.apk");
        download(url, apk);
        return apk;
    }

    static boolean canInstall(Context c) {
        return Build.VERSION.SDK_INT < 26 || c.getPackageManager().canRequestPackageInstalls();
    }

    /** opens the "install unknown apps" permission screen for this app */
    static void openInstallPermission(Activity a) {
        if (Build.VERSION.SDK_INT >= 26) {
            Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + a.getPackageName()));
            a.startActivity(i);
        }
    }

    static void install(Activity a, File apk) {
        Uri uri = FileProvider.getUriForFile(a, a.getPackageName() + ".fileprovider", apk);
        Intent i = new Intent(Intent.ACTION_VIEW);
        i.setDataAndType(uri, "application/vnd.android.package-archive");
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
        a.startActivity(i);
    }

    // ───────────────────────── helpers ─────────────────────────

    private static void download(String url, File dest) throws IOException {
        String cur = url;
        HttpURLConnection c = null;
        for (int i = 0; i < 8; i++) {
            c = (HttpURLConnection) new URL(cur).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(20000);
            c.setReadTimeout(60000);
            c.setRequestProperty("User-Agent", "CyberIPTV-updater");
            int code = c.getResponseCode();
            if (code >= 300 && code < 400 && c.getHeaderField("Location") != null) {
                cur = URI.create(cur).resolve(c.getHeaderField("Location")).toString();
                c.disconnect();
                c = null;
                continue;
            }
            if (code >= 400) {
                c.disconnect();
                throw new IOException("HTTP " + code);
            }
            break;
        }
        if (c == null) throw new IOException("too many redirects");
        File tmp = new File(dest.getPath() + ".part");
        try (InputStream is = c.getInputStream(); OutputStream os = new FileOutputStream(tmp)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = is.read(buf)) > 0) os.write(buf, 0, n);
        } finally {
            c.disconnect();
        }
        if (dest.exists()) //noinspection ResultOfMethodCallIgnored
            dest.delete();
        if (!tmp.renameTo(dest)) throw new IOException("rename failed");
    }

    private static String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (InputStream is = new FileInputStream(f)) {
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = is.read(buf)) > 0) md.update(buf, 0, n);
        }
        StringBuilder sb = new StringBuilder();
        for (byte b : md.digest()) sb.append(String.format(Locale.ROOT, "%02x", b));
        return sb.toString();
    }

    private static void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteRecursive(k);
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }
}
