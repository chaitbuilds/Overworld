package dev.overworld.layout;

import net.minecraft.core.BlockPos;
import net.minecraft.world.phys.Vec3;

/**
 * A named world position an agent walks to (the green where it waits, its place at a site):
 * {@code x,y,z} is where the agent's <b>feet</b> stand and {@code yaw} is the way it faces there.
 *
 * <p>Yaw follows Minecraft: 0 = facing +Z (south), 90 = -X (west), 180 = -Z (north), -90 = +X (east).
 */
public record Anchor(String name, double x, double y, double z, float yaw, float pitch) {
	public Vec3 pos() {
		return new Vec3(x, y, z);
	}

	public BlockPos blockPos() {
		return BlockPos.containing(x, y, z);
	}

	public Anchor withName(String newName) {
		return new Anchor(newName, x, y, z, yaw, pitch);
	}

	public Anchor offset(double dx, double dy, double dz) {
		return new Anchor(name, x + dx, y + dy, z + dz, yaw, pitch);
	}
}
