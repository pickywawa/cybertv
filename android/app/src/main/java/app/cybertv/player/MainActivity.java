package app.cybertv.player;

import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Bundle;
import android.view.KeyEvent;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CyberNativePlugin.class);
        super.onCreate(savedInstanceState);
        getWindow().getDecorView().setBackgroundColor(Color.parseColor("#0b0b0d"));
        // phones: portrait everywhere except in the player (which asks for landscape itself)
        setRequestedOrientation(CyberNativePlugin.appOrientation(this));
    }

    /**
     * Remote voice / search button: voice commands in the app. (Remotes whose microphone key opens
     * Google Assistant at system level never send it to apps; the in-app mic button covers them.)
     */
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int code = event.getKeyCode();
        if (code == KeyEvent.KEYCODE_SEARCH || code == KeyEvent.KEYCODE_VOICE_ASSIST) {
            if (event.getAction() == KeyEvent.ACTION_UP && event.getRepeatCount() == 0 && CyberNativePlugin.instance != null) {
                CyberNativePlugin.instance.onVoiceKey();
            }
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (CyberNativePlugin.instance != null) CyberNativePlugin.instance.onUserLeave();
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, Configuration newConfig) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig);
        if (CyberNativePlugin.instance != null) CyberNativePlugin.instance.onPipChanged(isInPictureInPictureMode);
    }
}
