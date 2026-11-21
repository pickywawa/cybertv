package app.cybertv.player;

import android.app.Activity;
import android.app.PictureInPictureParams;
import android.app.UiModeManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognizerIntent;
import android.util.Rational;
import android.view.Gravity;
import android.view.SurfaceView;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.WebView;
import android.widget.FrameLayout;

import androidx.activity.result.ActivityResult;
import androidx.annotation.NonNull;
import androidx.annotation.OptIn;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.media3.common.C;
import androidx.media3.common.Format;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.PlaybackParameters;
import androidx.media3.common.Player;
import androidx.media3.common.TrackSelectionOverride;
import androidx.media3.common.TrackSelectionParameters;
import androidx.media3.common.Tracks;
import androidx.media3.common.VideoSize;
import androidx.media3.common.text.CueGroup;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.SubtitleView;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Native side of CyberTV:
 *  - local CORS / image proxy (LocalProxy)
 *  - Keystore-backed secrets (SecureStore)
 *  - Media3 ExoPlayer rendered on a SurfaceView *below* the transparent WebView, so all controls stay in HTML
 *  - speech recognition, orientation, immersive mode, picture-in-picture
 */
@UnstableApi
@CapacitorPlugin(name = "CyberNative")
public class CyberNativePlugin extends Plugin {
    private static final int BG = Color.parseColor("#0b0b0d");
    static CyberNativePlugin instance;

    private LocalProxy proxy;
    private SecureStore secure;
    private ExoPlayer player;
    private AspectRatioFrameLayout frame;
    private SubtitleView subtitles;
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean live;
    private String lastError;
    private float videoRatio = 16f / 9f;

    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            if (player == null) return;
            emitState();
            main.postDelayed(this, 500);
        }
    };

    @Override
    public void load() {
        Updater.onLaunch(getContext());
        instance = this;
        secure = new SecureStore(getContext());
        proxy = new LocalProxy(getContext().getCacheDir());
        try {
            proxy.start();
        } catch (Exception e) {
            android.util.Log.e("CyberNative", "proxy start failed", e);
        }
    }

    // ───────────────────────── info / secrets ─────────────────────────

    @PluginMethod
    public void getInfo(PluginCall call) {
        JSObject r = new JSObject();
        r.put("proxyPort", proxy.getPort());
        r.put("isTv", isTv());
        r.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(r);
    }

    // ───────────────────────── background pre-download (see PrefetchWorker) ─────────────────────────

    @PluginMethod
    public void prefetchSchedule(PluginCall call) {
        String plan = call.getString("plan");
        if (plan == null) {
            call.reject("plan required");
            return;
        }
        try {
            PrefetchWorker.schedule(getContext(), plan, call.getInt("intervalH", 6), Boolean.TRUE.equals(call.getBoolean("wifiOnly", true)));
            if (Boolean.TRUE.equals(call.getBoolean("runNow", false))) PrefetchWorker.runNow(getContext(), Boolean.TRUE.equals(call.getBoolean("wifiOnly", true)));
            call.resolve();
        } catch (Exception e) {
            call.reject("schedule failed: " + e.getMessage());
        }
    }

    @PluginMethod
    public void prefetchCancel(PluginCall call) {
        PrefetchWorker.cancel(getContext());
        call.resolve();
    }

    @PluginMethod
    public void prefetchStatus(PluginCall call) {
        try {
            call.resolve(JSObject.fromJSONObject(PrefetchWorker.status(getContext())));
        } catch (Exception e) {
            call.reject(e.getMessage());
        }
    }

    // ───────────────────────── QR enrolment (see EnrollServer) ─────────────────────────

    private EnrollServer enroll;

    @PluginMethod
    public void enrollStart(PluginCall call) {
        new Thread(() -> {
            try {
                if (enroll == null) enroll = new EnrollServer(getContext(), (json) -> {
                    JSObject ev = new JSObject();
                    ev.put("payload", json);
                    notifyListeners("enrollReceived", ev);
                });
                JSObject r = new JSObject();
                r.put("url", enroll.start());
                call.resolve(r);
            } catch (Exception e) {
                call.reject("enroll unavailable: " + e.getMessage());
            }
        }, "cyber-enroll-start").start();
    }

    @PluginMethod
    public void enrollPoll(PluginCall call) {
        JSObject r = new JSObject();
        String p = enroll != null ? enroll.takePayload() : null;
        if (p != null) r.put("payload", p);
        call.resolve(r);
    }

    @PluginMethod
    public void enrollStop(PluginCall call) {
        if (enroll != null) enroll.stop();
        call.resolve();
    }

    // ───────────────────────── self-update (see Updater) ─────────────────────────

    @PluginMethod
    public void updateInfo(PluginCall call) {
        JSObject r = new JSObject();
        r.put("versionCode", Updater.versionCode(getContext()));
        r.put("versionName", Updater.versionName(getContext()));
        String web = Updater.activeWebVersion(getContext());
        if (web != null) r.put("webVersion", web);
        r.put("canInstall", Updater.canInstall(getContext()));
        r.put("silentUpdates", Updater.silentCapable(getContext()));
        call.resolve(r);
    }

    @PluginMethod
    public void updateBootOk(PluginCall call) {
        Updater.bootOk(getContext());
        call.resolve();
    }

    /** download + unpack a web bundle off the plugin thread; `apply` reloads the WebView on it right away */
    @PluginMethod
    public void updateWeb(PluginCall call) {
        String url = call.getString("url");
        String version = call.getString("version");
        String sha = call.getString("sha256");
        boolean apply = Boolean.TRUE.equals(call.getBoolean("apply", false));
        if (url == null || version == null) {
            call.reject("url and version required");
            return;
        }
        new Thread(() -> {
            try {
                java.io.File dir = Updater.installWebBundle(getContext(), url, version, sha);
                if (apply) getActivity().runOnUiThread(() -> getBridge().setServerBasePath(dir.getAbsolutePath()));
                call.resolve();
            } catch (Exception e) {
                call.reject("web update failed: " + e.getMessage());
            }
        }, "cyber-update-web").start();
    }

    /** switch to the downloaded web bundle now (reloads the page) */
    @PluginMethod
    public void updateApplyWeb(PluginCall call) {
        String path = getContext().getSharedPreferences("CapWebViewSettings", Context.MODE_PRIVATE).getString("serverBasePath", null);
        if (path == null || path.isEmpty()) {
            call.reject("no bundle");
            return;
        }
        call.resolve();
        getActivity().runOnUiThread(() -> getBridge().setServerBasePath(path));
    }

    @PluginMethod
    public void updateDownloadApk(PluginCall call) {
        String url = call.getString("url");
        if (url == null) {
            call.reject("url required");
            return;
        }
        new Thread(() -> {
            try {
                Updater.downloadApk(getContext(), url);
                call.resolve();
            } catch (Exception e) {
                call.reject("download failed: " + e.getMessage());
            }
        }, "cyber-update-apk").start();
    }

    /** hands the downloaded APK to the system installer, or opens the permission screen first */
    @PluginMethod
    public void updateInstallApk(PluginCall call) {
        java.io.File apk = new java.io.File(new java.io.File(getContext().getCacheDir(), "updates"), "update.apk");
        if (!apk.exists()) {
            call.reject("no apk downloaded");
            return;
        }
        JSObject r = new JSObject();
        if (!Updater.canInstall(getContext())) {
            Updater.openInstallPermission(getActivity());
            r.put("needsPermission", true);
            call.resolve(r);
            return;
        }
        r.put("needsPermission", false);
        r.put("silent", Updater.silentCapable(getContext()));
        new Thread(() -> {
            try {
                Updater.install(getContext(), apk);
                call.resolve(r);
            } catch (Exception e) {
                call.reject("install failed: " + e.getMessage());
            }
        }, "cyber-update-install").start();
    }

    private boolean isTv() {
        UiModeManager ui = (UiModeManager) getContext().getSystemService(Context.UI_MODE_SERVICE);
        PackageManager pm = getContext().getPackageManager();
        return (ui != null && ui.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION)
                || pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
                || !pm.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN);
    }

    @PluginMethod
    public void secureGet(PluginCall call) {
        JSObject r = new JSObject();
        String v = secure.get(call.getString("key", ""));
        r.put("value", v == null ? JSObject.NULL : v);
        call.resolve(r);
    }

    @PluginMethod
    public void secureSet(PluginCall call) {
        try {
            secure.set(call.getString("key", ""), call.getString("value", ""));
            call.resolve();
        } catch (Exception e) {
            call.reject("secure store failed", e);
        }
    }

    @PluginMethod
    public void secureRemove(PluginCall call) {
        secure.remove(call.getString("key", ""));
        call.resolve();
    }

    @PluginMethod
    public void clearImageCache(PluginCall call) {
        new Thread(() -> {
            proxy.clearImageCache();
            call.resolve();
        }).start();
    }

    // ───────────────────────── speech ─────────────────────────

    @PluginMethod
    public void speech(PluginCall call) {
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, call.getString("lang", Locale.getDefault().toLanguageTag()));
        i.putExtra(RecognizerIntent.EXTRA_PROMPT, call.getString("prompt", ""));
        i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        if (i.resolveActivity(getContext().getPackageManager()) == null) {
            call.reject("unavailable");
            return;
        }
        startActivityForResult(call, i, "onSpeech");
    }

    @ActivityCallback
    private void onSpeech(PluginCall call, ActivityResult result) {
        if (call == null) return;
        Intent data = result.getData();
        ArrayList<String> list = data != null ? data.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS) : null;
        JSObject r = new JSObject();
        r.put("text", list != null && !list.isEmpty() ? list.get(0) : "");
        call.resolve(r);
    }

    // ───────────────────────── window ─────────────────────────

    @PluginMethod
    public void setOrientation(PluginCall call) {
        String mode = call.getString("mode", "auto");
        Activity a = getActivity();
        a.runOnUiThread(() -> {
            if ("landscape".equals(mode)) a.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
            else if ("portrait".equals(mode)) a.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT);
            else a.setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
            call.resolve();
        });
    }

    @PluginMethod
    public void setImmersive(PluginCall call) {
        boolean on = Boolean.TRUE.equals(call.getBoolean("on", false));
        Activity a = getActivity();
        a.runOnUiThread(() -> {
            WindowInsetsControllerCompat c = WindowCompat.getInsetsController(a.getWindow(), a.getWindow().getDecorView());
            c.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            if (on) c.hide(WindowInsetsCompat.Type.systemBars());
            else c.show(WindowInsetsCompat.Type.systemBars());
            call.resolve();
        });
    }

    // ───────────────────────── player ─────────────────────────

    @OptIn(markerClass = UnstableApi.class)
    private void ensurePlayer() {
        if (player != null) return;
        Context ctx = getContext();
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                .setUserAgent("VLC/3.0.20 LibVLC/3.0.20")
                .setAllowCrossProtocolRedirects(true)
                .setConnectTimeoutMs(12000)
                .setReadTimeoutMs(20000);
        // FFmpeg audio (AC3 / E-AC3 / DTS…) is used only when the device has no hardware decoder
        DefaultRenderersFactory renderers = new DefaultRenderersFactory(ctx)
                .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON)
                .setEnableDecoderFallback(true);
        DefaultLoadControl load = new DefaultLoadControl.Builder()
                .setBufferDurationsMs(15000, 50000, 1500, 3000)
                .build();
        player = new ExoPlayer.Builder(ctx, renderers)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(http))
                .setLoadControl(load)
                .build();
        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                emitState();
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                emitState();
                Activity a = getActivity();
                if (a != null) {
                    if (isPlaying) a.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                    else a.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            }

            @Override
            public void onPlayerError(@NonNull PlaybackException error) {
                if (error.errorCode == PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW && player != null) {
                    player.seekToDefaultPosition();
                    player.prepare();
                    return;
                }
                lastError = error.getErrorCodeName() + (error.getMessage() != null ? ": " + error.getMessage() : "");
                emitState();
            }

            @Override
            public void onTracksChanged(@NonNull Tracks tracks) {
                JSObject r = new JSObject();
                r.put("tracks", tracksJson());
                notifyListeners("playerTracks", r);
            }

            @Override
            public void onVideoSizeChanged(@NonNull VideoSize size) {
                if (size.width > 0 && size.height > 0 && frame != null) {
                    videoRatio = size.width * size.pixelWidthHeightRatio / size.height;
                    frame.setAspectRatio(videoRatio);
                }
            }

            @Override
            public void onCues(@NonNull CueGroup cues) {
                if (subtitles != null) subtitles.setCues(cues.cues);
            }
        });
        attachSurface();
    }

    /** Puts the video surface behind the WebView and makes the WebView transparent */
    private void attachSurface() {
        WebView web = getBridge().getWebView();
        ViewGroup parent = (ViewGroup) web.getParent();
        Context ctx = getContext();
        FrameLayout host = new FrameLayout(ctx);
        host.setBackgroundColor(Color.BLACK);
        host.setTag("cyber-video");
        frame = new AspectRatioFrameLayout(ctx);
        frame.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT);
        frame.setAspectRatio(videoRatio);
        SurfaceView surface = new SurfaceView(ctx);
        frame.addView(surface, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        subtitles = new SubtitleView(ctx);
        subtitles.setUserDefaultStyle();
        subtitles.setUserDefaultTextSize();
        frame.addView(subtitles, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        host.addView(frame, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT, Gravity.CENTER));
        parent.addView(host, 0, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        player.setVideoSurfaceView(surface);
        web.setBackgroundColor(Color.TRANSPARENT);
    }

    private void releasePlayer() {
        main.removeCallbacks(ticker);
        if (player != null) {
            player.release();
            player = null;
        }
        WebView web = getBridge().getWebView();
        ViewGroup parent = (ViewGroup) web.getParent();
        View host = parent.findViewWithTag("cyber-video");
        if (host != null) parent.removeView(host);
        frame = null;
        subtitles = null;
        web.setBackgroundColor(BG);
        Activity a = getActivity();
        if (a != null) a.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    }

    @PluginMethod
    public void playerOpen(PluginCall call) {
        String url = call.getString("url");
        if (url == null) {
            call.reject("url required");
            return;
        }
        Long startMs = longArg(call, "startMs");
        live = Boolean.TRUE.equals(call.getBoolean("live", false));
        String audioLang = call.getString("audioLang");
        String subLang = call.getString("subLang");
        getActivity().runOnUiThread(() -> {
            ensurePlayer();
            lastError = null;
            MediaItem.Builder b = new MediaItem.Builder().setUri(url);
            String lower = url.toLowerCase(Locale.ROOT);
            if (lower.contains(".m3u8")) b.setMimeType(MimeTypes.APPLICATION_M3U8);
            else if (lower.contains(".mpd")) b.setMimeType(MimeTypes.APPLICATION_MPD);
            TrackSelectionParameters.Builder p = player.getTrackSelectionParameters().buildUpon()
                    .clearOverrides()
                    .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, subLang == null || "off".equals(subLang));
            // comma separated lists, most preferred first ("fr,en")
            if (audioLang != null && !audioLang.isEmpty()) p.setPreferredAudioLanguages(audioLang.split(","));
            if (subLang != null && !"off".equals(subLang) && !subLang.isEmpty()) p.setPreferredTextLanguages(subLang.split(","));
            player.setTrackSelectionParameters(p.build());
            if (startMs != null && startMs > 0) player.setMediaItem(b.build(), startMs);
            else player.setMediaItem(b.build());
            player.setPlaybackParameters(PlaybackParameters.DEFAULT);
            player.prepare();
            player.setPlayWhenReady(true);
            main.removeCallbacks(ticker);
            main.post(ticker);
            call.resolve();
        });
    }

    @PluginMethod
    public void playerPlay(PluginCall call) {
        onPlayer(call, () -> player.play());
    }

    @PluginMethod
    public void playerPause(PluginCall call) {
        onPlayer(call, () -> player.pause());
    }

    @PluginMethod
    public void playerSeek(PluginCall call) {
        Long pos = longArg(call, "positionMs");
        if (pos == null || pos < 0) {
            // never turn a bad value into "go back to the start"
            call.reject("positionMs required");
            return;
        }
        onPlayer(call, () -> player.seekTo(pos));
    }

    /**
     * Numbers from JS arrive as Integer, Long or Double depending on their size; Capacitor's
     * getLong() only accepts Long and silently returns the default for an Integer (any position
     * under ~24 days in ms), which made every seek / resume jump to 0.
     */
    @androidx.annotation.Nullable
    static Long longArg(PluginCall call, String key) {
        Object v = call.getData().opt(key);
        if (v instanceof Number) {
            double d = ((Number) v).doubleValue();
            if (Double.isNaN(d) || Double.isInfinite(d)) return null;
            return Math.round(d);
        }
        return null;
    }

    @PluginMethod
    public void playerStop(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            releasePlayer();
            call.resolve();
        });
    }

    @PluginMethod
    public void playerSetRate(PluginCall call) {
        float r = call.getFloat("rate", 1f);
        onPlayer(call, () -> player.setPlaybackParameters(new PlaybackParameters(r)));
    }

    @PluginMethod
    public void playerSetResize(PluginCall call) {
        String m = call.getString("mode", "fit");
        onPlayer(call, () -> {
            if (frame == null) return;
            frame.setResizeMode("fill".equals(m) ? AspectRatioFrameLayout.RESIZE_MODE_FILL
                    : "zoom".equals(m) ? AspectRatioFrameLayout.RESIZE_MODE_ZOOM : AspectRatioFrameLayout.RESIZE_MODE_FIT);
        });
    }

    @PluginMethod
    public void playerTracks(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            JSObject r = new JSObject();
            r.put("tracks", player != null ? tracksJson() : new JSArray());
            call.resolve(r);
        });
    }

    @PluginMethod
    public void playerSelectTrack(PluginCall call) {
        String type = call.getString("type", "audio");
        String id = call.getString("id");
        int t = "video".equals(type) ? C.TRACK_TYPE_VIDEO : "text".equals(type) ? C.TRACK_TYPE_TEXT : C.TRACK_TYPE_AUDIO;
        onPlayer(call, () -> {
            TrackSelectionParameters.Builder p = player.getTrackSelectionParameters().buildUpon();
            if (id == null) {
                p.clearOverridesOfType(t);
                if (t == C.TRACK_TYPE_TEXT) p.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true);
            } else {
                String[] parts = id.split(":");
                int gi = Integer.parseInt(parts[0]);
                int ti = Integer.parseInt(parts[1]);
                List<Tracks.Group> groups = player.getCurrentTracks().getGroups();
                if (gi < groups.size()) {
                    p.setTrackTypeDisabled(t, false);
                    p.setOverrideForType(new TrackSelectionOverride(groups.get(gi).getMediaTrackGroup(), ti));
                }
            }
            player.setTrackSelectionParameters(p.build());
        });
    }

    @PluginMethod
    public void playerPip(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            enterPip();
            call.resolve();
        });
    }

    boolean enterPip() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || player == null || isTv()) return false;
        Rational r = new Rational(Math.round(videoRatio * 1000), 1000);
        try {
            return getActivity().enterPictureInPictureMode(new PictureInPictureParams.Builder().setAspectRatio(r).build());
        } catch (Exception e) {
            return false;
        }
    }

    /** called by MainActivity when the user leaves the app while a video plays */
    void onUserLeave() {
        if (player != null && player.isPlaying()) enterPip();
    }

    void onPipChanged(boolean active) {
        JSObject r = new JSObject();
        r.put("active", active);
        notifyListeners("pipChanged", r);
    }

    private void onPlayer(PluginCall call, Runnable r) {
        getActivity().runOnUiThread(() -> {
            if (player != null) r.run();
            call.resolve();
        });
    }

    private JSArray tracksJson() {
        JSArray arr = new JSArray();
        List<Tracks.Group> groups = player.getCurrentTracks().getGroups();
        for (int g = 0; g < groups.size(); g++) {
            Tracks.Group grp = groups.get(g);
            int type = grp.getType();
            String ts = type == C.TRACK_TYPE_AUDIO ? "audio" : type == C.TRACK_TYPE_TEXT ? "text" : type == C.TRACK_TYPE_VIDEO ? "video" : null;
            if (ts == null) continue;
            for (int i = 0; i < grp.length; i++) {
                if (!grp.isTrackSupported(i)) continue;
                Format f = grp.getTrackFormat(i);
                JSObject o = new JSObject();
                o.put("id", g + ":" + i);
                o.put("type", ts);
                o.put("selected", grp.isTrackSelected(i));
                if (f.language != null) o.put("language", f.language);
                String label;
                if (type == C.TRACK_TYPE_VIDEO) {
                    label = f.height > 0 ? f.height + "p" : (f.bitrate > 0 ? (f.bitrate / 1000) + " kb/s" : "Video " + (i + 1));
                    o.put("height", f.height);
                    o.put("bitrate", f.bitrate);
                } else {
                    String lang = f.language != null ? new Locale(f.language).getDisplayLanguage() : null;
                    label = f.label != null ? f.label : lang != null && !lang.isEmpty() ? lang : (ts + " " + (i + 1));
                    if (type == C.TRACK_TYPE_AUDIO && f.sampleMimeType != null) {
                        String codec = f.sampleMimeType.replace("audio/", "").toUpperCase(Locale.ROOT);
                        label += " · " + codec + (f.channelCount > 2 ? " " + f.channelCount + "ch" : "");
                    }
                }
                o.put("label", label);
                arr.put(o);
            }
        }
        return arr;
    }

    private void emitState() {
        if (player == null) return;
        JSObject r = new JSObject();
        int st = player.getPlaybackState();
        String state = lastError != null ? "error"
                : st == Player.STATE_BUFFERING ? "buffering"
                : st == Player.STATE_READY ? "ready"
                : st == Player.STATE_ENDED ? "ended" : "idle";
        long dur = player.getDuration();
        r.put("state", state);
        r.put("playing", player.isPlaying());
        r.put("positionMs", Math.max(0, player.getCurrentPosition()));
        r.put("durationMs", dur == C.TIME_UNSET ? 0 : dur);
        r.put("bufferedMs", Math.max(0, player.getBufferedPosition()));
        r.put("isLive", live || player.isCurrentMediaItemLive());
        if (lastError != null) r.put("error", lastError);
        VideoSize vs = player.getVideoSize();
        r.put("width", vs.width);
        r.put("height", vs.height);
        notifyListeners("playerState", r);
    }

    @Override
    protected void handleOnDestroy() {
        releasePlayer();
        instance = null;
    }
}
