package dev.overworld.block.entity;

import net.minecraft.core.BlockPos;
import net.minecraft.world.level.block.state.BlockState;

/** Monitor screen. Drawn by client monitor.MonitorRenderer from the panel origin (a live page, when the town names one there). */
public class MonitorBlockEntity extends StationBlockEntity {
	public MonitorBlockEntity(BlockPos pos, BlockState state) {
		super(ModBlockEntities.MONITOR, pos, state);
	}
}
