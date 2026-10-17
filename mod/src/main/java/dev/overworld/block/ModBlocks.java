package dev.overworld.block;

import dev.overworld.Overworld;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.function.Function;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.SoundType;
import net.minecraft.world.level.block.state.BlockBehaviour;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.MapColor;
import net.minecraft.world.phys.AABB;

/**
 * The mod's one block: the monitor, a connectable screen panel. The backend builds the live wall on
 * the town square from it ({@code overworld:monitor[facing,lit,left,right,up,down]}); the client
 * draws the wall's live page on it. Render layers need no registration in 26.x: every baked quad
 * picks solid/cutout/translucent from its sprite's transparency.
 */
public final class ModBlocks {
	private static final List<Block> ALL = new ArrayList<>();

	public static final Block MONITOR = register("monitor", MonitorBlock::new,
		panel().mapColor(MapColor.COLOR_BLACK).strength(1.5f).sound(SoundType.COPPER).lightLevel(MonitorBlock::light));

	private ModBlocks() {
	}

	/** Forces class init (registration) from the common entrypoint. */
	public static void init() {
		Overworld.LOGGER.info("Registered {} Overworld blocks", ALL.size());
	}

	/** Every Overworld block in registration order. */
	public static List<Block> all() {
		return Collections.unmodifiableList(ALL);
	}

	private static Block register(String name, Function<BlockBehaviour.Properties, Block> factory, BlockBehaviour.Properties props) {
		ResourceKey<Block> key = ResourceKey.create(Registries.BLOCK, Overworld.id(name));
		Block block = Registry.register(BuiltInRegistries.BLOCK, key, factory.apply(props.setId(key)));
		ALL.add(block);
		return block;
	}

	private static boolean never(BlockState state, BlockGetter level, BlockPos pos) {
		return false;
	}

	private static boolean neverView(BlockState state, BlockGetter level, BlockPos pos, AABB box) {
		return false;
	}

	/** Thin wall panels: no occlusion, never suffocate or conduct redstone. */
	private static BlockBehaviour.Properties panel() {
		return BlockBehaviour.Properties.of().noOcclusion().isRedstoneConductor(ModBlocks::never).isSuffocating(ModBlocks::never)
			.isViewBlocking(ModBlocks::neverView).isValidSpawn((s, l, p, t) -> false);
	}
}
