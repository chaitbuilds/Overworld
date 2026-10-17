package dev.overworld.client;

import dev.overworld.Overworld;
import dev.overworld.client.foreman.ForemanFeature;

/**
 * The one place that wires every client feature. Each feature lives in its own package with an
 * {@code init()} that registers everything it needs (renderers, screens, DevBridge commands, Foreman
 * listeners). Order matters only for {@link ForemanFeature} (first: everything else may read the
 * state model).
 */
public final class ClientFeatures {
	private ClientFeatures() {
	}

	public static void init() {
		ForemanFeature.init();   // link + state model (dev.foreman, dev.state.foreman)
		dev.overworld.client.town.TownFeature.init();   // the live walls, the clean HUD and site tools
		dev.overworld.client.living.LivingFeature.init();   // parts of the town carried out in the world (dev.living)
		Overworld.LOGGER.info("Overworld client features initialised");
	}
}
