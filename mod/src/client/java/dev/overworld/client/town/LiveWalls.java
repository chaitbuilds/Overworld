package dev.overworld.client.town;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.blaze3d.platform.NativeImage;
import dev.overworld.Overworld;
import dev.overworld.client.ClientEnv;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import net.minecraft.client.Minecraft;
import net.minecraft.resources.Identifier;

/**
 * The live pictures for the town's screens. A local helper (tools/codetown/screen.mjs --wall) keeps a
 * headless page showing the real product; this class fetches its newest frame for each screen and
 * sends the player's keys and pointer back. Loopback only (OVERWORLD_SCREEN_PORT). Nothing here
 * decides what is shown: an absent helper simply leaves the panels dark.
 */
public final class LiveWalls {
    public static final int WIDTH = 960, HEIGHT = 540;
    static final class Wall {
        final String id; Identifier texture; LiveTexture gpu;
        volatile long seq = -1; volatile String artifactId; volatile boolean running;
        Wall(String id) { this.id = id; }
    }
    private static final int PORT = ClientEnv.intValue("OVERWORLD_SCREEN_PORT", 0);
    private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(2)).build();
    private static final Map<String, Wall> WALLS = new ConcurrentHashMap<>();
    private static final Executor LATER = CompletableFuture.delayedExecutor(1500, TimeUnit.MILLISECONDS);
    private static long lastPoll;
    private static volatile boolean reachable;
    private LiveWalls() {}

    public static boolean enabled() { return PORT > 0; }
    public static boolean reachable() { return reachable; }
    private static URI uri(String path) { return URI.create("http://127.0.0.1:" + PORT + path); }

    /** Called every client tick: learn which screens the helper has, about once a second. */
    public static void tick() {
        if (!enabled()) return;
        long now = System.currentTimeMillis();
        if (now - lastPoll < 1000) return;
        lastPoll = now;
        HTTP.sendAsync(HttpRequest.newBuilder(uri("/state")).timeout(Duration.ofSeconds(2)).build(), HttpResponse.BodyHandlers.ofString()).thenAccept(response -> {
            if (response.statusCode() != 200) return;
            reachable = true;
            for (var element : JsonParser.parseString(response.body()).getAsJsonObject().getAsJsonArray("screens")) {
                JsonObject screen = element.getAsJsonObject();
                String id = screen.get("id").getAsString();
                if (!id.matches("[A-Za-z0-9_-]{1,64}")) continue;
                Wall wall = WALLS.computeIfAbsent(id, Wall::new);
                wall.artifactId = screen.has("artifactId") && !screen.get("artifactId").isJsonNull() ? screen.get("artifactId").getAsString() : null;
                if (screen.get("seq").getAsLong() < wall.seq) wall.seq = -1;   // the helper restarted
                if (!wall.running) { wall.running = true; fetch(wall); }
            }
        }).exceptionally(error -> { reachable = false; return null; });
    }

    private static void fetch(Wall wall) {
        HTTP.sendAsync(HttpRequest.newBuilder(uri("/frame/" + wall.id + "?after=" + wall.seq)).timeout(Duration.ofSeconds(5)).build(), HttpResponse.BodyHandlers.ofByteArray()).thenAccept(response -> {
            if (response.statusCode() == 200 && response.body().length < 8_000_000) {
                long seq = response.headers().firstValueAsLong("x-seq").orElse(wall.seq + 1);
                NativeImage full;
                try { full = NativeImage.read(response.body()); } catch (Exception e) { throw new IllegalStateException(e); }
                if (full.getWidth() < 320 || full.getWidth() > 1920 || full.getHeight() < 180 || full.getHeight() > 1080) { full.close(); wall.seq = seq; fetch(wall); return; }
                NativeImage half = LiveTexture.half(full), quarter = LiveTexture.half(half);
                wall.seq = seq;
                Minecraft.getInstance().execute(() -> {
                    try {
                        if (wall.gpu == null || wall.gpu.width != full.getWidth() || wall.gpu.height != full.getHeight()) {
                            // a wall's page keeps its size; a new size (a game replaced by a page of text) gets a new texture, and registering it closes the old one
                            wall.gpu = new LiveTexture("Town wall " + wall.id, full.getWidth(), full.getHeight());
                            Identifier id = Overworld.id("town-wall/" + wall.id.toLowerCase(java.util.Locale.ROOT));
                            Minecraft.getInstance().getTextureManager().register(id, wall.gpu);
                            wall.texture = id;
                        }
                        wall.gpu.write(new NativeImage[]{full, half, quarter});
                    } finally { full.close(); half.close(); quarter.close(); }
                });
                fetch(wall);
            } else if (response.statusCode() == 204) fetch(wall);
            else { wall.running = false; }   // the helper no longer has this screen; the next poll restarts it if it returns
        }).exceptionally(error -> { CompletableFuture.runAsync(() -> { wall.running = false; }, LATER); return null; });
    }

    /** The live texture for a screen, if the helper is showing exactly this artifact (or any, when artifactId is null). */
    public static Identifier texture(String screenId, String artifactId) {
        Wall wall = screenId == null ? null : WALLS.get(screenId);
        if (wall == null || wall.texture == null) return null;
        if (artifactId != null && !artifactId.equals(wall.artifactId)) return null;
        return wall.texture;
    }
    /** True when the helper is up and has drawn this screen: its page can take input. */
    public static boolean ready(String screenId) { Wall wall = screenId == null ? null : WALLS.get(screenId); return reachable && wall != null && wall.texture != null && wall.running; }

    /** Send one input event to a screen's page. Fire and forget; order is kept by the single connection. */
    public static void input(String screenId, JsonObject event) {
        if (!enabled() || screenId == null) return;
        HTTP.sendAsync(HttpRequest.newBuilder(uri("/input/" + screenId)).timeout(Duration.ofSeconds(3)).header("content-type", "application/json").POST(HttpRequest.BodyPublishers.ofString(event.toString())).build(), HttpResponse.BodyHandlers.discarding()).exceptionally(error -> null);
    }
    public static void key(String screenId, String code, boolean down) { JsonObject o = new JsonObject(); o.addProperty("type", "key"); o.addProperty("action", down ? "down" : "up"); o.addProperty("code", code); input(screenId, o); }
    public static void mouse(String screenId, String action, double u, double v, double dy) { JsonObject o = new JsonObject(); o.addProperty("type", "mouse"); o.addProperty("action", action); o.addProperty("x", u); o.addProperty("y", v); o.addProperty("dy", dy); input(screenId, o); }
}
