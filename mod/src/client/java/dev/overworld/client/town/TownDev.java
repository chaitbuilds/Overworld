package dev.overworld.client.town;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.overworld.client.dev.DevBridge;
import dev.overworld.client.dev.Fields;
import dev.overworld.client.world.ServerTasks;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import net.minecraft.commands.arguments.blocks.BlockStateParser;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.levelgen.Heightmap;

/**
 * Site tools for dressing the town's setting (terrain survey, placing authored buildings). Stage
 * dressing only: nothing here creates, changes or reports a project. Every use is written to the
 * staging record by the caller.
 */
public final class TownDev {
    private TownDev() {}

    public static void init() {
        DevBridge.register("dev.town.heights", 60_000, "{x0,z0,x1,z1,step?} -> rows by z: ground[][] (y of the top terrain block; trees, plants and anything built are looked through only if natural), water[][] (depth of water above it, 0 = dry), top[][] (that block)", (request, mc) -> {
            Fields f = Fields.of(request);
            int x0 = (int) f.integer("x0", -30_000_000, 30_000_000), z0 = (int) f.integer("z0", -30_000_000, 30_000_000), x1 = (int) f.integer("x1", x0, x0 + 512), z1 = (int) f.integer("z1", z0, z0 + 512), step = f.optInt("step", 1, 1, 16);
            CompletableFuture<JsonObject> out = new CompletableFuture<>();
            if (!ServerTasks.run(level -> { try {
                JsonArray ground = new JsonArray(), water = new JsonArray(), top = new JsonArray();
                for (int z = z0; z <= z1; z += step) {
                    JsonArray g = new JsonArray(), w = new JsonArray(), t = new JsonArray();
                    for (int x = x0; x <= x1; x += step) {
                        level.getChunk(x >> 4, z >> 4);
                        BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos(x, level.getHeight(Heightmap.Types.MOTION_BLOCKING, x, z) - 1, z);
                        int surface = Integer.MIN_VALUE;
                        while (p.getY() > level.getMinY()) {
                            BlockState state = level.getBlockState(p);
                            boolean wet = !state.getFluidState().isEmpty();
                            if (wet && surface == Integer.MIN_VALUE) surface = p.getY();
                            if (!wet && !vegetation(state)) break;
                            p.move(0, -1, 0);
                        }
                        g.add(p.getY()); w.add(surface == Integer.MIN_VALUE ? 0 : surface - p.getY()); t.add(BuiltInRegistries.BLOCK.getKey(level.getBlockState(p).getBlock()).getPath());
                    }
                    ground.add(g); water.add(w); top.add(t);
                }
                JsonObject o = new JsonObject(); o.addProperty("x0", x0); o.addProperty("z0", z0); o.addProperty("step", step); o.add("ground", ground); o.add("water", water); o.add("top", top); out.complete(o);
            } catch (Exception e) { out.completeExceptionally(e); } })) throw new DevBridge.DevException("Single-player world required");
            return out;
        });
        DevBridge.register("dev.town.clear", 120_000, "{x0,z0,x1,z1} - remove trees and plants standing on the terrain in this area (nothing else) -> {removed}", (request, mc) -> {
            Fields f = Fields.of(request);
            int x0 = (int) f.integer("x0", -30_000_000, 30_000_000), z0 = (int) f.integer("z0", -30_000_000, 30_000_000), x1 = (int) f.integer("x1", x0, x0 + 512), z1 = (int) f.integer("z1", z0, z0 + 512);
            CompletableFuture<JsonObject> out = new CompletableFuture<>();
            if (!ServerTasks.run(level -> { try {
                int removed = 0, flags = Block.UPDATE_CLIENTS | Block.UPDATE_KNOWN_SHAPE | Block.UPDATE_SUPPRESS_DROPS;
                for (int z = z0; z <= z1; z++) for (int x = x0; x <= x1; x++) {
                    level.getChunk(x >> 4, z >> 4);
                    BlockPos.MutableBlockPos p = new BlockPos.MutableBlockPos(x, level.getHeight(Heightmap.Types.MOTION_BLOCKING, x, z) - 1, z);
                    while (p.getY() > level.getMinY()) {
                        BlockState state = level.getBlockState(p);
                        if (!state.getFluidState().isEmpty() && !vegetation(state)) break;
                        if (!state.isAir() && !vegetation(state)) break;
                        if (!state.isAir()) { level.setBlock(p, state.getFluidState().isEmpty() ? net.minecraft.world.level.block.Blocks.AIR.defaultBlockState() : state.getFluidState().createLegacyBlock(), flags); removed++; }
                        p.move(0, -1, 0);
                    }
                }
                JsonObject o = new JsonObject(); o.addProperty("removed", removed); out.complete(o);
            } catch (Exception e) { out.completeExceptionally(e); } })) throw new DevBridge.DevException("Single-player world required");
            return out;
        });
        DevBridge.register("dev.town.place", 300_000, "{file} | {blocks:[[x,y,z,state]..]} - place block states exactly as given (no drops, no physics), then settle fences, panes, walls and stairs against their neighbours -> {placed, changed, bad[]}", (request, mc) -> {
            JsonArray blocks = request.has("file") ? JsonParser.parseString(Files.readString(Path.of(Fields.of(request).nonBlank("file")))).getAsJsonObject().getAsJsonArray("blocks") : request.getAsJsonArray("blocks");
            if (blocks == null) throw new DevBridge.DevException("blocks or file");
            CompletableFuture<JsonObject> out = new CompletableFuture<>();
            if (!ServerTasks.run(level -> { try { out.complete(place(level, blocks)); } catch (Exception e) { out.completeExceptionally(e); } })) throw new DevBridge.DevException("Single-player world required");
            return out;
        });
    }

    /** Air, trees and plants: what stands on terrain rather than being it. */
    static boolean vegetation(BlockState state) {
        return state.isAir() || state.is(net.minecraft.tags.BlockTags.LEAVES) || state.is(net.minecraft.tags.BlockTags.LOGS) || state.is(net.minecraft.world.level.block.Blocks.VINE)
            || state.is(net.minecraft.world.level.block.Blocks.BEE_NEST) || state.is(net.minecraft.world.level.block.Blocks.SNOW) || state.is(net.minecraft.world.level.block.Blocks.PUMPKIN) || state.is(net.minecraft.world.level.block.Blocks.MELON)
            || state.is(net.minecraft.world.level.block.Blocks.BROWN_MUSHROOM_BLOCK) || state.is(net.minecraft.world.level.block.Blocks.RED_MUSHROOM_BLOCK) || state.is(net.minecraft.world.level.block.Blocks.MUSHROOM_STEM)
            || (state.canBeReplaced() || state.is(net.minecraft.tags.BlockTags.FLOWERS) || state.is(net.minecraft.tags.BlockTags.SAPLINGS)) && state.getFluidState().isEmpty()
            || state.is(net.minecraft.world.level.block.Blocks.SEAGRASS) || state.is(net.minecraft.world.level.block.Blocks.TALL_SEAGRASS) || state.is(net.minecraft.world.level.block.Blocks.KELP) || state.is(net.minecraft.world.level.block.Blocks.KELP_PLANT);
    }

    /** Parses and places every entry; a state the game does not know is reported, never guessed. */
    static JsonObject place(ServerLevel level, JsonArray blocks) {
        var lookup = level.holderLookup(Registries.BLOCK);
        Map<String, BlockState> parsed = new HashMap<>();
        JsonArray bad = new JsonArray();
        List<BlockPos> placed = new ArrayList<>(blocks.size());
        int flags = Block.UPDATE_CLIENTS | Block.UPDATE_KNOWN_SHAPE | Block.UPDATE_SUPPRESS_DROPS, changed = 0;
        for (var element : blocks) {
            JsonArray row = element.getAsJsonArray();
            String text = row.get(3).getAsString();
            BlockState state = parsed.computeIfAbsent(text, key -> { try { return BlockStateParser.parseForBlock(lookup, key.contains(":") ? key : "minecraft:" + key, false).blockState(); } catch (Exception e) { return null; } });
            if (state == null) { if (bad.size() < 20 && !bad.contains(new com.google.gson.JsonPrimitive(text))) bad.add(text); continue; }
            BlockPos pos = new BlockPos(row.get(0).getAsInt(), row.get(1).getAsInt(), row.get(2).getAsInt());
            level.getChunk(pos.getX() >> 4, pos.getZ() >> 4);
            if (level.setBlock(pos, state, flags)) changed++;
            placed.add(pos);
        }
        // second pass: connecting blocks take their shape from what now stands beside them
        for (BlockPos pos : placed) {
            BlockState state = level.getBlockState(pos), settled = Block.updateFromNeighbourShapes(state, level, pos);
            if (settled != state && !settled.isAir()) level.setBlock(pos, settled, flags);
        }
        JsonObject o = new JsonObject(); o.addProperty("placed", placed.size()); o.addProperty("changed", changed); o.add("bad", bad); return o;
    }
}
