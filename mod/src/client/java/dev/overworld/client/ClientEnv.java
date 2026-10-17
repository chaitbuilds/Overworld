package dev.overworld.client;

import java.nio.file.Path;
import java.util.Locale;
import net.minecraft.client.Minecraft;

/**
 * Environment switches for the client. All are read from environment variables (or the
 * equivalent -D system property, e.g. -Doverworld.mute=0) once at startup.
 *
 * <pre>
 * OVERWORLD_DEV_PORT   DevBridge port (default 7879), 127.0.0.1 only
 * OVERWORLD_DEV        0 disables the DevBridge (default on)
 * OVERWORLD_MUTE       1 forces master+music volume to 0 at startup; 0 (default) keeps your volume
 * OVERWORLD_FOCUS      0 (default) = the window opens WITHOUT taking focus; 1 = normal focus
 * OVERWORLD_AUTOWORLD  1 (default) = create/load the OVERWORLD_WORLD world on startup; 0 = title screen
 * OVERWORLD_SHOTS_DIR  where dev.screenshot writes PNGs (default &lt;repo&gt;/artifacts/shots)
 * </pre>
 */
public final class ClientEnv {
	private ClientEnv() {
	}

	public static final int DEV_PORT = intValue("OVERWORLD_DEV_PORT", 7879);
	public static final boolean DEV_BRIDGE = flag("OVERWORLD_DEV", false);
	public static final boolean MUTE = flag("OVERWORLD_MUTE", false);
	public static final boolean TAKE_FOCUS = flag("OVERWORLD_FOCUS", false);
	public static final boolean AUTO_WORLD = flag("OVERWORLD_AUTOWORLD", true);

	public static String raw(String envName) {
		String prop = System.getProperty(envName.toLowerCase(Locale.ROOT).replace('_', '.'));
		if (prop != null && !prop.isBlank()) {
			return prop.trim();
		}
		String env = System.getenv(envName);
		return env == null || env.isBlank() ? null : env.trim();
	}

	public static boolean flag(String envName, boolean def) {
		String v = raw(envName);
		if (v == null) {
			return def;
		}
		return switch (v.toLowerCase(Locale.ROOT)) {
			case "1", "true", "yes", "on" -> true;
			case "0", "false", "no", "off" -> false;
			default -> def;
		};
	}

	public static int intValue(String envName, int def) {
		String v = raw(envName);
		if (v == null) {
			return def;
		}
		try {
			return Integer.parseInt(v);
		} catch (NumberFormatException e) {
			return def;
		}
	}

	/** Directory screenshots are written to: OVERWORLD_SHOTS_DIR, else overworld-shots in the game directory. */
	public static Path shotsDir() {
		String override = raw("OVERWORLD_SHOTS_DIR");
		if (override != null) {
			return Path.of(override).toAbsolutePath().normalize();
		}
		return Minecraft.getInstance().gameDirectory.toPath().toAbsolutePath().normalize().resolve("overworld-shots");
	}
}
