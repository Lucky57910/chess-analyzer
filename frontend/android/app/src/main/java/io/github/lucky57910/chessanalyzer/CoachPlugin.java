package io.github.lucky57910.chessanalyzer;

import android.Manifest;
import android.content.Intent;
import android.os.Build;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.io.ByteArrayOutputStream;

/**
 * The handle the app holds on {@link CoachService}.
 *
 * Same rule as StockfishPlugin: it moves bytes and owns no judgment. `start`
 * hands a prepared payload to the service, `pending` reads back the files the
 * service left, `clear` deletes one once the app has stored it. Everything
 * about what those bytes mean - which provider, which moves, whether the
 * answer is usable - is in src/coach/, where it can be tested without a phone.
 *
 * `POST_NOTIFICATIONS` is asked for rather than assumed. Denied, the service
 * still runs; the user simply never learns it finished, which is the whole
 * point of running it there, so the screen asks first.
 */
@CapacitorPlugin(
    name = "CoachRunner",
    permissions = {
        @Permission(alias = CoachPlugin.NOTIFICATIONS, strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class CoachPlugin extends Plugin {

    static final String NOTIFICATIONS = "notifications";

    /** Lets the JS tell a phone from a browser without catching an error. */
    @PluginMethod
    public void available(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", true);
        // Below API 33 there is no notification permission to ask for, and
        // notifications are on unless the user turned them off in Settings.
        result.put("needsPermission", Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU);
        call.resolve(result);
    }

    @PluginMethod
    public void start(PluginCall call) {
        JSObject payload = call.getData();
        if (payload.optJSONArray("chunks") == null) {
            call.reject("Rien à envoyer.");
            return;
        }

        Intent intent = new Intent(getContext(), CoachService.class);
        intent.putExtra(CoachService.EXTRA_PAYLOAD, payload.toString());
        ContextCompat.startForegroundService(getContext(), intent);

        JSObject result = new JSObject();
        result.put("started", true);
        call.resolve(result);
    }

    /** Every finished job the app has not stored yet, newest last. */
    @PluginMethod
    public void pending(PluginCall call) {
        JSArray jobs = new JSArray();
        File[] files = CoachService.resultsDir(getContext()).listFiles();
        if (files != null) {
            java.util.Arrays.sort(files, new java.util.Comparator<File>() {
                @Override
                public int compare(File a, File b) {
                    return Long.compare(a.lastModified(), b.lastModified());
                }
            });
            for (File file : files) {
                if (!file.getName().endsWith(".json")) {
                    continue;
                }
                try {
                    jobs.put(new JSONObject(read(file)));
                } catch (Exception unreadable) {
                    // A half-written file from a process killed mid-save. It
                    // is not recoverable and not worth keeping.
                    file.delete();
                }
            }
        }

        JSObject result = new JSObject();
        result.put("jobs", jobs);
        call.resolve(result);
    }

    @PluginMethod
    public void clear(PluginCall call) {
        String jobId = call.getString("jobId");
        if (jobId == null) {
            call.reject("jobId manquant.");
            return;
        }
        new File(CoachService.resultsDir(getContext()), CoachService.safe(jobId) + ".json").delete();
        call.resolve();
    }

    private static String read(File file) throws Exception {
        InputStream stream = new FileInputStream(file);
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int count;
        while ((count = stream.read(chunk)) != -1) {
            buffer.write(chunk, 0, count);
        }
        stream.close();
        return new String(buffer.toByteArray(), StandardCharsets.UTF_8);
    }
}
