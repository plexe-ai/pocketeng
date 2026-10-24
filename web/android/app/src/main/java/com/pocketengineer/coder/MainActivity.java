package com.pocketengineer.coder;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        initializePlaceholderFirebaseForDebugBuilds();
        registerPlugin(PocketEngConfigPlugin.class);
        super.onCreate(savedInstanceState);
    }

    private void initializePlaceholderFirebaseForDebugBuilds() {
        if (getResources().getBoolean(R.bool.pocketeng_fcm_configured) || !FirebaseApp.getApps(this).isEmpty()) {
            return;
        }

        FirebaseOptions options = new FirebaseOptions.Builder()
            .setApplicationId("1:000000000000:android:0000000000000000000000")
            .setApiKey("unused-debug-placeholder")
            .setProjectId("pocketeng-debug-placeholder")
            .build();
        FirebaseApp.initializeApp(this, options);
    }
}
