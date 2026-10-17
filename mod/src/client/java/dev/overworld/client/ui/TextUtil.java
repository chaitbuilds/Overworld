package dev.overworld.client.ui;

import java.util.ArrayList;
import java.util.List;
import net.minecraft.client.gui.Font;

/** Text helpers for in-world renderers (nameplates, speech bubbles): ellipsis and wrapping. */
public final class TextUtil {
	public static final String ELLIPSIS = "…";

	private TextUtil() {
	}

	/** {@code s} cut to {@code maxWidth} px with a trailing ellipsis when it does not fit. */
	public static String ellipsize(Font font, String s, int maxWidth) {
		if (s == null) {
			return "";
		}
		if (font.width(s) <= maxWidth) {
			return s;
		}
		int ew = font.width(ELLIPSIS);
		if (maxWidth <= ew) {
			return "";
		}
		return font.plainSubstrByWidth(s, maxWidth - ew).stripTrailing() + ELLIPSIS;
	}

	/** Word-wrap into plain strings (useful for caching/measuring). */
	public static List<String> wrapPlain(Font font, String s, int width) {
		List<String> out = new ArrayList<>();
		for (String para : (s == null ? "" : s).split("\n", -1)) {
			if (para.isEmpty()) {
				out.add("");
				continue;
			}
			font.getSplitter().splitLines(para, Math.max(1, width), net.minecraft.network.chat.Style.EMPTY)
				.forEach(ft -> out.add(ft.getString()));
		}
		return out;
	}
}
