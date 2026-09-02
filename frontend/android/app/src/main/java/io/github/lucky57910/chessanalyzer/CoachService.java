package io.github.lucky57910.chessanalyzer;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;

/**
 * Posts a game's coach requests while the app is not there.
 *
 * Android freezes a backgrounded WebView, so a commentary started and then put
 * in a pocket simply stopped. This is the smallest thing that survives that: a
 * foreground service, a notification saying what it is doing, and a file with
 * the answers in it for the app to read when it comes back.
 *
 * It is deliberately as stupid as StockfishPlugin. It does not know what a
 * chess move is, which provider it is talking to, what the JSON coming back
 * means, or whether an answer is any good - `planGame` in the JS built every
 * request, and `readChunk` reads every reply. What lives here is only what
 * cannot live up there: an HTTP POST that outlives the WebView, a retry for
 * the statuses that are worth retrying, and a notification.
 *
 * The payload is one JSON object:
 *
 *   { jobId, gameId, label,
 *     chunks: [ { plies: [..], attempts: [ { provider, url, headers, body } ] } ] }
 *
 * Attempts are ordered: the next one is only tried when the one before it has
 * run out of retries, which is what makes a second provider a spare rather
 * than a second bill.
 */
public class CoachService extends Service {

    public static final String CHANNEL_ID = "coach";
    public static final String EXTRA_PAYLOAD = "payload";

    /** The ongoing notification. The finished one gets its own id per game. */
    private static final int PROGRESS_NOTIFICATION = 4100;
    private static final int DONE_NOTIFICATION_BASE = 4200;

    /** Retries per provider before moving to the next one. */
    private static final int MAX_TRIES = 3;

    private static final int CONNECT_TIMEOUT_MS = 30_000;
    private static final int READ_TIMEOUT_MS = 90_000;
    private static final long MAX_BACKOFF_MS = 30_000L;

    /** Where finished jobs wait for the app to come back. */
    static File resultsDir(android.content.Context context) {
        File dir = new File(context.getFilesDir(), "coach");
        if (!dir.exists()) {
            dir.mkdirs();
        }
        return dir;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Coach IA",
                NotificationManager.IMPORTANCE_LOW
            );
            channel.setDescription("Rédaction des commentaires de partie");
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String raw = intent == null ? null : intent.getStringExtra(EXTRA_PAYLOAD);
        if (raw == null) {
            stopSelf(startId);
            return START_NOT_STICKY;
        }

        // Foregrounded before anything else: Android gives a service a few
        // seconds to show its notification and kills it if it does not.
        startInForeground(notification("Le coach écrit…", "Préparation", true));

        final String payload = raw;
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    process(new JSONObject(payload));
                } catch (Exception error) {
                    // Nothing to recover: the job is gone and the app will
                    // simply find no result file. Saying so beats a crash.
                    show(PROGRESS_NOTIFICATION, notification("Coach interrompu", String.valueOf(error.getMessage()), false));
                }
                stopForegroundCompat();
                stopSelf();
            }
        }).start();

        // Not sticky: a job restarted with no payload would be a notification
        // that never ends, and the app can always ask again.
        return START_NOT_STICKY;
    }

    private void process(JSONObject payload) throws Exception {
        JSONArray chunks = payload.optJSONArray("chunks");
        if (chunks == null) {
            chunks = new JSONArray();
        }
        String label = payload.optString("label", "");
        int total = chunks.length();

        JSONArray results = new JSONArray();
        for (int index = 0; index < total; index += 1) {
            show(
                PROGRESS_NOTIFICATION,
                notification("Le coach écrit…", (label.isEmpty() ? "" : label + " · ") + "lot " + (index + 1) + "/" + total, true)
            );

            JSONObject chunk = chunks.getJSONObject(index);
            JSONObject result = new JSONObject();
            result.put("plies", chunk.optJSONArray("plies"));
            attempt(chunk.optJSONArray("attempts"), result);
            results.put(result);
        }

        JSONObject stored = new JSONObject();
        stored.put("jobId", payload.optString("jobId"));
        stored.put("gameId", payload.opt("gameId"));
        stored.put("label", label);
        stored.put("finishedAt", System.currentTimeMillis());
        stored.put("chunks", results);
        write(payload.optString("jobId"), stored);

        int written = 0;
        for (int i = 0; i < results.length(); i += 1) {
            if (results.getJSONObject(i).has("status")) {
                written += 1;
            }
        }
        announce(payload.optInt("gameId", 0), label, written, total);
    }

    /** Walk one chunk's providers in order, retrying what is worth retrying. */
    private void attempt(JSONArray attempts, JSONObject result) {
        String lastError = "Aucun fournisseur n’a répondu.";
        if (attempts == null) {
            attempts = new JSONArray();
        }

        for (int i = 0; i < attempts.length(); i += 1) {
            JSONObject attempt = attempts.optJSONObject(i);
            if (attempt == null) {
                continue;
            }
            for (int tries = 0; tries < MAX_TRIES; tries += 1) {
                try {
                    Response response = post(attempt);
                    if (response.status == 429 || response.status >= 500) {
                        lastError = "Le modèle a répondu " + response.status;
                        sleep(backoff(response.retryAfterMs, tries));
                        continue;
                    }
                    // Everything else - including a 4xx - is an answer, and
                    // the JS decides what it means. A refused key must not be
                    // retried and must not be handed to the next provider.
                    try {
                        result.put("provider", attempt.optString("provider"));
                        result.put("status", response.status);
                        result.put("body", response.body);
                    } catch (Exception ignored) {
                        // JSONObject.put only throws on a null key.
                    }
                    return;
                } catch (Exception error) {
                    // The request never arrived: DNS, a dropped connection, a
                    // timeout. Nothing was answered, so there is everything to
                    // retry.
                    lastError = String.valueOf(error.getMessage());
                    sleep(backoff(0, tries));
                }
            }
        }

        try {
            result.put("error", lastError);
        } catch (Exception ignored) {
        }
    }

    private static long backoff(long retryAfterMs, int attempt) {
        if (retryAfterMs > 0) {
            return Math.min(retryAfterMs, MAX_BACKOFF_MS);
        }
        return Math.min(2000L * (1L << attempt), MAX_BACKOFF_MS);
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    private static class Response {
        int status;
        String body;
        long retryAfterMs;
    }

    private Response post(JSONObject attempt) throws Exception {
        URL url = new URL(attempt.getString("url"));
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        try {
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setDoOutput(true);

            JSONObject headers = attempt.optJSONObject("headers");
            if (headers != null) {
                Iterator<String> names = headers.keys();
                while (names.hasNext()) {
                    String name = names.next();
                    connection.setRequestProperty(name, headers.optString(name));
                }
            }

            byte[] body = attempt.optString("body").getBytes(StandardCharsets.UTF_8);
            OutputStream out = connection.getOutputStream();
            out.write(body);
            out.flush();
            out.close();

            Response response = new Response();
            response.status = connection.getResponseCode();
            InputStream stream = response.status >= 400
                ? connection.getErrorStream()
                : connection.getInputStream();
            response.body = read(stream);

            String retryAfter = connection.getHeaderField("Retry-After");
            if (retryAfter != null) {
                try {
                    response.retryAfterMs = (long) (Double.parseDouble(retryAfter) * 1000);
                } catch (NumberFormatException notASecondCount) {
                    response.retryAfterMs = 0;
                }
            }
            return response;
        } finally {
            connection.disconnect();
        }
    }

    private static String read(InputStream stream) throws Exception {
        if (stream == null) {
            return "";
        }
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int read;
        while ((read = stream.read(chunk)) != -1) {
            buffer.write(chunk, 0, read);
        }
        stream.close();
        return new String(buffer.toByteArray(), StandardCharsets.UTF_8);
    }

    private void write(String jobId, JSONObject stored) throws Exception {
        File file = new File(resultsDir(this), safe(jobId) + ".json");
        FileOutputStream out = new FileOutputStream(file);
        out.write(stored.toString().getBytes(StandardCharsets.UTF_8));
        out.close();
    }

    /** A job id becomes a file name, so it may not become a path. */
    static String safe(String jobId) {
        return jobId == null ? "job" : jobId.replaceAll("[^A-Za-z0-9_.-]", "_");
    }

    private void announce(int gameId, String label, int written, int total) {
        String text = written == total
            ? "Commentaires prêts" + (label.isEmpty() ? "" : " · " + label)
            : written + " lot(s) sur " + total + " rédigés" + (label.isEmpty() ? "" : " · " + label);

        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        PendingIntent pending = PendingIntent.getActivity(
            this,
            gameId,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        Notification done = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_chat)
            .setContentTitle("Partie commentée")
            .setContentText(text)
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setOngoing(false)
            .build();
        show(DONE_NOTIFICATION_BASE + gameId, done);
    }

    private Notification notification(String title, String text, boolean ongoing) {
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle(title)
            .setContentText(text)
            .setOngoing(ongoing)
            .setOnlyAlertOnce(true)
            .build();
    }

    private void show(int id, Notification notification) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.notify(id, notification);
        }
    }

    private void startInForeground(Notification notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(PROGRESS_NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(PROGRESS_NOTIFICATION, notification);
        }
    }

    private void stopForegroundCompat() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(Service.STOP_FOREGROUND_REMOVE);
        } else {
            stopForeground(true);
        }
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
