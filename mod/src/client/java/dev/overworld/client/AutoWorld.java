package dev.overworld.client;

import dev.overworld.Overworld;
import java.util.List;
import java.util.Optional;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.client.screen.v1.ScreenEvents;
import net.minecraft.client.Minecraft;
import dev.overworld.client.mixin.BackupConfirmScreenAccessor;
import net.minecraft.client.gui.screens.AccessibilityOnboardingScreen;
import net.minecraft.client.gui.screens.BackupConfirmScreen;
import net.minecraft.client.gui.screens.TitleScreen;
import net.minecraft.core.Holder;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.HolderSet;
import net.minecraft.core.registries.Registries;
import net.minecraft.world.Difficulty;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.LevelSettings;
import net.minecraft.world.level.WorldDataConfiguration;
import net.minecraft.world.level.biome.Biome;
import net.minecraft.world.level.biome.Biomes;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.levelgen.FlatLevelSource;
import net.minecraft.world.level.levelgen.WorldDimensions;
import net.minecraft.world.level.levelgen.WorldOptions;
import net.minecraft.world.level.levelgen.flat.FlatLayerInfo;
import net.minecraft.world.level.levelgen.flat.FlatLevelGeneratorSettings;
import net.minecraft.world.level.levelgen.presets.WorldPresets;

/**
 * Boots straight into the town's world (OVERWORLD_WORLD) without any clicks: the first time the
 * title screen appears, the world is loaded if it exists, or created (creative, peaceful, superflat
 * grass meadow with no structures/decoration) if it does not. Disable with OVERWORLD_AUTOWORLD=0.
 */
public final class AutoWorld {
	private static final String LEVEL_NAME = ClientEnv.raw("OVERWORLD_WORLD") == null ? "Overworld Meadow" : ClientEnv.raw("OVERWORLD_WORLD");
    private static boolean attempted;
	/** True while AutoWorld itself is opening the world (so its confirm screens may be auto-answered). */
	private static boolean openingHq;

	private AutoWorld() {
	}

	public static void init() {
		if (!ClientEnv.AUTO_WORLD) {
			Overworld.LOGGER.info("AutoWorld disabled (OVERWORLD_AUTOWORLD=0)");
			return;
		}
		ClientPlayConnectionEvents.JOIN.register((handler, sender, client) -> openingHq = false);
		ScreenEvents.AFTER_INIT.register((client, screen, w, h) -> {
			if (openingHq && screen instanceof BackupConfirmScreen backup) {
				// Registry content changed since the world was saved (a block/entity was renamed or removed
				// while developing). Take Fabric's backup and load it instead of waiting forever on
				// "Missing content detected!" in an unattended run.
				openingHq = false;
				Overworld.LOGGER.warn("AutoWorld: '{}' needs confirmation ({}); making a backup and loading it",
					LEVEL_NAME, screen.getTitle().getString());
				client.execute(() -> ((BackupConfirmScreenAccessor) backup).overworld$onProceed().proceed(true, false));
				return;
			}
			if (attempted) {
				return;
			}
			if (screen instanceof TitleScreen || screen instanceof AccessibilityOnboardingScreen) {
				attempted = true;
				// Never switch screens from inside another screen's init.
				client.execute(() -> openOrCreate(client));
			}
		});
	}

	public static void openOrCreate(Minecraft mc) {
        try {
            if (!LEVEL_NAME.matches("[A-Za-z0-9 _-]{1,80}")) throw new IllegalArgumentException("OVERWORLD_WORLD must be a simple local save name");
			if (mc.getLevelSource().levelExists(LEVEL_NAME)) {
				Overworld.LOGGER.info("AutoWorld: loading existing world '{}'", LEVEL_NAME);
				openingHq = true;
				mc.createWorldOpenFlows().openWorld(LEVEL_NAME, () -> mc.gui.setScreen(new TitleScreen()));
			} else {
				Overworld.LOGGER.info("AutoWorld: creating world '{}'", LEVEL_NAME);
				LevelSettings settings = new LevelSettings(
					LEVEL_NAME,
					GameType.CREATIVE,
					new LevelSettings.DifficultySettings(Difficulty.PEACEFUL, false, false),
					true,
					WorldDataConfiguration.DEFAULT
				);
				// OVERWORLD_WORLD_SEED=<number>: a normal overworld from that seed (real terrain: hills, rivers, forest)
				// instead of the flat meadow. Only read when the world is first created.
				String seed = ClientEnv.raw("OVERWORLD_WORLD_SEED");
				if (seed != null && seed.matches("-?[0-9]{1,18}")) {
					WorldOptions natural = new WorldOptions(Long.parseLong(seed), false, false);
					mc.createWorldOpenFlows().createFreshLevel(LEVEL_NAME, settings, natural, WorldPresets::createNormalWorldDimensions, new TitleScreen());
					return;
				}
				WorldOptions options = new WorldOptions("overworld-meadow-v1".hashCode(), false, false);
				mc.createWorldOpenFlows().createFreshLevel(LEVEL_NAME, settings, options, AutoWorld::meadowDimensions, new TitleScreen());
			}
		} catch (Exception e) {
			Overworld.LOGGER.error("AutoWorld failed; staying on the title screen", e);
			mc.gui.setScreen(new TitleScreen());
		}
	}

	/** Normal dimensions, with the overworld replaced by a flat plains meadow (grass top at y=64). */
	private static WorldDimensions meadowDimensions(HolderLookup.Provider registries) {
		Holder<Biome> plains = registries.lookupOrThrow(Registries.BIOME).getOrThrow(Biomes.PLAINS);
		FlatLevelGeneratorSettings base = new FlatLevelGeneratorSettings(Optional.of(HolderSet.empty()), plains, List.of());
		// y=-64 bedrock, stone up to 60, dirt 61..63, grass 64.
		List<FlatLayerInfo> layers = List.of(
			new FlatLayerInfo(1, Blocks.BEDROCK),
			new FlatLayerInfo(124, Blocks.STONE),
			new FlatLayerInfo(3, Blocks.DIRT),
			new FlatLayerInfo(1, Blocks.GRASS_BLOCK)
		);
		FlatLevelGeneratorSettings flat = base.withBiomeAndLayers(layers, Optional.of(HolderSet.empty()), plains);
		return WorldPresets.createNormalWorldDimensions(registries).replaceOverworldGenerator(registries, new FlatLevelSource(flat));
	}
}
