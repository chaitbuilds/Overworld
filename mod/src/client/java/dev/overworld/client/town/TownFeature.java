package dev.overworld.client.town;

import com.google.gson.JsonObject;
import dev.overworld.client.dev.DevBridge;
import dev.overworld.client.dev.Fields;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.minecraft.client.Minecraft;

/**
 * The town at run time: its site tools ({@link TownDev}), the live screens on its monitor panels
 * ({@link LivePanels}, fed by {@link LiveWalls}) and a clean HUD for recording.
 */
public final class TownFeature {
    /** Recording: the hand and what it holds stay in the picture; the hotbar, crosshair, bars and messages do not. */
    public static volatile boolean cleanHud;
    private TownFeature() {}

    public static void init() {
        TownDev.init();
        LivePanels.init();
        ClientTickEvents.END_CLIENT_TICK.register(TownFeature::tick);
        var hud = net.fabricmc.fabric.api.client.rendering.v1.hud.VanillaHudElements.class;
        for (var field : hud.getFields()) {
            try {
                if (field.get(null) instanceof net.minecraft.resources.Identifier id) net.fabricmc.fabric.api.client.rendering.v1.hud.HudElementRegistry.replaceElement(id, original -> (g, delta) -> { if (!cleanHud) original.extractRenderState(g, delta); });
            } catch (Exception e) { dev.overworld.Overworld.LOGGER.warn("Could not wrap HUD element {}: {}", field.getName(), e.getMessage()); }
        }
        DevBridge.register("dev.town.hud", 5_000, "{cleanHud:bool} - recording: keep the hand in the picture and leave every HUD element out", (request, mc) -> DevBridge.onClient(mc, () -> { Fields f = Fields.of(request); cleanHud = f.optBool("cleanHud", cleanHud);
            // session only: how far the world is drawn and simulated while recording (the saved options are not changed)
            if (request.has("renderDistance")) mc.options.renderDistance().set(f.optInt("renderDistance", 10, 4, 32));
            if (request.has("simulationDistance")) mc.options.simulationDistance().set(f.optInt("simulationDistance", 6, 5, 32));
            if (request.has("maxFps")) mc.options.framerateLimit().set(f.optInt("maxFps", 60, 30, 260));
            JsonObject o = new JsonObject(); o.addProperty("cleanHud", cleanHud); o.addProperty("renderDistance", mc.options.getEffectiveRenderDistance()); o.addProperty("maxFps", mc.options.framerateLimit().get()); return o; }));
    }

    private static void tick(Minecraft mc) {
        if (mc.level == null || mc.player == null) return;
        LiveWalls.tick();
    }
}
