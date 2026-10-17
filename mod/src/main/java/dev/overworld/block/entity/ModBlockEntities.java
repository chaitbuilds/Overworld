package dev.overworld.block.entity;

import dev.overworld.Overworld;
import dev.overworld.block.ModBlocks;
import java.util.Set;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.entity.BlockEntityType;

/** Block entity types: the monitor's, whose live page is drawn by a client BER (monitor.MonitorRenderer). */
public final class ModBlockEntities {
	public static final BlockEntityType<MonitorBlockEntity> MONITOR = register("monitor", MonitorBlockEntity::new, ModBlocks.MONITOR);

	private ModBlockEntities() {
	}

	public static void init() {
		// class init registers everything
	}

	private static <T extends BlockEntity> BlockEntityType<T> register(String name, BlockEntityType.BlockEntitySupplier<T> factory, Block block) {
		return Registry.register(BuiltInRegistries.BLOCK_ENTITY_TYPE, Overworld.id(name), new BlockEntityType<>(factory, Set.of(block)));
	}
}
