package app.cybertv.player;

import android.content.res.Configuration;
import android.graphics.Color;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(CyberNativePlugin.class);
        super.onCreate(savedInstanceState);
        getWindow().getDecorView().setBackgroundColor(Color.parseColor("#0b0b0d"));
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
