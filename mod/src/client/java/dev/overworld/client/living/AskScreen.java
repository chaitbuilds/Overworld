package dev.overworld.client.living;

import com.google.gson.JsonObject;
import com.mojang.blaze3d.platform.InputConstants;
import dev.overworld.client.foreman.Foreman;
import dev.overworld.client.town.TownFeature;
import dev.overworld.living.LivingWorld;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.client.input.CharacterEvent;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.core.BlockPos;
import net.minecraft.network.chat.Component;

/**
 * Asking for something: you aimed a sign at a place, now you type what you want there. The words
 * appear on the place's own marker as you type; Enter sends them to the town's backend exactly as
 * typed, Escape takes the marker away. This screen draws nothing over the world but one line of
 * your own words (and not even that with a clean HUD).
 */
public final class AskScreen extends Screen {
    private final JsonObject place;
    private final BlockPos aimed;
    private final StringBuilder words = new StringBuilder();
    private boolean sent;

    public AskScreen(JsonObject place, BlockPos aimed) {
        super(Component.literal("Ask"));
        this.place = place; this.aimed = aimed;
    }

    public String words() { return words.toString(); }
    public String placeId() { return place.get("id").getAsString(); }

    @Override protected void init() { preview(); }
    @Override public boolean isPauseScreen() { return false; }
    @Override public void extractBackground(GuiGraphicsExtractor g, int mouseX, int mouseY, float delta) {}

    @Override public void extractRenderState(GuiGraphicsExtractor g, int mouseX, int mouseY, float delta) {
        if (TownFeature.cleanHud) return;
        String line = words + "_";
        int w = font.width(line) + 20, x = (width - w) / 2, y = height - 46;
        g.fill(x, y, x + w, y + 20, 0xB8101418);
        g.text(font, line, x + 10, y + 6, 0xFFFFFFFF, false);
    }

    @Override public boolean charTyped(CharacterEvent e) {
        if (sent || e.codepoint() < 32 || words.length() >= 100) return false;
        words.append(e.codepointAsString());
        preview();
        return true;
    }

    @Override public boolean keyPressed(KeyEvent e) {
        if (e.isEscape()) { if (!sent) drop(); onClose(); return true; }
        if (sent) return true;
        if (e.key() == InputConstants.KEY_BACKSPACE) { if (words.length() > 0) { words.setLength(words.length() - 1); preview(); } return true; }
        if (e.key() == InputConstants.KEY_RETURN || e.key() == InputConstants.KEY_NUMPADENTER) { confirm(); return true; }
        return true;
    }

    /** The marker, with the words so far. */
    private void preview() {
        if (!place.has("stake")) return;
        JsonObject op = new JsonObject();
        op.addProperty("op", "stake"); op.addProperty("ask", "draft"); op.add("at", place.get("stake")); op.addProperty("text", words + "_"); op.addProperty("lamp", "off");
        LivingWorld.submit(op);
    }
    private void drop() {
        JsonObject op = new JsonObject(); op.addProperty("op", "stake.remove"); op.addProperty("ask", "draft");
        LivingWorld.submit(op);
    }

    private void confirm() {
        String text = words.toString().trim();
        if (text.isEmpty()) return;
        if (!Foreman.connected()) { LivingFeature.toast("The town's backend is not running."); return; }
        sent = true;
        JsonObject op = new JsonObject();
        op.addProperty("op", "stake"); op.addProperty("ask", "draft"); op.add("at", place.get("stake")); op.addProperty("text", text); op.addProperty("lamp", "off");
        LivingWorld.submit(op);
        JsonObject payload = new JsonObject();
        payload.addProperty("text", text); payload.addProperty("place", placeId());
        com.google.gson.JsonArray at = new com.google.gson.JsonArray(); at.add(aimed.getX()); at.add(aimed.getY()); at.add(aimed.getZ()); payload.add("at", at);
        LivingTown.draftPlace = placeId();
        Foreman.send("town.ask", payload).whenComplete((ack, err) -> {
            if (err == null && ack.ok()) return;
            LivingTown.draftPlace = null; drop();
            LivingFeature.toast(err != null ? "The town's backend did not answer." : ack.error() == null ? "That cannot be asked for here." : ack.error());
        });
        onClose();
    }
}
