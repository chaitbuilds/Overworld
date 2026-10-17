package dev.overworld.living;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.math.Transformation;
import dev.overworld.Overworld;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Deque;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CopyOnWriteArrayList;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.event.player.UseBlockCallback;
import net.minecraft.commands.arguments.blocks.BlockStateParser;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.core.registries.Registries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Brightness;
import net.minecraft.world.Container;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.Display;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.entity.EntityTypes;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.storage.LevelResource;
import org.joml.Quaternionf;
import org.joml.Vector3f;

/**
 * The living town inside the game. A part of the town is code that runs in the backend; what it wants
 * done arrives here as operations (place these blocks, move this raft to that dock over 160 ticks),
 * and this class carries each one out on the server thread, tick by tick, inside the site the part
 * was given. Nothing here decides what a part does. What happens in the world goes back as events
 * (the clock, a player using something, a mover arriving).
 *
 * <p>Movement is planned here and drawn by the client: a mover's displays stay where they started
 * until it arrives, and {@code LivingFeature} moves them (and whoever stands on the deck) every
 * client tick from the same plan, so a rider and the raft never drift apart.
 */
public final class LivingWorld {
    /** One part as this world knows it: where it may build, what it changed and what it put here. */
    public static final class Part {
        public List<int[]> boxes = new ArrayList<>();
        public boolean open;
        /** "x,y,z" -> the block state that stood there before this part first changed it. */
        public Map<String, String> original = new LinkedHashMap<>();
        /** Every display entity this part made (movers and labels), so a restart can clear them. */
        public List<String> entities = new ArrayList<>();
        transient Set<String> claimed = new HashSet<>();
        transient Deque<Build> builds = new ArrayDeque<>();
    }
    /** The marker of an ask: a post, the player's words and a lantern. Owned by the game, not by a part. */
    public static final class Stake {
        public int x, y, z;
        public float yaw;
        public String text = "", lamp = "off";
        public Map<String, String> original = new LinkedHashMap<>();
        public List<String> entities = new ArrayList<>();
    }
    public static final class Data {
        public int version = 1;
        public Map<String, Part> parts = new LinkedHashMap<>();
        public Map<String, Stake> stakes = new LinkedHashMap<>();
    }
    private static final class Build { String id; List<Object[]> blocks; double perTick, credit; int placed; JsonArray bad = new JsonArray(); }

    /** A straight move from one place to another over a number of ticks. Immutable: the client reads it from its own thread. */
    public record Motion(long seq, double fx, double fy, double fz, double tx, double ty, double tz, int ticks, boolean smooth) {
        public double[] at(int tick) {
            double p = ticks <= 0 ? 1 : Math.max(0, Math.min(1, tick / (double) ticks));
            if (smooth) p = p * p * (3 - 2 * p);
            return new double[] {fx + (tx - fx) * p, fy + (ty - fy) * p, fz + (tz - fz) * p};
        }
    }
    /** Turning about the origin: a steady spin (degrees per tick) or a swing that dies back to where it hung. */
    public record Turn(long seq, char axis, boolean swing, double rate, double degrees, int period, int times, double base) {
        public double angle(int tick) {
            if (!swing) return base + rate * tick;
            return tick >= period * times ? base : base + degrees * Math.sin(2 * Math.PI * tick / period);
        }
        public boolean done(int tick) { return swing && tick >= period * times; }
    }
    /** A group of block displays that moves as one thing, with an optional deck players stand on. */
    public static final class Mover {
        public final String part, id;
        public final int[] ids;
        final UUID[] uuids;
        /** Per piece: where its corner sits relative to the origin, and its size. */
        public final float[][] at, scale;
        /** Per piece: how it is turned about the origin before anything else (axis 0 x, 1 y, 2 z; degrees), or null. */
        public final float[][] pieceTurn;
        /** The deck relative to the origin (x0,y0,z0,x1,y1,z1), or null. */
        public final double[] deck;
        public volatile Motion motion;
        public volatile Turn turn;
        public volatile double x, y, z, angle;
        public volatile char axis = 'y';
        public volatile boolean removed;
        int motionTick, turnTick;
        String motionOp, turnOp;
        final Set<String> riders = new HashSet<>();
        Mover(String part, String id, int[] ids, UUID[] uuids, float[][] at, float[][] scale, float[][] pieceTurn, double[] deck, double x, double y, double z) {
            this.part = part; this.id = id; this.ids = ids; this.uuids = uuids; this.at = at; this.scale = scale; this.pieceTurn = pieceTurn; this.deck = deck; this.x = x; this.y = y; this.z = z;
        }
        /** The turn a piece was made with, as a rotation (identity when it has none). */
        public Quaternionf turnOf(int piece) {
            float[] t = pieceTurn[piece];
            if (t == null) return new Quaternionf();
            float rad = (float) Math.toRadians(t[1]);
            return t[0] == 1 ? new Quaternionf().rotationY(rad) : t[0] == 2 ? new Quaternionf().rotationZ(rad) : new Quaternionf().rotationX(rad);
        }
        public String key() { return part + ":" + id; }
    }
    /** Something a part asked to hear about: a block being used, a player entering a box, a container changing. */
    public record Watch(String part, String key, String kind, int[] box) {
        boolean has(int x, int y, int z) { return x >= box[0] && x <= box[3] && y >= box[1] && y <= box[4] && z >= box[2] && z <= box[5]; }
    }

    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final int FLAGS = Block.UPDATE_CLIENTS | Block.UPDATE_KNOWN_SHAPE | Block.UPDATE_SUPPRESS_DROPS;
    private static final ConcurrentLinkedQueue<JsonObject> OPS = new ConcurrentLinkedQueue<>();
    private static final ConcurrentLinkedQueue<JsonObject> EVENTS = new ConcurrentLinkedQueue<>();
    /**
     * Events made on the server thread and not yet handed over. An event is filled in after it is made (its id, a
     * block's state), and the client thread takes events from EVENTS whenever it likes: handed over at once, an
     * event could be taken half filled (an answer without its id, which then never settles what waited for it; a
     * block read with no block in it). So they wait here and are handed over whole at the end of the tick.
     */
    private static final List<JsonObject> STAGED = new ArrayList<>();
    private static final Map<String, Mover> MOVERS = new ConcurrentHashMap<>();
    private static final List<Watch> WATCHES = new CopyOnWriteArrayList<>();
    private static final Map<String, Set<String>> INSIDE = new HashMap<>();
    private static final Map<String, Integer> CONTENTS = new HashMap<>();
    private static final Map<String, BlockState> PARSED = new HashMap<>();
    private static Data data = new Data();
    private static volatile Data published = data;
    private static MinecraftServer server;
    private static long seq, lastClock = Long.MIN_VALUE;
    private static int ticks;
    private static boolean dirty;
    /** How long a build takes to rise when the part does not say: long enough to watch from across the water. */
    public static volatile double BUILD_SECONDS = 24;
    private LivingWorld() {}

    public static Data data() { return published; }
    public static Iterable<Mover> movers() { return MOVERS.values(); }
    public static Mover mover(String key) { return MOVERS.get(key); }
    /** Queue an operation for the server thread (any thread). */
    public static void submit(JsonObject op) { OPS.add(op); }
    /** The next thing that happened in the world, or null (any thread). */
    public static JsonObject nextEvent() { return EVENTS.poll(); }
    public static boolean running() { return server != null; }

    public static void init() {
        ServerLifecycleEvents.SERVER_STARTED.register(s -> { server = s; load(); event("hello").addProperty("world", s.getWorldData().getLevelName()); });
        ServerLifecycleEvents.SERVER_STOPPING.register(s -> save());
        ServerLifecycleEvents.SERVER_STOPPED.register(s -> { server = null; data = new Data(); published = data; MOVERS.clear(); WATCHES.clear(); INSIDE.clear(); CONTENTS.clear(); PARSED.clear(); OPS.clear(); synchronized (STAGED) { STAGED.clear(); } lastClock = Long.MIN_VALUE; });
        ServerTickEvents.END_SERVER_TICK.register(LivingWorld::tick);
        UseBlockCallback.EVENT.register((player, level, hand, hit) -> {
            if (hand != InteractionHand.MAIN_HAND || server == null) return InteractionResult.PASS;
            BlockPos pos = hit.getBlockPos();
            Watch watch = null;
            for (Watch w : WATCHES) if (w.kind().equals("use") && w.has(pos.getX(), pos.getY(), pos.getZ())) { Part p = published.parts.get(w.part()); if (p != null && p.open) { watch = w; break; } }
            if (watch == null) return InteractionResult.PASS;
            if (!level.isClientSide()) {
                JsonObject e = event("use"); e.addProperty("part", watch.part()); e.addProperty("key", watch.key()); e.add("at", ints(pos.getX(), pos.getY(), pos.getZ())); e.add("player", who(player));
            }
            return InteractionResult.SUCCESS;
        });
    }

    // ------------------------------------------------------------------ persistence
    private static Path file() { return server.getWorldPath(LevelResource.ROOT).resolve("living-town.json"); }
    private static void load() {
        try {
            if (Files.exists(file())) { Data d = GSON.fromJson(Files.readString(file()), Data.class); if (d != null) data = d; }
            for (Part p : data.parts.values()) { if (p.claimed == null) p.claimed = new HashSet<>(); if (p.builds == null) p.builds = new ArrayDeque<>(); }
        } catch (Exception e) { Overworld.LOGGER.warn("Living town record could not be read: {}", e.getMessage()); data = new Data(); }
        published = data;
    }
    private static void save() {
        if (server == null) return;
        try { Path f = file(), tmp = f.resolveSibling(f.getFileName() + ".tmp"); Files.writeString(tmp, GSON.toJson(data)); Files.move(tmp, f, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE); dirty = false; }
        catch (Exception e) { Overworld.LOGGER.warn("Living town record could not be saved: {}", e.getMessage()); }
    }

    // ------------------------------------------------------------------ the tick
    private static void tick(MinecraftServer s) {
        ServerLevel level = s.overworld();
        ticks++;
        JsonObject op;
        while ((op = OPS.poll()) != null) {
            try { apply(level, op); }
            catch (Exception e) {
                JsonObject err = event("error"); if (op.has("id")) err.add("id", op.get("id")); if (op.has("part")) err.add("part", op.get("part"));
                err.addProperty("op", str(op, "op", "")); err.addProperty("message", e.getMessage() == null ? e.toString() : e.getMessage());
                if (!(e instanceof Refused)) Overworld.LOGGER.warn("Living town operation failed: {}", op, e);
            }
        }
        for (Map.Entry<String, Part> e : data.parts.entrySet()) build(level, e.getKey(), e.getValue());
        for (Mover m : MOVERS.values()) move(level, m);
        if (ticks % 2 == 0) { zones(level); riders(level); }
        if (ticks % 10 == 0) containers(level);
        long clock = level.getDefaultClockTime();
        if (ticks % 5 == 0 || Math.abs(clock - lastClock) > 40) {
            JsonObject e = event("clock"); e.addProperty("game", level.getGameTime()); e.addProperty("time", clock);
        }
        lastClock = clock;
        flushEvents();
        if (dirty && ticks % 100 == 0) save();
    }

    private static final class Refused extends RuntimeException { Refused(String m) { super(m); } }

    private static void apply(ServerLevel level, JsonObject op) {
        String kind = str(op, "op", "");
        switch (kind) {
            case "part.begin" -> {
                String name = part(op);
                Part p = data.parts.computeIfAbsent(name, k -> new Part());
                clear(level, name, p);
                p.boxes = new ArrayList<>();
                for (JsonElement b : op.getAsJsonArray("boxes")) p.boxes.add(box(b.getAsJsonArray()));
                p.open = op.has("open") && op.get("open").getAsBoolean();
                p.claimed.clear(); p.builds.clear(); dirty = true;
            }
            case "part.ready" -> {
                // A new version starts where the old one stood: what the old one placed and this one did not place again is put back.
                Part p = need(op);
                int restored = 0;
                for (var it = p.original.entrySet().iterator(); it.hasNext();) {
                    var e = it.next();
                    if (p.claimed.contains(e.getKey())) continue;
                    BlockState was = parse(level, e.getValue());
                    if (was != null) { level.setBlock(pos(e.getKey()), was, FLAGS); restored++; }
                    it.remove();
                }
                dirty = true;
                done(op).addProperty("restored", restored);
            }
            case "part.open" -> { need(op).open = op.get("open").getAsBoolean(); dirty = true; }
            case "part.stop" -> clear(level, part(op), need(op));
            case "part.remove" -> {
                String name = part(op);
                Part p = data.parts.remove(name);
                if (p != null) { clear(level, name, p); for (var e : p.original.entrySet()) { BlockState was = parse(level, e.getValue()); if (was != null) level.setBlock(pos(e.getKey()), was, FLAGS); } dirty = true; }
            }
            case "blocks" -> {
                Part p = need(op);
                Build b = new Build();
                b.id = op.has("id") ? op.get("id").getAsString() : null;
                b.blocks = new ArrayList<>();
                for (JsonElement el : op.getAsJsonArray("blocks")) {
                    JsonArray row = el.getAsJsonArray();
                    int x = row.get(0).getAsInt(), y = row.get(1).getAsInt(), z = row.get(2).getAsInt();
                    String text = row.get(3).getAsString();
                    BlockState state = parse(level, text);
                    if (state == null) { if (b.bad.size() < 12) b.bad.add("unknown block " + text); continue; }
                    if (!inside(p, x, y, z)) { if (b.bad.size() < 12) b.bad.add("outside the site: " + x + " " + y + " " + z); continue; }
                    b.blocks.add(new Object[] {new BlockPos(x, y, z), state});
                }
                b.blocks.sort(Comparator.<Object[]>comparingInt(r -> ((BlockPos) r[0]).getY()).thenComparingInt(r -> ((BlockPos) r[0]).getX()).thenComparingInt(r -> ((BlockPos) r[0]).getZ()));
                double seconds = op.has("seconds") ? op.get("seconds").getAsDouble() : BUILD_SECONDS;
                // blocks already standing as asked cost no time: a restart does not rebuild what is there
                int fresh = 0; for (Object[] r : b.blocks) if (level.getBlockState((BlockPos) r[0]) != r[1]) fresh++;
                b.perTick = seconds <= 0 ? Double.MAX_VALUE : Math.max(0.2, Math.min(40, fresh / (seconds * 20)));
                p.builds.add(b);
            }
            case "block.get" -> {
                JsonArray at = op.getAsJsonArray("at");
                done(op).addProperty("state", BlockStateParser.serialize(level.getBlockState(new BlockPos(at.get(0).getAsInt(), at.get(1).getAsInt(), at.get(2).getAsInt()))));
            }
            case "mover.create" -> createMover(level, op);
            case "mover.move" -> {
                Mover m = mover(op);
                JsonArray to = op.getAsJsonArray("to");
                double tx = to.get(0).getAsDouble(), ty = to.get(1).getAsDouble(), tz = to.get(2).getAsDouble();
                Part p = need(op);
                if (!insideLoose(p, tx, ty, tz)) throw new Refused("the mover would leave its site: " + tx + " " + ty + " " + tz);
                if (m.motion != null && m.motionOp != null) { JsonObject e = event("done"); e.addProperty("id", m.motionOp); e.addProperty("interrupted", true); e.add("at", doubles(m.x, m.y, m.z)); }
                m.motionTick = 0; m.motionOp = op.has("id") ? op.get("id").getAsString() : null;
                m.motion = new Motion(++seq, m.x, m.y, m.z, tx, ty, tz, Math.max(1, op.get("ticks").getAsInt()), "smooth".equals(str(op, "ease", "smooth")));
            }
            case "mover.spin" -> {
                Mover m = mover(op);
                double rate = op.get("rate").getAsDouble();
                finishTurn(m, true);
                m.axis = str(op, "axis", "x").charAt(0); m.turnTick = 0;
                m.turn = rate == 0 ? null : new Turn(++seq, m.axis, false, rate, 0, 0, 0, m.angle);
            }
            case "mover.swing" -> {
                Mover m = mover(op);
                finishTurn(m, true);
                m.axis = str(op, "axis", "x").charAt(0); m.turnTick = 0; m.turnOp = op.has("id") ? op.get("id").getAsString() : null;
                m.turn = new Turn(++seq, m.axis, true, 0, op.get("degrees").getAsDouble(), Math.max(4, op.get("period").getAsInt()), Math.max(1, op.get("times").getAsInt()), m.angle);
            }
            case "mover.remove" -> { Mover m = MOVERS.remove(part(op) + ":" + op.get("mover").getAsString()); if (m != null) discard(level, m); }
            case "mover.riders" -> { Mover m = mover(op); JsonArray names = new JsonArray(); for (String n : m.riders) names.add(n); done(op).add("riders", names); }
            case "label" -> label(level, op);
            case "label.remove" -> removeTagged(level, need(op), "living.label." + part(op) + "." + op.get("label").getAsString());
            case "watch" -> {
                String name = part(op), key = op.get("key").getAsString();
                Part p = need(op);
                int[] box = box(op.getAsJsonArray("box"));
                if (!inside(p, box[0], box[1], box[2]) || !inside(p, box[3], box[4], box[5])) throw new Refused("that place is outside the site");
                WATCHES.removeIf(w -> w.part().equals(name) && w.key().equals(key));
                WATCHES.add(new Watch(name, key, str(op, "kind", "use"), box));
            }
            case "unwatch" -> { String name = part(op), key = op.get("key").getAsString(); WATCHES.removeIf(w -> w.part().equals(name) && w.key().equals(key)); }
            case "player.take", "player.give" -> {
                ServerPlayer player = server.getPlayerList().getPlayerByName(op.get("name").getAsString());
                Item item = item(op.get("item").getAsString());
                int count = Math.max(0, Math.min(640, op.get("count").getAsInt())), moved = 0;
                if (player != null && item != null) {
                    if (kind.equals("player.take")) { moved = player.getInventory().clearOrCountMatchingItems(st -> st.is(item), false, count, player.inventoryMenu.getCraftSlots()); player.inventoryMenu.broadcastChanges(); }
                    else { ItemStack stack = stack(op, item, count); if (!player.getInventory().add(stack)) level.addFreshEntity(new ItemEntity(level, player.getX(), player.getY() + 0.5, player.getZ(), stack)); moved = count; }
                }
                done(op).addProperty("count", moved);
            }
            case "container.items", "container.put", "container.take" -> container(level, op, kind);
            case "drop" -> {
                Part p = need(op);
                JsonArray at = op.getAsJsonArray("at");
                double x = at.get(0).getAsDouble(), y = at.get(1).getAsDouble(), z = at.get(2).getAsDouble();
                Item item = item(op.get("item").getAsString());
                if (item == null) throw new Refused("unknown item " + op.get("item").getAsString());
                if (!insideLoose(p, x, y, z)) throw new Refused("that place is outside the site");
                ItemEntity dropped = new ItemEntity(level, x, y, z, stack(op, item, Math.max(1, Math.min(64, op.get("count").getAsInt()))));
                dropped.setDeltaMovement(0, 0.18, 0); dropped.setDefaultPickUpDelay();
                level.addFreshEntity(dropped);
            }
            case "particles" -> {
                Part p = need(op);
                JsonArray at = op.getAsJsonArray("at");
                double x = at.get(0).getAsDouble(), y = at.get(1).getAsDouble(), z = at.get(2).getAsDouble();
                if (!insideLoose(p, x, y, z)) throw new Refused("that place is outside the site");
                String name = safe(op.get("name").getAsString());
                double spread = op.has("spread") ? op.get("spread").getAsDouble() : 0.3, speed = op.has("speed") ? op.get("speed").getAsDouble() : 0.01;
                run("particle " + name + " " + x + " " + y + " " + z + " " + spread + " " + spread + " " + spread + " " + speed + " " + Math.max(1, Math.min(200, op.has("count") ? op.get("count").getAsInt() : 8)) + " force");
            }
            case "sound" -> {
                Part p = need(op);
                JsonArray at = op.getAsJsonArray("at");
                double x = at.get(0).getAsDouble(), y = at.get(1).getAsDouble(), z = at.get(2).getAsDouble();
                if (!insideLoose(p, x, y, z)) throw new Refused("that place is outside the site");
                run("playsound " + safe(op.get("name").getAsString()) + " block @a " + x + " " + y + " " + z + " " + (op.has("volume") ? op.get("volume").getAsDouble() : 1.0) + " " + (op.has("pitch") ? op.get("pitch").getAsDouble() : 1.0));
            }
            case "stake" -> stake(level, op);
            case "stake.remove" -> {
                Stake st = data.stakes.remove(op.get("ask").getAsString());
                if (st != null) { discardAll(level, st.entities); for (var e : st.original.entrySet()) { BlockState was = parse(level, e.getValue()); if (was != null) level.setBlock(pos(e.getKey()), was, FLAGS); } dirty = true; }
            }
            case "board" -> {
                // the board at the gate: the backend's own lines, drawn on the town's board
                for (Entity e : level.getAllEntities()) if (e != null && e.entityTags().contains("living.board")) e.discard();
                JsonArray at = op.getAsJsonArray("at");
                Display.TextDisplay d = text(level, at.get(0).getAsDouble(), at.get(1).getAsDouble(), at.get(2).getAsDouble(), str(op, "text", ""), op.has("scale") ? op.get("scale").getAsFloat() : 0.5f, op.has("yaw") ? op.get("yaw").getAsFloat() : 0f, op.has("width") ? op.get("width").getAsInt() : 360);
                d.setFlags((byte) (d.getFlags() | Display.TextDisplay.FLAG_ALIGN_LEFT));
                d.setBackgroundColor(0);
                d.addTag("living.board");
                level.addFreshEntity(d);
            }
            case "pace" -> BUILD_SECONDS = op.get("seconds").getAsDouble();
            default -> throw new Refused("unknown operation " + kind);
        }
    }

    // ------------------------------------------------------------------ blocks
    private static void build(ServerLevel level, String name, Part p) {
        Build b = p.builds.peek();
        if (b == null) return;
        b.credit += b.perTick;
        while (b.placed < b.blocks.size()) {
            Object[] row = b.blocks.get(b.placed);
            BlockPos pos = (BlockPos) row[0];
            BlockState state = (BlockState) row[1], now = level.getBlockState(pos);
            String key = key(pos);
            p.claimed.add(key);
            if (now == state) { b.placed++; continue; }
            if (b.credit < 1) return;
            b.credit -= 1; b.placed++;
            if (!level.hasChunkAt(pos)) continue;
            if (!p.original.containsKey(key)) { p.original.put(key, BlockStateParser.serialize(now)); dirty = true; }
            level.setBlock(pos, state, FLAGS);
            settle(level, p, pos);
            for (var d : net.minecraft.core.Direction.values()) { BlockPos n = pos.relative(d); if (p.original.containsKey(key(n))) settle(level, p, n); }
        }
        p.builds.poll();
        if (b.id != null) { JsonObject e = event("done"); e.addProperty("id", b.id); e.addProperty("placed", b.blocks.size()); e.add("bad", b.bad); }
    }
    /** Fences, walls, panes and stairs take their shape from what now stands beside them. */
    private static void settle(ServerLevel level, Part p, BlockPos pos) {
        BlockState state = level.getBlockState(pos), settled = Block.updateFromNeighbourShapes(state, level, pos);
        if (settled != state && !settled.isAir()) level.setBlock(pos, settled, FLAGS);
    }

    // ------------------------------------------------------------------ movers
    private static void createMover(ServerLevel level, JsonObject op) {
        String name = part(op), id = op.get("mover").getAsString();
        Part p = need(op);
        JsonArray at = op.getAsJsonArray("at"), pieces = op.getAsJsonArray("pieces");
        double x = at.get(0).getAsDouble(), y = at.get(1).getAsDouble(), z = at.get(2).getAsDouble();
        if (!insideLoose(p, x, y, z)) throw new Refused("the mover starts outside its site");
        if (pieces.size() > 160) throw new Refused("a mover has at most 160 pieces");
        Mover old = MOVERS.remove(name + ":" + id);
        if (old != null) discard(level, old);
        int n = pieces.size();
        int[] ids = new int[n]; UUID[] uuids = new UUID[n]; float[][] offsets = new float[n][], scales = new float[n][], turns = new float[n][];
        for (int i = 0; i < n; i++) {
            JsonObject piece = pieces.get(i).getAsJsonObject();
            BlockState state = parse(level, piece.get("block").getAsString());
            if (state == null) throw new Refused("unknown block " + piece.get("block").getAsString());
            JsonArray o = piece.getAsJsonArray("at");
            offsets[i] = new float[] {o.get(0).getAsFloat(), o.get(1).getAsFloat(), o.get(2).getAsFloat()};
            JsonElement sc = piece.get("scale");
            scales[i] = sc == null || sc.isJsonNull() ? new float[] {1, 1, 1} : sc.isJsonArray() ? new float[] {sc.getAsJsonArray().get(0).getAsFloat(), sc.getAsJsonArray().get(1).getAsFloat(), sc.getAsJsonArray().get(2).getAsFloat()} : new float[] {sc.getAsFloat(), sc.getAsFloat(), sc.getAsFloat()};
            Quaternionf turned = new Quaternionf();
            if (piece.has("turn") && piece.get("turn").isJsonObject()) {
                JsonObject t = piece.getAsJsonObject("turn");
                String axis = str(t, "axis", "x");
                turns[i] = new float[] {axis.equals("y") ? 1 : axis.equals("z") ? 2 : 0, t.get("degrees").getAsFloat()};
                float rad = (float) Math.toRadians(turns[i][1]);
                turned = turns[i][0] == 1 ? new Quaternionf().rotationY(rad) : turns[i][0] == 2 ? new Quaternionf().rotationZ(rad) : new Quaternionf().rotationX(rad);
            }
            Display.BlockDisplay d = EntityTypes.BLOCK_DISPLAY.create(level, EntitySpawnReason.COMMAND);
            d.setPos(x, y, z);
            d.setBlockState(state);
            d.setTransformation(new Transformation(turned.transform(new Vector3f(offsets[i][0], offsets[i][1], offsets[i][2])), turned, new Vector3f(scales[i][0], scales[i][1], scales[i][2]), new Quaternionf()));
            d.setViewRange(4f);
            if (op.has("bright") && op.get("bright").getAsBoolean()) d.setBrightnessOverride(new Brightness(15, 15));
            d.addTag("living"); d.addTag("living." + name); d.addTag("living.mover." + name + "." + id);
            level.addFreshEntity(d);
            ids[i] = d.getId(); uuids[i] = d.getUUID();
            p.entities.add(d.getUUID().toString());
        }
        double[] deck = null;
        if (op.has("deck") && !op.get("deck").isJsonNull()) { JsonArray k = op.getAsJsonArray("deck"); deck = new double[6]; for (int i = 0; i < 6; i++) deck[i] = k.get(i).getAsDouble(); }
        MOVERS.put(name + ":" + id, new Mover(name, id, ids, uuids, offsets, scales, turns, deck, x, y, z));
        dirty = true;
    }

    private static void move(ServerLevel level, Mover m) {
        Motion motion = m.motion;
        if (motion != null) {
            double[] at = motion.at(++m.motionTick);
            m.x = at[0]; m.y = at[1]; m.z = at[2];
            if (m.motionTick >= motion.ticks()) {
                // arrived: the displays themselves are moved once, to where the client has already drawn them
                for (UUID id : m.uuids) { Entity e = level.getEntity(id); if (e != null) e.setPos(m.x, m.y, m.z); }
                m.motion = null;
                if (m.motionOp != null) { JsonObject e = event("done"); e.addProperty("id", m.motionOp); e.add("at", doubles(m.x, m.y, m.z)); m.motionOp = null; }
            }
        }
        Turn turn = m.turn;
        if (turn != null) {
            m.angle = turn.angle(++m.turnTick);
            if (turn.done(m.turnTick)) finishTurn(m, false);
        }
    }
    private static void finishTurn(Mover m, boolean interrupted) {
        Turn turn = m.turn;
        if (turn == null) return;
        if (turn.swing()) m.angle = turn.base();
        m.angle = ((m.angle % 360) + 360) % 360;
        m.turn = null;
        if (m.turnOp != null) { JsonObject e = event("done"); e.addProperty("id", m.turnOp); if (interrupted) e.addProperty("interrupted", true); m.turnOp = null; }
    }
    private static void discard(ServerLevel level, Mover m) {
        m.removed = true;
        Part p = data.parts.get(m.part);
        for (UUID id : m.uuids) { Entity e = level.getEntity(id); if (e != null) e.discard(); if (p != null) p.entities.remove(id.toString()); }
        if (m.motionOp != null) { JsonObject e = event("done"); e.addProperty("id", m.motionOp); e.addProperty("interrupted", true); }
        if (m.turnOp != null) { JsonObject e = event("done"); e.addProperty("id", m.turnOp); e.addProperty("interrupted", true); }
    }
    /** Who stands on each deck: told to the part when it changes. */
    private static void riders(ServerLevel level) {
        for (Mover m : MOVERS.values()) {
            if (m.deck == null) continue;
            Set<String> now = new HashSet<>();
            for (ServerPlayer player : level.players()) if (onDeck(m, player.getX(), player.getY(), player.getZ())) now.add(player.getScoreboardName());
            if (now.equals(m.riders)) continue;
            for (String name : now) if (!m.riders.contains(name)) { JsonObject e = event("board"); e.addProperty("part", m.part); e.addProperty("mover", m.id); e.addProperty("player", name); }
            for (String name : m.riders) if (!now.contains(name)) { JsonObject e = event("alight"); e.addProperty("part", m.part); e.addProperty("mover", m.id); e.addProperty("player", name); }
            m.riders.clear(); m.riders.addAll(now);
        }
    }
    /** True when feet at this position stand on the mover's deck, wherever the mover is now. */
    public static boolean onDeck(Mover m, double x, double y, double z) {
        double[] d = m.deck;
        return d != null && x >= m.x + d[0] - 0.3 && x <= m.x + d[3] + 0.3 && z >= m.z + d[2] - 0.3 && z <= m.z + d[5] + 0.3 && Math.abs(y - (m.y + d[4])) < 0.6;
    }

    // ------------------------------------------------------------------ labels and stakes
    private static void label(ServerLevel level, JsonObject op) {
        String name = part(op), id = op.get("label").getAsString(), tag = "living.label." + name + "." + id;
        Part p = need(op);
        JsonArray at = op.getAsJsonArray("at");
        double x = at.get(0).getAsDouble(), y = at.get(1).getAsDouble(), z = at.get(2).getAsDouble();
        if (!insideLoose(p, x, y, z)) throw new Refused("the label is outside the site");
        String words = clip(str(op, "text", ""), 3000);
        float scale = op.has("scale") ? op.get("scale").getAsFloat() : 1f, yaw = op.has("yaw") ? op.get("yaw").getAsFloat() : Float.NaN;
        int width = op.has("width") ? op.get("width").getAsInt() : 160, background = op.has("background") ? op.get("background").getAsInt() : 0xB8101418;
        boolean left = "left".equals(str(op, "align", ""));
        // the label that stands already is changed where it stands: a new one draws nothing for a tick, and the words would blink
        Display.TextDisplay d = null;
        List<String> extra = new ArrayList<>();
        for (String u : p.entities) {
            Entity e = level.getEntity(UUID.fromString(u));
            if (e instanceof Display.TextDisplay t && e.entityTags().contains(tag)) { if (d == null) d = t; else extra.add(u); }
        }
        for (String u : extra) { Entity e = level.getEntity(UUID.fromString(u)); if (e != null) e.discard(); p.entities.remove(u); }
        if (d == null) {
            removeTagged(level, p, tag);
            d = text(level, x, y, z, words, scale, yaw, width);
            d.addTag("living." + name); d.addTag(tag);
            level.addFreshEntity(d);
            p.entities.add(d.getUUID().toString());
        } else {
            d.setPos(x, y, z);
            d.setText(Component.literal(words));
            d.setLineWidth(width);
            d.setTransformation(new Transformation(new Vector3f(), new Quaternionf(), new Vector3f(scale, scale, scale), new Quaternionf()));
            if (Float.isNaN(yaw)) d.setBillboardConstraints(Display.BillboardConstraints.VERTICAL); else { d.setBillboardConstraints(Display.BillboardConstraints.FIXED); d.setYRot(yaw); }
        }
        d.setFlags((byte) (left ? d.getFlags() | Display.TextDisplay.FLAG_ALIGN_LEFT : d.getFlags() & ~Display.TextDisplay.FLAG_ALIGN_LEFT));
        d.setBackgroundColor(background);
        dirty = true;
    }
    /** White words on dark glass. A yaw fixes which way it faces; without one it turns to whoever looks. */
    private static Display.TextDisplay text(ServerLevel level, double x, double y, double z, String words, float scale, float yaw, int width) {
        Display.TextDisplay d = EntityTypes.TEXT_DISPLAY.create(level, EntitySpawnReason.COMMAND);
        d.setPos(x, y, z);
        d.setText(Component.literal(words));
        d.setLineWidth(width);
        d.setBackgroundColor(0xB8101418);
        d.setTransformation(new Transformation(new Vector3f(), new Quaternionf(), new Vector3f(scale, scale, scale), new Quaternionf()));
        d.setViewRange(4f);
        d.setBrightnessOverride(new Brightness(15, 15));
        if (Float.isNaN(yaw)) d.setBillboardConstraints(Display.BillboardConstraints.VERTICAL); else d.setYRot(yaw);
        d.addTag("living");
        return d;
    }
    private static void removeTagged(ServerLevel level, Part p, String tag) {
        for (Entity e : level.getAllEntities()) if (e != null && e.entityTags().contains(tag)) { if (p != null) p.entities.remove(e.getUUID().toString()); e.discard(); }
    }
    private static void discardAll(ServerLevel level, List<String> uuids) {
        for (String id : uuids) { Entity e = level.getEntity(UUID.fromString(id)); if (e != null) e.discard(); }
        uuids.clear();
    }

    /** The ask's marker: two fence posts, the words, and a lantern that is dark while the work goes on, lit when it is live, red when its checks failed. */
    private static void stake(ServerLevel level, JsonObject op) {
        String ask = op.get("ask").getAsString(), tag = "living.stake." + ask;
        Stake st = data.stakes.computeIfAbsent(ask, k -> new Stake());
        if (op.has("at")) { JsonArray at = op.getAsJsonArray("at"); st.x = at.get(0).getAsInt(); st.y = at.get(1).getAsInt(); st.z = at.get(2).getAsInt(); }
        if (op.has("yaw")) st.yaw = op.get("yaw").getAsFloat();
        if (op.has("text")) st.text = op.get("text").getAsString();
        if (op.has("lamp")) st.lamp = op.get("lamp").getAsString();
        for (Entity e : level.getAllEntities()) if (e != null && e.entityTags().contains(tag)) e.discard();
        st.entities.clear();
        BlockPos base = new BlockPos(st.x, st.y, st.z), lamp = base.above(2);
        for (BlockPos pos : List.of(base, base.above(), lamp)) if (!st.original.containsKey(key(pos))) st.original.put(key(pos), BlockStateParser.serialize(level.getBlockState(pos)));
        level.setBlock(base, Blocks.SPRUCE_FENCE.defaultBlockState(), FLAGS); level.setBlock(base.above(), Blocks.SPRUCE_FENCE.defaultBlockState(), FLAGS);
        // a lamp that is plainly dark until the work is live: a copper bulb, unlit then lit; a red torch when its checks failed
        BlockState bulb = parse(level, "minecraft:waxed_copper_bulb[lit=" + st.lamp.equals("on") + ",powered=false]");
        BlockState head = st.lamp.equals("failed") || bulb == null ? Blocks.REDSTONE_TORCH.defaultBlockState() : bulb;
        level.setBlock(lamp, head, FLAGS);
        if (!st.text.isEmpty()) {
            Display.TextDisplay words = text(level, st.x + 0.5, st.y + 3.15, st.z + 0.5, clip(st.text, 240), op.has("scale") ? op.get("scale").getAsFloat() : 0.9f, Float.NaN, 150);
            words.addTag(tag); level.addFreshEntity(words); st.entities.add(words.getUUID().toString());
        }
        dirty = true;
    }

    // ------------------------------------------------------------------ players and containers
    private static void zones(ServerLevel level) {
        for (Watch w : WATCHES) {
            if (!w.kind().equals("zone")) continue;
            Part p = data.parts.get(w.part());
            if (p == null || !p.open) continue;
            Set<String> was = INSIDE.computeIfAbsent(w.part() + ":" + w.key(), k -> new HashSet<>()), now = new HashSet<>();
            for (ServerPlayer player : level.players()) {
                if (player.getX() >= w.box()[0] && player.getX() <= w.box()[3] + 1 && player.getY() >= w.box()[1] - 0.01 && player.getY() <= w.box()[4] + 1 && player.getZ() >= w.box()[2] && player.getZ() <= w.box()[5] + 1) {
                    now.add(player.getScoreboardName());
                    if (!was.contains(player.getScoreboardName())) { JsonObject e = event("enter"); e.addProperty("part", w.part()); e.addProperty("key", w.key()); e.add("player", who(player)); }
                }
            }
            for (String name : was) if (!now.contains(name)) { JsonObject e = event("leave"); e.addProperty("part", w.part()); e.addProperty("key", w.key()); JsonObject who = new JsonObject(); who.addProperty("name", name); e.add("player", who); }
            was.clear(); was.addAll(now);
        }
    }
    private static void containers(ServerLevel level) {
        for (Watch w : WATCHES) {
            if (!w.kind().equals("container")) continue;
            BlockPos pos = new BlockPos(w.box()[0], w.box()[1], w.box()[2]);
            if (!(level.getBlockEntity(pos) instanceof Container c)) continue;
            int hash = 17;
            for (int i = 0; i < c.getContainerSize(); i++) { ItemStack st = c.getItem(i); hash = hash * 31 + (st.isEmpty() ? 0 : BuiltInRegistries.ITEM.getKey(st.getItem()).hashCode() * 131 + st.getCount()); }
            Integer was = CONTENTS.put(w.part() + ":" + w.key(), hash);
            if (was != null && was != hash) { JsonObject e = event("container"); e.addProperty("part", w.part()); e.addProperty("key", w.key()); }
        }
    }
    private static void container(ServerLevel level, JsonObject op, String kind) {
        Part p = need(op);
        JsonArray at = op.getAsJsonArray("at");
        BlockPos pos = new BlockPos(at.get(0).getAsInt(), at.get(1).getAsInt(), at.get(2).getAsInt());
        if (!inside(p, pos.getX(), pos.getY(), pos.getZ())) throw new Refused("that container is outside the site");
        if (!(level.getBlockEntity(pos) instanceof Container c)) throw new Refused("there is no container at " + pos.toShortString());
        JsonObject out = done(op);
        if (kind.equals("container.items")) {
            Map<String, Integer> counts = new LinkedHashMap<>();
            for (int i = 0; i < c.getContainerSize(); i++) { ItemStack st = c.getItem(i); if (!st.isEmpty()) counts.merge(BuiltInRegistries.ITEM.getKey(st.getItem()).toString(), st.getCount(), Integer::sum); }
            JsonArray items = new JsonArray();
            for (var e : counts.entrySet()) { JsonObject o = new JsonObject(); o.addProperty("item", e.getKey()); o.addProperty("count", e.getValue()); items.add(o); }
            out.add("items", items);
            return;
        }
        Item item = item(op.get("item").getAsString());
        if (item == null) throw new Refused("unknown item " + op.get("item").getAsString());
        int count = Math.max(0, Math.min(1728, op.get("count").getAsInt())), moved = 0;
        if (kind.equals("container.take")) {
            for (int i = 0; i < c.getContainerSize() && moved < count; i++) { ItemStack st = c.getItem(i); if (st.is(item)) { int n = Math.min(st.getCount(), count - moved); st.shrink(n); moved += n; if (st.isEmpty()) c.setItem(i, ItemStack.EMPTY); } }
        } else {
            for (int i = 0; i < c.getContainerSize() && moved < count; i++) {
                ItemStack st = c.getItem(i);
                if (st.isEmpty()) { int n = Math.min(item.getDefaultMaxStackSize(), count - moved); c.setItem(i, stack(op, item, n)); moved += n; }
                else if (st.is(item) && st.getCount() < st.getMaxStackSize() && !op.has("named")) { int n = Math.min(st.getMaxStackSize() - st.getCount(), count - moved); st.grow(n); moved += n; }
            }
        }
        c.setChanged();
        out.addProperty("count", moved);
    }
    private static ItemStack stack(JsonObject op, Item item, int count) {
        ItemStack st = new ItemStack(item, count);
        if (op.has("named") && !op.get("named").isJsonNull()) st.set(net.minecraft.core.component.DataComponents.CUSTOM_NAME, Component.literal(op.get("named").getAsString()).withStyle(s -> s.withItalic(false)));
        return st;
    }
    private static JsonObject who(net.minecraft.world.entity.player.Player player) {
        JsonObject o = new JsonObject();
        o.addProperty("name", player.getScoreboardName());
        ItemStack held = player.getMainHandItem();
        o.addProperty("item", held.isEmpty() ? null : BuiltInRegistries.ITEM.getKey(held.getItem()).toString());
        o.addProperty("count", held.getCount());
        o.add("at", doubles(player.getX(), player.getY(), player.getZ()));
        return o;
    }

    // ------------------------------------------------------------------ helpers
    private static void clear(ServerLevel level, String name, Part p) {
        for (var it = MOVERS.values().iterator(); it.hasNext();) { Mover m = it.next(); if (m.part.equals(name)) { it.remove(); discard(level, m); } }
        discardAll(level, p.entities);
        for (Entity e : level.getAllEntities()) if (e != null && e.entityTags().contains("living." + name)) e.discard();
        WATCHES.removeIf(w -> w.part().equals(name));
        INSIDE.keySet().removeIf(k -> k.startsWith(name + ":")); CONTENTS.keySet().removeIf(k -> k.startsWith(name + ":"));
        for (Build b : p.builds) if (b.id != null) { JsonObject e = event("done"); e.addProperty("id", b.id); e.addProperty("interrupted", true); }
        p.builds.clear(); dirty = true;
    }
    private static String part(JsonObject op) { String name = str(op, "part", null); if (name == null || !name.matches("[a-z][a-z0-9-]{0,39}")) throw new Refused("a part name is needed"); return name; }
    private static Part need(JsonObject op) { Part p = data.parts.get(part(op)); if (p == null) throw new Refused("no such part here: " + part(op)); return p; }
    private static Mover mover(JsonObject op) { Mover m = MOVERS.get(part(op) + ":" + op.get("mover").getAsString()); if (m == null) throw new Refused("no such mover: " + op.get("mover").getAsString()); return m; }
    private static boolean inside(Part p, int x, int y, int z) { for (int[] b : p.boxes) if (x >= b[0] && x <= b[3] && y >= b[1] && y <= b[4] && z >= b[2] && z <= b[5]) return true; return false; }
    /** A point (not a block): inside when the block it is in is, or it lies on the far face of the site. */
    private static boolean insideLoose(Part p, double x, double y, double z) { for (int[] b : p.boxes) if (x >= b[0] && x <= b[3] + 1 && y >= b[1] && y <= b[4] + 1 && z >= b[2] && z <= b[5] + 1) return true; return false; }
    private static int[] box(JsonArray a) { int[] b = new int[6]; for (int i = 0; i < 6; i++) b[i] = a.get(i).getAsInt(); return new int[] {Math.min(b[0], b[3]), Math.min(b[1], b[4]), Math.min(b[2], b[5]), Math.max(b[0], b[3]), Math.max(b[1], b[4]), Math.max(b[2], b[5])}; }
    private static BlockState parse(ServerLevel level, String text) {
        return PARSED.computeIfAbsent(text, k -> { try { return BlockStateParser.parseForBlock(level.holderLookup(Registries.BLOCK), k.contains(":") ? k : "minecraft:" + k, false).blockState(); } catch (Exception e) { return null; } });
    }
    private static Item item(String name) { Identifier id = Identifier.tryParse(name.contains(":") ? name : "minecraft:" + name); return id == null || !BuiltInRegistries.ITEM.containsKey(id) ? null : BuiltInRegistries.ITEM.getValue(id); }
    private static String safe(String name) { if (!name.matches("[a-z0-9_:./]{1,80}")) throw new Refused("not a name: " + name); return name; }
    private static void run(String command) { server.getCommands().performPrefixedCommand(server.createCommandSourceStack().withSuppressedOutput(), command); }
    private static String key(BlockPos p) { return p.getX() + "," + p.getY() + "," + p.getZ(); }
    private static BlockPos pos(String key) { String[] s = key.split(","); return new BlockPos(Integer.parseInt(s[0]), Integer.parseInt(s[1]), Integer.parseInt(s[2])); }
    /** A part's label and an ask's words are kept short; the board is not cut (it says everything that is true of the town). */
    private static String clip(String words, int most) { return words.length() > most ? words.substring(0, most) : words; }
    private static String str(JsonObject o, String key, String fallback) { return o.has(key) && !o.get(key).isJsonNull() ? o.get(key).getAsString() : fallback; }
    private static JsonArray ints(int... v) { JsonArray a = new JsonArray(); for (int i : v) a.add(i); return a; }
    private static JsonArray doubles(double... v) { JsonArray a = new JsonArray(); for (double d : v) a.add(Math.round(d * 1000) / 1000.0); return a; }
    private static JsonObject event(String kind) { JsonObject e = new JsonObject(); e.addProperty("kind", kind); synchronized (STAGED) { STAGED.add(e); } return e; }
    /** Hand over every event made since the last tick, now that each is whole. */
    private static void flushEvents() { synchronized (STAGED) { if (!STAGED.isEmpty()) { EVENTS.addAll(STAGED); STAGED.clear(); } } }
    private static JsonObject done(JsonObject op) { JsonObject e = event("done"); if (op.has("id")) e.add("id", op.get("id")); return e; }

    /** For tools and tests: what stands here now. */
    public static JsonObject stateJson() {
        JsonObject out = new JsonObject();
        JsonObject parts = new JsonObject();
        for (var e : published.parts.entrySet()) { JsonObject o = new JsonObject(); o.addProperty("open", e.getValue().open); o.addProperty("blocks", e.getValue().original.size()); o.addProperty("building", e.getValue().builds == null ? 0 : e.getValue().builds.size()); o.addProperty("entities", e.getValue().entities.size()); parts.add(e.getKey(), o); }
        out.add("parts", parts);
        JsonArray movers = new JsonArray();
        for (Mover m : MOVERS.values()) { JsonObject o = new JsonObject(); o.addProperty("part", m.part); o.addProperty("id", m.id); o.add("at", doubles(m.x, m.y, m.z)); o.addProperty("angle", m.angle); o.addProperty("moving", m.motion != null); o.addProperty("turning", m.turn != null); o.addProperty("pieces", m.ids.length); if (m.deck != null) o.add("deck", doubles(m.deck)); JsonArray r = new JsonArray(); for (String n : m.riders) r.add(n); o.add("riders", r); movers.add(o); }
        out.add("movers", movers);
        JsonObject stakes = new JsonObject();
        for (var e : published.stakes.entrySet()) { JsonObject o = new JsonObject(); o.add("at", ints(e.getValue().x, e.getValue().y, e.getValue().z)); o.addProperty("text", e.getValue().text); o.addProperty("lamp", e.getValue().lamp); stakes.add(e.getKey(), o); }
        out.add("stakes", stakes);
        out.addProperty("watches", WATCHES.size());
        return out;
    }
}
