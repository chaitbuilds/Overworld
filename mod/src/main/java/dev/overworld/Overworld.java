package dev.overworld;

import dev.overworld.block.ModBlocks;
import dev.overworld.block.entity.ModBlockEntities;
import dev.overworld.entity.ModEntities;
import dev.overworld.world.WorldRules;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.minecraft.resources.Identifier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Common (both sides) entrypoint: registries (the monitor block and its block entity, the agent and
 * deck entity types), the town's world rules and the living town ({@link dev.overworld.living.LivingWorld}).
 * Client features are wired in {@code dev.overworld.client.ClientFeatures}.
 */
public class Overworld implements ModInitializer {
	public static final String MOD_ID = "overworld";
	public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

	@Override
	public void onInitialize() {
		ModBlocks.init();
		ModBlockEntities.init();
		ModEntities.init();
		// The town's setting is authored by the backend; its world stays calm and exactly as built.
		ServerLifecycleEvents.SERVER_STARTED.register(WorldRules::applyRules);
		dev.overworld.living.LivingWorld.init();
		LOGGER.info("Overworld common init done ({} blocks, cast {})", ModBlocks.all().size(), Cast.ids());
	}

	public static Identifier id(String path) {
		return Identifier.fromNamespaceAndPath(MOD_ID, path);
	}
}
