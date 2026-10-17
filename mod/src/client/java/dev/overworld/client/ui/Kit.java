package dev.overworld.client.ui;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.overworld.Overworld;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import net.minecraft.resources.Identifier;

/**
 * The GUI kit sprites ({@code overworld:kit/<name>} in the vanilla GUI atlas; nine-slice metadata
 * ships with the stretchable ones). Content padding per sprite comes from {@code gui/kit.json}.
 * Draw them in the world with {@link WorldUi}.
 */
public final class Kit {
	public static final Identifier NAMEPLATE = id("nameplate");
	public static final Identifier BUBBLE = id("bubble");
	public static final Identifier BUBBLE_TAIL = id("bubble_tail");

	/** Padding (left, top, right, bottom) between a sprite's edge and its content, from kit.json. */
	public record Padding(int left, int top, int right, int bottom) {
		public static final Padding ZERO = new Padding(0, 0, 0, 0);
	}

	private static final Map<String, Padding> PADDING = new HashMap<>();

	static {
		try (InputStream in = Kit.class.getResourceAsStream("/assets/overworld/gui/kit.json")) {
			if (in != null) {
				JsonObject sprites = JsonParser.parseReader(new InputStreamReader(in, StandardCharsets.UTF_8)).getAsJsonObject().getAsJsonObject("sprites");
				for (var e : sprites.entrySet()) {
					JsonObject s = e.getValue().getAsJsonObject();
					if (s.has("content_padding")) {
						JsonObject p = s.getAsJsonObject("content_padding");
						PADDING.put(e.getKey(), new Padding(p.get("left").getAsInt(), p.get("top").getAsInt(), p.get("right").getAsInt(), p.get("bottom").getAsInt()));
					}
				}
			}
		} catch (Exception e) {
			Overworld.LOGGER.warn("Kit: could not read gui/kit.json", e);
		}
	}

	private Kit() {
	}

	public static Identifier id(String name) {
		return Overworld.id("kit/" + name);
	}

	public static Padding padding(String spriteName) {
		return PADDING.getOrDefault(spriteName, Padding.ZERO);
	}

	/** 7x7 status dot by family (idle thinking working waiting error done); {@code halo} = 11x11 with glow. */
	public static Identifier dot(String family, boolean halo) {
		return id("dot_" + family.toLowerCase(Locale.ROOT) + (halo ? "_halo" : ""));
	}
}
