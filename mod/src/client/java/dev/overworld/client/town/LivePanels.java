package dev.overworld.client.town;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.overworld.client.dev.DevBridge;
import dev.overworld.client.living.LivingTown;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.Identifier;

/**
 * Live screens on monitor panels. The town's record names a panel (by its bottom-left block, as a viewer sees it) and
 * the helper's screen it shows: a real product's page in a hidden browser (tools/codetown/screen.mjs --wall). The panel
 * draws that page's newest picture (MonitorRenderer); a pointer and presses sent here go to the page through
 * {@link LiveWalls}, and the pointer is drawn on the panel where it is. Nothing here decides what a page shows.
 */
public final class LivePanels {
    public static final class Pointer { public volatile boolean shown; public volatile float u, v; }
    private static final Map<String, Pointer> POINTERS = new ConcurrentHashMap<>();
    private static JsonObject seenTown;
    private static Map<Long, String> byOrigin = new HashMap<>();
    /** What the panel renderer last found (for the dev bridge): the panel's origin, the screen named there, whether it had a picture. */
    private static volatile String lastLook = "never";
    public static volatile long extracts; public static volatile String lastExtract = "none";
    public static void extracted(BlockPos pos, boolean origin, int w, int h) { extracts++; lastExtract = pos.toShortString() + (origin ? " origin " + w + "x" + h : " not origin"); }
    public static void looked(BlockPos origin, String screen, boolean picture) { lastLook = origin.toShortString() + " -> " + screen + (picture ? " (picture)" : " (no picture)"); }
    private LivePanels() {}

    /** The screen a panel shows, by the panel's origin block; null when it shows none. Client thread. */
    public static String screenAt(BlockPos origin) {
        JsonObject t = LivingTown.town();
        if (t != seenTown) {
            seenTown = t;
            Map<Long, String> m = new HashMap<>();
            if (t.has("screens") && t.get("screens").isJsonArray()) for (JsonElement el : t.getAsJsonArray("screens")) {
                JsonObject o = el.getAsJsonObject();
                JsonArray at = o.getAsJsonArray("at");
                m.put(BlockPos.asLong(at.get(0).getAsInt(), at.get(1).getAsInt(), at.get(2).getAsInt()), o.get("id").getAsString());
            }
            byOrigin = m;
        }
        return byOrigin.get(origin.asLong());
    }
    /** The newest picture of the page a panel shows, or null (no screen named there, or no picture yet). */
    public static Identifier texture(String screen) { return screen == null ? null : LiveWalls.texture(screen, null); }
    public static Pointer pointer(String screen) { return screen == null ? null : POINTERS.get(screen); }

    public static void init() {
        // a monitor panel is drawn for its live screen
        net.minecraft.client.renderer.blockentity.BlockEntityRenderers.register(dev.overworld.block.entity.ModBlockEntities.MONITOR, ctx -> new dev.overworld.client.monitor.MonitorRenderer());
        DevBridge.register("dev.town.panel", 10_000, "{screen, pointer:[u,v]} | {screen, press:[u,v]} | {screen, release:true} | {screen, key:code, down:bool} | {screen, text} | {screen, wheel:[u,v,dy]} | {screen, hidePointer:true} - use the live page on a monitor panel: input goes to the page through the game, the pointer is drawn on the panel; u,v are fractions of the page", (request, mc) -> DevBridge.onClient(mc, () -> {
            String screen = request.has("screen") ? request.get("screen").getAsString() : "";
            if (!screen.matches("[A-Za-z0-9_-]{1,64}")) throw new DevBridge.DevException("screen: the id of a live screen");
            Pointer p = POINTERS.computeIfAbsent(screen, k -> new Pointer());
            if (request.has("pointer")) { JsonArray a = request.getAsJsonArray("pointer"); p.u = a.get(0).getAsFloat(); p.v = a.get(1).getAsFloat(); p.shown = true; LiveWalls.mouse(screen, "move", p.u, p.v, 0); }
            if (request.has("press")) { JsonArray a = request.getAsJsonArray("press"); p.u = a.get(0).getAsFloat(); p.v = a.get(1).getAsFloat(); p.shown = true; LiveWalls.mouse(screen, "down", p.u, p.v, 0); }
            if (request.has("release") && request.get("release").getAsBoolean()) LiveWalls.mouse(screen, "up", p.u, p.v, 0);
            if (request.has("wheel")) { JsonArray a = request.getAsJsonArray("wheel"); LiveWalls.mouse(screen, "wheel", a.get(0).getAsDouble(), a.get(1).getAsDouble(), a.get(2).getAsDouble()); }
            if (request.has("key")) LiveWalls.key(screen, request.get("key").getAsString(), !request.has("down") || request.get("down").getAsBoolean());
            if (request.has("text")) { JsonObject o = new JsonObject(); o.addProperty("type", "text"); o.addProperty("text", request.get("text").getAsString()); LiveWalls.input(screen, o); }
            if (request.has("hidePointer") && request.get("hidePointer").getAsBoolean()) p.shown = false;
            JsonObject out = new JsonObject();
            out.addProperty("ready", LiveWalls.ready(screen)); out.addProperty("reachable", LiveWalls.reachable()); out.addProperty("pointer", p.shown);
            out.addProperty("texture", String.valueOf(LiveWalls.texture(screen, null))); out.addProperty("panels", byOrigin.size()); out.addProperty("lastLook", lastLook); out.addProperty("extracts", extracts); out.addProperty("lastExtract", lastExtract);
            JsonObject t = LivingTown.town(); out.addProperty("townHasScreens", t.has("screens")); out.addProperty("townKeys", String.join(",", t.keySet()));
            return out;
        }));
    }
}
