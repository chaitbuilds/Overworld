package dev.overworld.client.agents;

import dev.overworld.layout.Anchor;
import net.minecraft.world.phys.Vec3;
import org.jspecify.annotations.Nullable;

/**
 * Seats an agent can sit on ({@link AgentLife#setSeat}). Without a seat the agent stands; nothing in
 * the town assigns one, so its agents stand, walk, read and type standing up.
 */
public final class Seats {
	private Seats() {
	}

	/**
	 * A seat at an anchor. {@code sit}: where the agent's feet position goes (x/z of the sit point,
	 * y = the anchor's feet height); {@code drop}: vertical model offset while seated (blocks);
	 * {@code approach}: walkable feet position next to the seat (null = walk straight to sit);
	 * {@code deskTop}: absolute y of the surface in front of the sitter (NaN = nothing there).
	 */
	public record Seat(Anchor anchor, Vec3 sit, double seatTop, double drop, @Nullable Vec3 approach, double deskTop) {
		/** The target the agent walks to: the sit point with the anchor's facing. */
		public Anchor target() {
			return new Anchor(anchor.name(), sit.x, sit.y, sit.z, anchor.yaw(), anchor.pitch());
		}
	}
}
