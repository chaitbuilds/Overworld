package dev.overworld.client.world;

import java.util.function.Consumer;
import net.minecraft.client.Minecraft;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.server.level.ServerLevel;

/**
 * Run world work for the client (DevBridge site tools, block dumps, the living town's state) on the
 * integrated server thread. Singleplayer only: the town is a local world. Keep the work small and
 * idempotent (only set a block state when it actually differs).
 *
 * <pre>
 * ServerTasks.run(level -> {
 *     BlockState s = level.getBlockState(pos);
 *     if (s != wanted) level.setBlock(pos, wanted, Block.UPDATE_CLIENTS);
 * });
 * </pre>
 */
public final class ServerTasks {
	private ServerTasks() {
	}

	/** Queue {@code task} on the integrated server with the overworld; false when not in singleplayer. */
	public static boolean run(Consumer<ServerLevel> task) {
		IntegratedServer server = Minecraft.getInstance().getSingleplayerServer();
		if (server == null) {
			return false;
		}
		server.execute(() -> task.accept(server.overworld()));
		return true;
	}
}
