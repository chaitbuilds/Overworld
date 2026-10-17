package dev.overworld.client.dev;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.renderpearl.api.buffers.GpuBuffer;
import dev.overworld.client.ClientEnv;
import java.io.BufferedOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.TimeUnit;
import net.minecraft.client.Minecraft;

/**
 * QA-only recorder of the game's own framebuffer (never the desktop, no audio). Every written
 * frame is a distinct, freshly rendered frame: nothing is duplicated or interpolated to fill a
 * missed slot. Real capture times are kept in a sidecar so a take can be judged by its actual
 * cadence instead of the container's nominal frame rate.
 *
 * Readbacks are asynchronous (PBO + fence) and several may be in flight; a slow encoder never
 * blocks the render thread. A frame that cannot be queued is counted as dropped, not repeated.
 */
final class DevVideo {
    private static final int POOL = 24;   // frames that may wait for the encoder before one is dropped (rides out short stalls when the machine is busy)
    private static volatile Take take;

    static void register() {
        DevBridge.register("dev.video.start", 10000, "{name,fps?:60,seconds?:120,bitrateM?:60} - record the game framebuffer; inspect validRealtime/missedSlots/dropped in the result, never infer freshness from the MP4 frame rate", (req, mc) -> DevBridge.onClient(mc, () -> {
            if (take != null) throw new IllegalStateException("A take is already recording");
            var f = Fields.of(req);
            String name = f.str("name");
            if (!name.matches("[A-Za-z0-9_-]{1,80}")) throw new IllegalArgumentException("Simple take name required");
            int fps = f.optInt("fps", 60, 1, 120), seconds = f.optInt("seconds", 120, 1, 900), bitrate = f.optInt("bitrateM", 60, 4, 200);
            String executable = ClientEnv.raw("OVERWORLD_FFMPEG");
            if (executable == null || !Files.isExecutable(Path.of(executable))) throw new IllegalArgumentException("Configure the trusted ffmpeg executable at game launch (OVERWORLD_FFMPEG)");
            try {
                Path dir = ClientEnv.shotsDir().resolve("video");
                Files.createDirectories(dir);
                Path file = dir.resolve(name + ".mp4");
                if (Files.exists(file)) throw new IOException("Take already exists");
                int w = mc.gameRenderer.mainRenderTarget().width, h = mc.gameRenderer.mainRenderTarget().height;
                var process = new ProcessBuilder(executable, "-hide_banner", "-loglevel", "warning", "-n",
                    "-f", "rawvideo", "-pixel_format", "rgba", "-video_size", w + "x" + h, "-framerate", String.valueOf(fps), "-i", "pipe:0",
                    // convert RGB with the BT.709 matrix the file is tagged with (the default conversion is BT.601, which shifts every colour)
                    "-an", "-filter_threads", "4", "-vf", "vflip,scale=out_color_matrix=bt709:out_range=tv,format=nv12", "-c:v", "h264_videotoolbox", "-b:v", bitrate + "M", "-profile:v", "high",
                    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv", "-movflags", "+faststart", file.toString())
                    .redirectError(dir.resolve(name + ".log").toFile()).start();
                take = new Take(file, process, fps, seconds, w, h);
                return take.status(false);
            } catch (IOException e) {
                throw new RuntimeException(e);
            }
        }));
        DevBridge.register("dev.video.stop", 60000, "{} - finish the current game-only MP4 and its timing sidecar", (req, mc) -> DevBridge.onClient(mc, () -> {
            var t = take;
            if (t == null) throw new IllegalStateException("No active take");
            take = null;
            t.stopping = true;
            return t;
        }).thenCompose(Take::finish));
        DevBridge.register("dev.video.mark", 5000, "{label} - stamp an event on the active take's clock (saved in its sidecar); returns {t}", (req, mc) -> {
            var t = take;
            if (t == null) throw new DevBridge.DevException("No active take");
            String label = Fields.of(req).str("label");
            double at = (System.nanoTime() - t.start) / 1e9;
            var mark = new JsonObject();
            mark.addProperty("t", Math.round(at * 1e5) / 1e5);
            mark.addProperty("epochMs", System.currentTimeMillis());
            mark.addProperty("label", label.length() > 200 ? label.substring(0, 200) : label);
            t.marks.add(mark);
            return CompletableFuture.completedFuture(mark.deepCopy());
        });
        DevBridge.register("dev.video.status", 5000, "{} - current capture status", (req, mc) -> CompletableFuture.completedFuture(take == null ? new JsonObject() : take.status(false)));
    }

    /** Wall-clock seconds since the active take started, or -1. Lets other dev commands stamp events on the take's clock. */
    static double clock() {
        var t = take;
        return t == null ? -1 : (System.nanoTime() - t.start) / 1e9;
    }

    static void frame(Minecraft mc) {
        var t = take;
        if (t == null || t.stopping) return;
        long now = System.nanoTime();
        double elapsed = (now - t.start) / 1e9;
        if (elapsed >= t.seconds) {
            take = null;
            t.stopping = true;
            t.finish();
            return;
        }
        t.rendered++;
        double interval = 1.0 / t.fps;
        // Capture when (almost) a whole output interval has passed since the last capture; the
        // tolerance keeps a 60 Hz take locked to every second frame of a 120 Hz render loop.
        if (t.lastCapture >= 0 && elapsed - t.lastCapture < interval * 0.75) return;
        var target = mc.gameRenderer.mainRenderTarget();
        if (target.width != t.width || target.height != t.height) {
            t.error = "Window changed during recording";
            t.stopping = true;
            return;
        }
        if (t.lastCapture >= 0 && elapsed - t.lastCapture > interval * 1.5) t.missedSlots += (int) Math.round((elapsed - t.lastCapture) / interval) - 1;
        GpuBuffer buffer = t.buffers.pollFirst();
        byte[] bytes = t.free.poll();
        if (buffer == null || bytes == null) {
            // Encoder/readback backlog: say so instead of stalling the game or repeating a frame.
            if (buffer != null) t.buffers.addLast(buffer);
            if (bytes != null) t.free.offer(bytes);
            t.dropped++;
            return;
        }
        t.lastCapture = elapsed;
        final double captured = elapsed;
        RenderSystem.getDevice().createCommandEncoder().copyTextureToBuffer(target.getColorTexture(), buffer, 0L, () -> {
            try (var read = buffer.map(true, false)) {
                read.data().get(0, bytes, 0, bytes.length);
                if (!t.queue.offer(new Frame(bytes, captured))) {
                    t.dropped++;
                    t.free.offer(bytes);
                }
            } catch (Exception e) {
                t.error = e.toString();
                t.stopping = true;
                t.free.offer(bytes);
            } finally {
                t.buffers.addLast(buffer);
            }
        }, 0);
    }

    private record Frame(byte[] bytes, double captured) {}

    private static final class Take {
        final Path file;
        final Process process;
        final OutputStream output;
        final int fps, seconds, width, height;
        final long start = System.nanoTime();
        final long startedEpochMs = System.currentTimeMillis();
        final ArrayDeque<GpuBuffer> buffers = new ArrayDeque<>();
        final ArrayBlockingQueue<byte[]> free = new ArrayBlockingQueue<>(POOL);
        final ArrayBlockingQueue<Frame> queue = new ArrayBlockingQueue<>(POOL);
        final List<Double> times = java.util.Collections.synchronizedList(new ArrayList<>());
        final List<JsonObject> marks = java.util.Collections.synchronizedList(new ArrayList<>());
        final Thread writer;
        double lastCapture = -1;
        volatile int written, dropped, missedSlots, rendered;
        volatile boolean stopping, writerDone;
        volatile String error;

        Take(Path f, Process p, int fps, int seconds, int width, int height) {
            file = f;
            process = p;
            output = new BufferedOutputStream(p.getOutputStream(), 1 << 22);
            this.fps = fps;
            this.seconds = seconds;
            this.width = width;
            this.height = height;
            long size = (long) width * height * 4;
            for (int i = 0; i < POOL; i++) {
                buffers.addLast(RenderSystem.getDevice().createBuffer(() -> "Overworld video readback", GpuBuffer.USAGE_MAP_READ | GpuBuffer.USAGE_COPY_DST, size));
                free.offer(new byte[(int) size]);
            }
            writer = new Thread(() -> {
                try {
                    while (true) {
                        Frame frame = queue.poll(50, TimeUnit.MILLISECONDS);
                        if (frame == null) {
                            if (stopping && queue.isEmpty()) break;
                            continue;
                        }
                        output.write(frame.bytes);
                        times.add(frame.captured);
                        written++;
                        free.offer(frame.bytes);
                    }
                } catch (Exception e) {
                    error = e.toString();
                    stopping = true;
                } finally {
                    writerDone = true;
                }
            }, "video writer");
            writer.setDaemon(true);
            writer.start();
        }

        JsonObject status(boolean full) {
            var j = new JsonObject();
            j.addProperty("path", file.toString());
            j.addProperty("frames", written);
            j.addProperty("fps", fps);
            j.addProperty("width", width);
            j.addProperty("height", height);
            j.addProperty("startedEpochMs", startedEpochMs);
            j.addProperty("clock", Math.round((System.nanoTime() - start) / 1e4) / 1e5);
            synchronized (marks) {
                var list = new JsonArray();
                for (JsonObject mark : marks) list.add(mark.deepCopy());
                j.add("marks", list);
            }
            j.addProperty("renderedFrames", rendered);
            j.addProperty("dropped", dropped);
            j.addProperty("missedSlots", missedSlots);
            j.addProperty("duplicatesInserted", 0);
            j.addProperty("error", error);
            synchronized (times) {
                double span = times.size() > 1 ? times.get(times.size() - 1) - times.get(0) : 0, maxGap = 0;
                for (int i = 1; i < times.size(); i++) maxGap = Math.max(maxGap, times.get(i) - times.get(i - 1));
                double actual = span > 0 ? (times.size() - 1) / span : 0;
                j.addProperty("wallSeconds", span);
                j.addProperty("freshFramesPerSecond", actual);
                j.addProperty("maxCaptureGapSeconds", maxGap);
                j.addProperty("validRealtime", times.size() > 2 && actual >= fps * .98 && maxGap <= 1.6 / fps && dropped == 0 && missedSlots == 0 && error == null);
                if (full) {
                    var array = new JsonArray();
                    for (double t : times) array.add(Math.round(t * 1e5) / 1e5);
                    j.add("captureTimes", array);
                }
            }
            j.addProperty("colorMatrix", "bt709");
            j.addProperty("timing", "Frames are written in capture order at the nominal rate. captureTimes are the real wall-clock seconds; validRealtime=false means file time differs from wall time.");
            return j;
        }

        CompletableFuture<JsonObject> finish() {
            return CompletableFuture.supplyAsync(() -> {
                try {
                    // In-flight fenced readbacks complete on the render thread within a few frames.
                    Thread.sleep(250);
                    writer.join(20000);
                    if (!writerDone) throw new IOException("Encoder queue timed out");
                    output.close();
                    if (!process.waitFor(30, TimeUnit.SECONDS) || process.exitValue() != 0) throw new IOException("Encoder failed or timed out");
                    Files.writeString(Path.of(file + ".json"), status(true).toString());
                    Minecraft.getInstance().execute(() -> { for (GpuBuffer b : buffers) b.close(); buffers.clear(); });
                    return status(true);
                } catch (Exception e) {
                    process.destroyForcibly();
                    throw new CompletionException(e);
                }
            });
        }
    }
}
