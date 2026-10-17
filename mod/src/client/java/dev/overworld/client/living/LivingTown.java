package dev.overworld.client.living;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.overworld.Overworld;
import dev.overworld.client.ClientEnv;
import dev.overworld.living.LivingWorld;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import net.minecraft.core.BlockPos;

/**
 * The town as the backend records it, shown in the world: each ask's marker (the player's words and
 * a lantern that is dark while the work goes on, lit when it is live, red when its checks failed) and
 * the board at the gate. Both are redrawn only when the record changes. Until a backend has spoken,
 * the places come from the town's own places file, so a place can be aimed at with nothing connected.
 */
public final class LivingTown {
    private static volatile JsonObject town = new JsonObject();
    private static JsonObject places;
    private static long placesStamp = -1;
    private static final Map<String, String> SHOWN = new HashMap<>();
    private static String boardShown = "";
    /** A place whose marker is still the player's own draft, until the record shows the ask. */
    static String draftPlace;
    private LivingTown() {}

    static void set(JsonObject value) { town = value == null ? new JsonObject() : value; }

    /** The record, or (with no backend yet) just the places file. Client thread. */
    public static JsonObject town() {
        JsonObject t = town;
        if (t.has("places")) return t;
        String file = ClientEnv.raw("OVERWORLD_PLACES");
        if (file == null) return t;
        try {
            Path path = Path.of(file);
            long stamp = Files.exists(path) ? Files.getLastModifiedTime(path).toMillis() : 0;
            if (stamp != placesStamp) { placesStamp = stamp; places = stamp == 0 ? null : JsonParser.parseString(Files.readString(path)).getAsJsonObject(); }
        } catch (Exception e) { Overworld.LOGGER.warn("Town places file could not be read: {}", e.getMessage()); places = null; }
        return places == null ? t : places;
    }

    public static JsonObject place(JsonObject t, String id) {
        if (t.has("places")) for (JsonElement el : t.getAsJsonArray("places")) if (el.getAsJsonObject().get("id").getAsString().equals(id)) return el.getAsJsonObject();
        return null;
    }
    public static double[] spot(JsonObject t, String key) {
        if (!t.has(key) || !t.get(key).isJsonArray()) return null;
        JsonArray a = t.getAsJsonArray(key);
        return new double[] {a.get(0).getAsDouble(), a.get(1).getAsDouble(), a.get(2).getAsDouble()};
    }
    /** The place a block belongs to when aimed at: its aim boxes, else its site. */
    public static JsonObject placeAt(JsonObject t, BlockPos pos) {
        if (!t.has("places")) return null;
        // a place's own marker stands for the place (so you can ask again by aiming at it)
        for (JsonElement el : t.getAsJsonArray("places")) {
            JsonObject place = el.getAsJsonObject();
            if (!place.has("stake")) continue;
            JsonArray s = place.getAsJsonArray("stake");
            if (pos.getX() == s.get(0).getAsInt() && pos.getZ() == s.get(2).getAsInt() && pos.getY() >= s.get(1).getAsInt() && pos.getY() <= s.get(1).getAsInt() + 2) return place;
        }
        for (String key : new String[] {"aim", "boxes"}) for (JsonElement el : t.getAsJsonArray("places")) {
            JsonObject place = el.getAsJsonObject();
            if (!place.has(key)) continue;
            for (JsonElement b : place.getAsJsonArray(key)) {
                JsonArray box = b.getAsJsonArray();
                if (pos.getX() >= box.get(0).getAsInt() && pos.getX() <= box.get(3).getAsInt() && pos.getY() >= box.get(1).getAsInt() && pos.getY() <= box.get(4).getAsInt() && pos.getZ() >= box.get(2).getAsInt() && pos.getZ() <= box.get(5).getAsInt()) return place;
            }
        }
        return null;
    }
    /** The ask that speaks for a place: the newest one made there. */
    public static JsonObject askAt(JsonObject t, String placeId) {
        JsonObject latest = null;
        if (t.has("asks")) for (JsonElement el : t.getAsJsonArray("asks")) { JsonObject ask = el.getAsJsonObject(); if (ask.get("place").getAsString().equals(placeId)) latest = ask; }
        return latest;
    }

    /** Every ten ticks: bring the markers and the board in line with the record. */
    static void tick() {
        if (!LivingWorld.running()) { SHOWN.clear(); boardShown = ""; return; }
        JsonObject t = town;
        if (!t.has("places")) return;
        Set<String> wanted = new HashSet<>();
        for (JsonElement el : t.getAsJsonArray("places")) {
            JsonObject place = el.getAsJsonObject();
            String id = place.get("id").getAsString();
            JsonObject ask = askAt(t, id);
            if (ask == null || !place.has("stake")) continue;
            wanted.add(id);
            String lamp = ask.has("lamp") ? ask.get("lamp").getAsString() : "off", text = ask.get("text").getAsString(), sig = text + "|" + lamp;
            if (sig.equals(SHOWN.get(id))) continue;
            if (id.equals(draftPlace)) { JsonObject gone = new JsonObject(); gone.addProperty("op", "stake.remove"); gone.addProperty("ask", "draft"); LivingWorld.submit(gone); draftPlace = null; }
            JsonObject op = new JsonObject();
            op.addProperty("op", "stake"); op.addProperty("ask", id); op.add("at", place.get("stake")); op.addProperty("text", text); op.addProperty("lamp", lamp);
            LivingWorld.submit(op);
            SHOWN.put(id, sig);
        }
        for (var it = SHOWN.keySet().iterator(); it.hasNext();) {
            String id = it.next();
            if (wanted.contains(id)) continue;
            JsonObject gone = new JsonObject(); gone.addProperty("op", "stake.remove"); gone.addProperty("ask", id); LivingWorld.submit(gone);
            it.remove();
        }
        if (t.has("board") && t.get("board").isJsonObject()) {
            JsonObject board = t.getAsJsonObject("board");
            String text = boardText(t);
            if (!text.equals(boardShown)) {
                // The board gives its top-left corner; a text display hangs from the middle of its bottom edge, so the
                // words are measured here (40 pixels to the block at scale 1, ten pixels a line) and hung to fit.
                var font = net.minecraft.client.Minecraft.getInstance().font;
                float scale = board.has("scale") ? board.get("scale").getAsFloat() : 0.5f;
                int width = board.has("width") ? board.get("width").getAsInt() : 360, widest = 1, lines = 0;
                for (String line : text.split("\n", -1)) { int w = Math.min(width, font.width(line)); widest = Math.max(widest, w); lines += Math.max(1, (int) Math.ceil(font.width(line) / (double) width)); }
                JsonArray corner = board.getAsJsonArray("at"), at = new JsonArray();
                float yaw = board.has("yaw") ? board.get("yaw").getAsFloat() : 0f;
                double along = widest * scale / 80.0, rad = Math.toRadians(yaw);
                at.add(corner.get(0).getAsDouble() + Math.cos(rad) * along); at.add(corner.get(1).getAsDouble() - lines * 10 * scale / 40.0); at.add(corner.get(2).getAsDouble() + Math.sin(rad) * along);
                JsonObject op = new JsonObject();
                op.addProperty("op", "board"); op.add("at", at); op.addProperty("yaw", yaw); op.addProperty("scale", scale); op.addProperty("width", width); op.addProperty("text", text);
                LivingWorld.submit(op);
                boardShown = text;
            }
        }
    }

    /** One entry per part, from the record alone: what was asked for, then what is true of it and who wrote it and its checks. */
    static String boardText(JsonObject t) {
        StringBuilder out = new StringBuilder(t.has("boardTitle") ? t.get("boardTitle").getAsString() : "THE TOWN");
        if (t.has("parts")) for (JsonElement el : t.getAsJsonArray("parts")) {
            JsonObject p = el.getAsJsonObject();
            out.append("\n\n").append(str(p, "title", str(p, "name", "")).toUpperCase(java.util.Locale.ROOT));
            String state = str(p, "state", ""), who = str(p, "who", "");
            out.append("\n").append(state).append(who.isEmpty() ? "" : " · " + who);
        }
        return out.toString();
    }
    private static String str(JsonObject o, String key, String fallback) { return o.has(key) && !o.get(key).isJsonNull() ? o.get(key).getAsString() : fallback; }
}
