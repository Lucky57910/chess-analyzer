package io.github.lucky57910.chessanalyzer;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;

/**
 * Runs the official Stockfish ARM binary as a child process and pipes UCI
 * through the Capacitor bridge.
 *
 * Deliberately dumb. It knows how to start a process, write a line, and forward
 * lines back; it does not know what a centipawn is. Every decision that matters
 * - which positions to search, how deep, what an evaluation means - lives in
 * src/engine/, which is tested against the Python implementation it replaces.
 * Logic put here would be logic no test on this project can reach.
 *
 * Two Android constraints shape this:
 *
 *   * Since API 29 an app may not execute a file from its data directory, so
 *     the engine cannot be downloaded at runtime. It ships inside the APK as
 *     jniLibs/arm64-v8a/libstockfish.so - the `lib*.so` name is what gets it
 *     extracted and marked executable - and is run from nativeLibraryDir.
 *   * That extraction only happens with `useLegacyPackaging true`. Without it
 *     the library stays aligned inside the APK, nativeLibraryDir points at a
 *     path that is not a real file, and exec fails with ENOENT.
 */
@CapacitorPlugin(name = "Stockfish")
public class StockfishPlugin extends Plugin {

    private static final String BINARY = "libstockfish.so";

    private Process process;
    private BufferedWriter stdin;
    private Thread reader;

    private String binaryPath() {
        return new File(getContext().getApplicationInfo().nativeLibraryDir, BINARY).getAbsolutePath();
    }

    @PluginMethod
    public void info(PluginCall call) {
        File binary = new File(binaryPath());
        JSObject result = new JSObject();
        result.put("path", binary.getAbsolutePath());
        result.put("available", binary.canExecute());
        result.put("running", process != null);
        result.put("cpuAbi", android.os.Build.SUPPORTED_ABIS.length > 0 ? android.os.Build.SUPPORTED_ABIS[0] : "unknown");
        // What the engine may claim for its transposition table. Runtime.maxMemory
        // is the JVM heap, not the native budget, but it tracks the per-app limit
        // closely enough to size Hash without provoking the low-memory killer.
        result.put("maxMemoryMb", Runtime.getRuntime().maxMemory() / (1024 * 1024));
        call.resolve(result);
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (process != null) {
            call.resolve();
            return;
        }
        File binary = new File(binaryPath());
        if (!binary.canExecute()) {
            call.reject(
                "Stockfish binary missing or not executable at " + binary.getAbsolutePath() +
                ". Check that jniLibs/arm64-v8a/libstockfish.so is packaged and that " +
                "useLegacyPackaging is true."
            );
            return;
        }
        try {
            ProcessBuilder builder = new ProcessBuilder(binary.getAbsolutePath());
            // One stream to drain instead of two. A full, unread stderr pipe
            // deadlocks the child, and the engine writes there on startup.
            builder.redirectErrorStream(true);
            process = builder.start();
            stdin = new BufferedWriter(new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8));
            reader = new Thread(this::pump, "stockfish-stdout");
            reader.setDaemon(true);
            reader.start();
            call.resolve();
        } catch (IOException exc) {
            process = null;
            call.reject("Could not start Stockfish: " + exc.getMessage(), exc);
        }
    }

    private void pump() {
        Process current = process;
        try (BufferedReader out = new BufferedReader(
                new InputStreamReader(current.getInputStream(), StandardCharsets.UTF_8))) {
            String line;
            while ((line = out.readLine()) != null) {
                if (!forwards(line)) continue;
                JSObject event = new JSObject();
                event.put("line", line);
                notifyListeners("line", event);
            }
        } catch (IOException exc) {
            // Expected when the process is torn down; anything else is reported
            // to JS as the stream simply ending, which the driver times out on.
        } finally {
            JSObject event = new JSObject();
            event.put("code", exitCodeOf(current));
            notifyListeners("exit", event);
        }
    }

    private static int exitCodeOf(Process current) {
        try {
            return current.waitFor();
        } catch (InterruptedException exc) {
            Thread.currentThread().interrupt();
            return -1;
        }
    }

    /**
     * Drop the search chatter, keep everything that carries meaning.
     *
     * A depth-18 search emits thousands of `info depth ... currmove ...` and
     * `info nodes ... nps ...` lines. Crossing the bridge with all of them costs
     * far more than the search itself. The lines that survive are the ones the
     * driver reads: evaluations, `bestmove`, and the handshake.
     *
     * This is a volume filter, not parsing - it never interprets a field.
     */
    private static boolean forwards(String line) {
        if (!line.startsWith("info")) return true;
        return line.contains(" score ");
    }

    @PluginMethod
    public void cmd(PluginCall call) {
        String command = call.getString("command");
        if (command == null) {
            call.reject("cmd requires a `command` string");
            return;
        }
        BufferedWriter out = stdin;
        if (out == null) {
            call.reject("Engine is not running");
            return;
        }
        try {
            synchronized (this) {
                out.write(command);
                out.write('\n');
                out.flush();
            }
            call.resolve();
        } catch (IOException exc) {
            call.reject("Could not write to Stockfish: " + exc.getMessage(), exc);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        shutdown();
        call.resolve();
    }

    private synchronized void shutdown() {
        Process current = process;
        if (current == null) return;
        process = null;
        try {
            if (stdin != null) {
                stdin.write("quit\n");
                stdin.flush();
                stdin.close();
            }
        } catch (IOException ignored) {
            // The process is going away regardless.
        }
        stdin = null;
        try {
            // `quit` is the polite path and it is quick; destroy is the backstop
            // for an engine wedged mid-search.
            if (!current.waitFor(2, java.util.concurrent.TimeUnit.SECONDS)) {
                current.destroy();
            }
        } catch (InterruptedException exc) {
            Thread.currentThread().interrupt();
            current.destroy();
        }
        reader = null;
    }

    @Override
    protected void handleOnDestroy() {
        shutdown();
    }
}
