package com.pocketengineer.coder;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "PocketEngConfig")
public class PocketEngConfigPlugin extends Plugin {
    @PluginMethod
    public void getNativeConfig(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("fcmConfigured", getContext().getResources().getBoolean(R.bool.pocketeng_fcm_configured));
        call.resolve(ret);
    }
}
