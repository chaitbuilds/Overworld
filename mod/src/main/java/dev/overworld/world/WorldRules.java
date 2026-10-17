package dev.overworld.world;

import net.minecraft.server.MinecraftServer;
import net.minecraft.world.level.gamerules.GameRules;

/**
 * The town's world rules: calm and building-friendly (no day cycle or weather, no mobs, nothing
 * grows or burns over what was built). Applied by {@code Overworld} on every start.
 */
public final class WorldRules {
	private WorldRules() {
	}

	/** Idempotent; applied on every start so rule changes in code reach existing worlds. */
	public static void applyRules(MinecraftServer server) {
		GameRules rules = server.getGameRules();
		rules.set(GameRules.ADVANCE_TIME, false, server);
		rules.set(GameRules.ADVANCE_WEATHER, false, server);
		rules.set(GameRules.KEEP_INVENTORY, true, server);
		rules.set(GameRules.FIRE_SPREAD_RADIUS_AROUND_PLAYER, 0, server);
		rules.set(GameRules.SPAWN_MOBS, false, server);
		rules.set(GameRules.SPAWN_MONSTERS, false, server);
		rules.set(GameRules.SPAWN_PATROLS, false, server);
		rules.set(GameRules.SPAWN_PHANTOMS, false, server);
		rules.set(GameRules.SPAWN_WANDERING_TRADERS, false, server);
		rules.set(GameRules.SPAWN_WARDENS, false, server);
		rules.set(GameRules.MOB_GRIEFING, false, server);
		// Keep what was built exactly as built: no vine growth, no snow layers.
		rules.set(GameRules.SPREAD_VINES, false, server);
		rules.set(GameRules.MAX_SNOW_ACCUMULATION_HEIGHT, 0, server);
		rules.set(GameRules.RESPAWN_RADIUS, 0, server);
		rules.set(GameRules.LOCATOR_BAR, false, server);
		rules.set(GameRules.SHOW_ADVANCEMENT_MESSAGES, false, server);
		rules.set(GameRules.COMMAND_BLOCK_OUTPUT, false, server);
		rules.set(GameRules.LOG_ADMIN_COMMANDS, false, server);
		// Allow large /fill operations.
		rules.set(GameRules.MAX_BLOCK_MODIFICATIONS, 1_000_000, server);
	}
}
