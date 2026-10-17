package dev.overworld.client.living;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.mojang.math.Transformation;
import dev.overworld.client.agents.AgentRenderer;
import dev.overworld.client.dev.DevBridge;
import dev.overworld.client.dev.Fields;
import dev.overworld.client.foreman.Foreman;
import dev.overworld.client.foreman.ForemanState;
import dev.overworld.client.world.ServerTasks;
import dev.overworld.entity.ModEntities;
import dev.overworld.living.DeckEntity;
import dev.overworld.living.LivingWorld;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.client.renderer.entity.EntityRenderers;
import net.minecraft.client.renderer.entity.NoopRenderer;
import net.minecraft.util.Mth;
import net.minecraft.world.entity.Display;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.Vec3;
import org.joml.Quaternionf;
import org.joml.Vector3f;

/**
 * The living town on the client. Operations from the backend ({@code town.do}) are handed to the
 * server thread ({@link LivingWorld}); what happens in the world goes back as {@code town.event}.
 * Movers are drawn here: every client tick each mover's displays, its deck and whoever stands on the
 * deck are moved by the same step of the same plan, so the ride is as smooth as the frame rate and
 * the rider never slides on the raft.
 */
public final class LivingFeature {
    /** Where the client has drawn a mover, and how far through its plan it is. */
    private static final class Anim {
        LivingWorld.Motion motion; long motionSeq; int motionTick;
        LivingWorld.Turn turn; long turnSeq; int turnTick;
        double x, y, z, px, py, pz, angle, shownAngle = Double.NaN;
        char axis = 'x';
        Entity[] seen;
        DeckEntity[] deck;
        double[][] tiles;
        /** The mover this was made for: a part may make a mover again under the same id, with other pieces. */
        LivingWorld.Mover of;
    }
    private static final Map<String, Anim> ANIM = new HashMap<>();
    private static final Deque<JsonObject> RECENT = new ArrayDeque<>();
    private static final List<JsonObject> BACKLOG = new ArrayList<>();
    private static ClientLevel level;
    private static int nextDeckId = -52_001, ticks;
    // dev.living.player {look}: head keys on the wall clock, applied every frame
    private static double[][] lookKeys;
    private static long lookStart;
    private static float lookFromYaw, lookFromPitch;
    // frame trace (dev.living.trace): the camera and one mover, as drawn
    private static String traceKey;
    private static long traceUntil;
    private static final List<double[]> TRACE = new ArrayList<>();
    private LivingFeature() {}

    public static void init() {
        EntityRenderers.register(ModEntities.DECK, ctx -> new NoopRenderer<>(ctx));
        // The cast: the agent type's own renderer draws nothing; the dispatcher mixin routes each ClientAgentEntity
        // to the slim or wide AgentRenderer built here on every resource reload.
        EntityRenderers.register(ModEntities.AGENT, ctx -> { AgentRenderer.provide(ctx); return new NoopRenderer<>(ctx); });
        ForemanState.on("town.do", json -> { if (json.has("ops")) for (JsonElement op : json.getAsJsonArray("ops")) LivingWorld.submit(op.getAsJsonObject()); });
        ForemanState.on("town.state", json -> { if (json.has("town") && json.get("town").isJsonObject()) LivingTown.set(json.getAsJsonObject("town")); });
        ForemanState.on("snapshot", json -> LivingTown.set(json.has("town") && json.get("town").isJsonObject() ? json.getAsJsonObject("town") : null));
        ClientTickEvents.END_CLIENT_TICK.register(LivingFeature::tick);
        // A sign in the hand is how you ask: aim it at a place and use it. The sign is never placed.
        net.fabricmc.fabric.api.event.player.UseItemCallback.EVENT.register((player, lvl, hand) -> lvl.isClientSide() && hand == net.minecraft.world.InteractionHand.MAIN_HAND && asking(player) && ask(Minecraft.getInstance()) ? net.minecraft.world.InteractionResult.FAIL : net.minecraft.world.InteractionResult.PASS);
        net.fabricmc.fabric.api.event.player.UseBlockCallback.EVENT.register((player, lvl, hand, hit) -> lvl.isClientSide() && hand == net.minecraft.world.InteractionHand.MAIN_HAND && asking(player) && ask(Minecraft.getInstance()) ? net.minecraft.world.InteractionResult.FAIL : net.minecraft.world.InteractionResult.PASS);
        DevBridge.register("dev.living.ask", 10_000, "{} -> the open ask (place, words) and the place the player aims at; {hold:'sign'|'none'|'rod'|'wheat', count?} puts that in the hand; {open:true} opens the ask as using the sign does", (request, mc) -> DevBridge.onClient(mc, () -> {
            Fields f = Fields.of(request);
            if (request.has("hold")) {
                String item = switch (f.str("hold")) { case "sign" -> "minecraft:spruce_sign"; case "rod" -> "minecraft:fishing_rod"; case "wheat" -> "minecraft:wheat"; case "none" -> "minecraft:air"; default -> throw new DevBridge.DevException("hold: sign, rod, wheat or none"); };
                var server = mc.getSingleplayerServer(); if (server == null) throw new DevBridge.DevException("Single-player world required");
                int count = f.optInt("count", 1, 1, 64);
                server.execute(() -> server.getCommands().performPrefixedCommand(server.createCommandSourceStack().withSuppressedOutput(), "item replace entity @p weapon.mainhand with " + item + (item.endsWith("air") ? "" : " " + count)));
            }
            if (f.optBool("open", false) && !ask(mc)) throw new DevBridge.DevException("Nothing can be asked for where the player is aiming");
            JsonObject o = new JsonObject();
            JsonObject aimed = aimedPlace(mc);
            o.addProperty("aiming", aimed == null ? null : aimed.get("id").getAsString());
            // the block under the crosshair, so a miss can be understood from outside
            if (mc.player != null && mc.player.pick(64, mc.getDeltaTracker().getGameTimeDeltaPartialTick(true), true) instanceof net.minecraft.world.phys.BlockHitResult block && block.getType() == net.minecraft.world.phys.HitResult.Type.BLOCK) {
                JsonArray hit = new JsonArray(); hit.add(block.getBlockPos().getX()); hit.add(block.getBlockPos().getY()); hit.add(block.getBlockPos().getZ()); o.add("hit", hit);
            }
            if (mc.gui.screen() instanceof AskScreen open) { o.addProperty("open", true); o.addProperty("place", open.placeId()); o.addProperty("words", open.words()); } else o.addProperty("open", false);
            o.addProperty("held", mc.player == null ? "" : net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(mc.player.getMainHandItem().getItem()).toString());
            return o;
        }));
        DevBridge.register("dev.living.player", 5_000, "{flying?:bool} - stand the player on its feet (creative flight off) or let it fly; {look:[[seconds,yaw,pitch]..]} turns the head through those keys while the body stays free to be carried -> {flying, onGround, x, y, z}", (request, mc) -> DevBridge.onClient(mc, () -> {
            Fields f = Fields.of(request);
            if (mc.player == null) throw new DevBridge.DevException("not in a world");
            if (request.has("flying")) { mc.player.getAbilities().flying = f.bool("flying"); mc.player.onUpdateAbilities(); }
            if (request.has("look")) {
                JsonArray keys = request.getAsJsonArray("look");
                double[][] parsed = new double[keys.size()][];
                for (int i = 0; i < parsed.length; i++) { JsonArray k = keys.get(i).getAsJsonArray(); parsed[i] = new double[] {k.get(0).getAsDouble(), k.get(1).getAsDouble(), k.get(2).getAsDouble()}; }
                lookKeys = parsed.length == 0 ? null : parsed; lookStart = System.nanoTime(); lookFromYaw = mc.player.getYRot(); lookFromPitch = mc.player.getXRot();
            }
            JsonObject o = new JsonObject();
            o.addProperty("flying", mc.player.getAbilities().flying); o.addProperty("onGround", mc.player.onGround());
            o.addProperty("x", mc.player.getX()); o.addProperty("y", mc.player.getY()); o.addProperty("z", mc.player.getZ());
            return o;
        }));
        DevBridge.register("dev.living.blocks", 120_000, "{x0,y0,z0,x1,y1,z1,file} - write every block state in the box to a file as {box, palette[], runs[index,count,..]} in y, z, x order (for the backend's simulated town)", (request, mc) -> {
            Fields f = Fields.of(request);
            int x0 = (int) f.integer("x0", -30_000_000, 30_000_000), y0 = (int) f.integer("y0", -64, 319), z0 = (int) f.integer("z0", -30_000_000, 30_000_000);
            int x1 = (int) f.integer("x1", x0, x0 + 255), y1 = (int) f.integer("y1", y0, 319), z1 = (int) f.integer("z1", z0, z0 + 255);
            String file = f.nonBlank("file");
            CompletableFuture<JsonObject> out = new CompletableFuture<>();
            if (!ServerTasks.run(lvl -> { try {
                Map<net.minecraft.world.level.block.state.BlockState, Integer> index = new HashMap<>();
                JsonArray palette = new JsonArray(), runs = new JsonArray();
                int last = -1, count = 0;
                net.minecraft.core.BlockPos.MutableBlockPos p = new net.minecraft.core.BlockPos.MutableBlockPos();
                for (int y = y0; y <= y1; y++) for (int z = z0; z <= z1; z++) for (int x = x0; x <= x1; x++) {
                    var state = lvl.getBlockState(p.set(x, y, z));
                    Integer i = index.get(state);
                    if (i == null) { i = palette.size(); index.put(state, i); palette.add(net.minecraft.commands.arguments.blocks.BlockStateParser.serialize(state)); }
                    if (i == last) count++; else { if (count > 0) { runs.add(last); runs.add(count); } last = i; count = 1; }
                }
                if (count > 0) { runs.add(last); runs.add(count); }
                JsonObject dump = new JsonObject();
                JsonArray box = new JsonArray(); for (int v : new int[] {x0, y0, z0, x1, y1, z1}) box.add(v);
                dump.add("box", box); dump.add("palette", palette); dump.add("runs", runs);
                java.nio.file.Files.writeString(java.nio.file.Path.of(file), dump.toString());
                JsonObject o = new JsonObject(); o.addProperty("file", file); o.addProperty("states", palette.size()); o.addProperty("runs", runs.size() / 2); out.complete(o);
            } catch (Exception e) { out.completeExceptionally(e); } })) throw new DevBridge.DevException("Single-player world required");
            return out;
        });
        DevBridge.register("dev.living.registry", 60_000, "{file} - write what the game knows by name to a file: every block with its properties and their values, every item, sound and particle (for the backend, so a name the game would refuse is refused in its simulated town too)", (request, mc) -> {
            String file = Fields.of(request).nonBlank("file");
            JsonObject blocks = new JsonObject();
            for (var block : net.minecraft.core.registries.BuiltInRegistries.BLOCK) {
                var id = net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(block);
                if (!id.getNamespace().equals("minecraft")) continue;
                JsonObject props = new JsonObject();
                for (var p : block.getStateDefinition().getProperties()) props.add(p.getName(), valueNames(p));
                blocks.add(id.getPath(), props);
            }
            JsonObject out = new JsonObject();
            out.add("blocks", blocks);
            out.add("items", paths(net.minecraft.core.registries.BuiltInRegistries.ITEM.keySet()));
            out.add("sounds", paths(net.minecraft.core.registries.BuiltInRegistries.SOUND_EVENT.keySet()));
            out.add("particles", paths(net.minecraft.core.registries.BuiltInRegistries.PARTICLE_TYPE.keySet()));
            try { java.nio.file.Files.writeString(java.nio.file.Path.of(file), out.toString()); } catch (java.io.IOException e) { throw new DevBridge.DevException("could not write " + file + ": " + e.getMessage()); }
            JsonObject o = new JsonObject(); o.addProperty("file", file); o.addProperty("blocks", blocks.size());
            o.addProperty("items", out.getAsJsonArray("items").size()); o.addProperty("sounds", out.getAsJsonArray("sounds").size()); o.addProperty("particles", out.getAsJsonArray("particles").size());
            return CompletableFuture.completedFuture(o);
        });
        DevBridge.register("dev.living.do", 10_000, "{ops:[{op,...}]} - hand operations straight to the living town (rehearsal without a backend): part.begin, blocks, mover.create, mover.move, ...", (request, mc) -> {
            if (!LivingWorld.running()) throw new DevBridge.DevException("Single-player world required");
            JsonArray ops = request.getAsJsonArray("ops");
            if (ops == null) throw new DevBridge.DevException("ops");
            for (JsonElement op : ops) LivingWorld.submit(op.getAsJsonObject());
            JsonObject o = new JsonObject(); o.addProperty("queued", ops.size()); return CompletableFuture.completedFuture(o);
        });
        DevBridge.register("dev.living.state", 10_000, "{events?:n, clear?:bool} -> parts, movers and stakes as the world has them, where the client has drawn each mover, and the last events", (request, mc) -> {
            Fields f = Fields.of(request);
            int want = f.optInt("events", 40, 0, 400);
            boolean clear = f.optBool("clear", false);
            CompletableFuture<JsonObject> out = new CompletableFuture<>();
            if (!ServerTasks.run(lvl -> { JsonObject world; try { world = LivingWorld.stateJson(); } catch (Exception e) { out.completeExceptionally(e); return; }
                mc.execute(() -> {
                    JsonArray drawn = new JsonArray();
                    for (var e : ANIM.entrySet()) { JsonObject o = new JsonObject(); o.addProperty("mover", e.getKey()); o.addProperty("x", e.getValue().x); o.addProperty("y", e.getValue().y); o.addProperty("z", e.getValue().z); o.addProperty("angle", e.getValue().angle); o.addProperty("deck", e.getValue().deck != null); drawn.add(o); }
                    world.add("drawn", drawn);
                    JsonArray events = new JsonArray(); int skip = Math.max(0, RECENT.size() - want), i = 0;
                    for (JsonObject ev : RECENT) if (i++ >= skip) events.add(ev);
                    world.add("events", events);
                    if (clear) RECENT.clear();
                    world.addProperty("linked", Foreman.connected());
                    world.add("town", LivingTown.town());
                    world.add("cast", dev.overworld.client.agents.LivingAgents.stateJson());
                    out.complete(world);
                });
            })) throw new DevBridge.DevException("Single-player world required");
            return out;
        });
        DevBridge.register("dev.living.trace", 5_000, "{mover:'part:id', seconds} starts a per-frame record of the camera and that mover as drawn; {} returns it -> {frames:[[ms, camX, camY, camZ, moverX, moverY, moverZ]..]}", (request, mc) -> DevBridge.onClient(mc, () -> {
            Fields f = Fields.of(request);
            JsonObject o = new JsonObject();
            if (request.has("mover")) { TRACE.clear(); traceKey = f.nonBlank("mover"); traceUntil = System.nanoTime() + (long) (f.optInt("seconds", 20, 1, 300) * 1e9); o.addProperty("tracing", traceKey); return o; }
            JsonArray frames = new JsonArray();
            for (double[] row : TRACE) { JsonArray a = new JsonArray(); for (double v : row) a.add(Math.round(v * 10000) / 10000.0); frames.add(a); }
            o.add("frames", frames); o.addProperty("tracing", traceKey != null && System.nanoTime() < traceUntil);
            return o;
        }));
    }

    private static void tick(Minecraft mc) {
        if (mc.level != level) { level = mc.level; ANIM.clear(); }
        pump();
        if (level == null || mc.player == null) return;
        ANIM.keySet().removeIf(key -> { LivingWorld.Mover m = LivingWorld.mover(key); if (m != null && !m.removed) return false; Anim a = ANIM.get(key); if (a.deck != null) for (DeckEntity d : a.deck) if (d != null) d.discard(); return true; });
        for (LivingWorld.Mover m : LivingWorld.movers()) if (!m.removed) animate(mc.player, m);
        if (++ticks % 10 == 0) LivingTown.tick();
        dev.overworld.client.agents.LivingAgents.tick(mc);
        outline(mc);
    }

    private static <T extends Comparable<T>> JsonArray valueNames(net.minecraft.world.level.block.state.properties.Property<T> p) {
        JsonArray a = new JsonArray(); for (T v : p.getPossibleValues()) a.add(p.getName(v)); return a;
    }
    private static JsonArray paths(java.util.Set<? extends Object> ids) {
        java.util.List<String> names = new ArrayList<>();
        for (Object id : ids) { String n = id.toString(); if (n.startsWith("minecraft:")) names.add(n.substring(10)); }
        java.util.Collections.sort(names);
        JsonArray a = new JsonArray(); for (String n : names) a.add(n); return a;
    }
    /** One line over the hotbar (the action bar), for the player. */
    static void toast(String message) { Minecraft.getInstance().gui.hud.setOverlayMessage(net.minecraft.network.chat.Component.literal(message), false); }
    private static boolean asking(net.minecraft.world.entity.player.Player player) { return player.getMainHandItem().is(net.minecraft.tags.ItemTags.SIGNS); }
    /** The place under the crosshair, water included, out to where a place can still be told from its neighbour. */
    private static JsonObject aimedPlace(Minecraft mc) {
        if (mc.player == null) return null;
        var hit = mc.player.pick(64, mc.getDeltaTracker().getGameTimeDeltaPartialTick(true), true);
        return hit instanceof net.minecraft.world.phys.BlockHitResult block && hit.getType() == net.minecraft.world.phys.HitResult.Type.BLOCK ? LivingTown.placeAt(LivingTown.town(), block.getBlockPos()) : null;
    }
    /** Open the ask for the aimed place. True when the use was the town's to handle. */
    private static boolean ask(Minecraft mc) {
        if (mc.gui.screen() != null || mc.player == null) return false;
        var hit = mc.player.pick(64, mc.getDeltaTracker().getGameTimeDeltaPartialTick(true), true);
        if (!(hit instanceof net.minecraft.world.phys.BlockHitResult block) || hit.getType() != net.minecraft.world.phys.HitResult.Type.BLOCK) return true;
        JsonObject place = LivingTown.placeAt(LivingTown.town(), block.getBlockPos());
        if (place == null) { toast("Aim the sign at a place in the town."); return true; }
        JsonObject standing = LivingTown.askAt(LivingTown.town(), place.get("id").getAsString());
        if (standing != null && standing.has("busy") && standing.get("busy").getAsBoolean()) { toast("Work is still going on here."); return true; }
        mc.gui.setScreen(new AskScreen(place, block.getBlockPos()));
        return true;
    }
    /** While a sign is held: the outline of the place it points at. */
    private static void outline(Minecraft mc) {
        if (mc.gui.screen() != null && !(mc.gui.screen() instanceof AskScreen) || !asking(mc.player)) return;
        JsonObject place = mc.gui.screen() instanceof AskScreen open ? LivingTown.place(LivingTown.town(), open.placeId()) : aimedPlace(mc);
        if (place == null || !place.has("boxes")) return;
        for (JsonElement b : place.getAsJsonArray(place.has("outline") ? "outline" : "boxes")) {
            JsonArray k = b.getAsJsonArray();
            var box = new net.minecraft.world.phys.AABB(k.get(0).getAsInt(), k.get(1).getAsInt(), k.get(2).getAsInt(), k.get(3).getAsInt() + 1, k.get(4).getAsInt() + 1, k.get(5).getAsInt() + 1);
            net.minecraft.gizmos.Gizmos.cuboid(box, net.minecraft.gizmos.GizmoStyle.stroke(0xFFFFFFFF, 2.5f));
        }
    }

    /** World events go to the backend in one message a tick; without a link they are kept (the clock excepted) and sent on reconnect. */
    private static void pump() {
        JsonArray batch = new JsonArray();
        boolean linked = Foreman.connected();
        if (linked && !BACKLOG.isEmpty()) { for (JsonObject e : BACKLOG) batch.add(e); BACKLOG.clear(); }
        JsonObject event;
        while ((event = LivingWorld.nextEvent()) != null) {
            boolean clock = "clock".equals(event.get("kind").getAsString());
            if (!clock) { RECENT.addLast(event); while (RECENT.size() > 400) RECENT.removeFirst(); }
            if (linked) batch.add(event); else if (!clock && BACKLOG.size() < 2000) BACKLOG.add(event);
        }
        if (batch.isEmpty()) return;
        JsonObject payload = new JsonObject(); payload.add("events", batch);
        Foreman.send("town.event", payload).exceptionally(e -> null);
    }

    private static void animate(LocalPlayer player, LivingWorld.Mover m) {
        Anim a = ANIM.get(m.key());
        // a mover made again under the same id is a new thing to draw: nothing kept for the old one fits it (its pieces may be more or fewer)
        if (a != null && a.of != m) { if (a.deck != null) for (DeckEntity d : a.deck) if (d != null) d.discard(); a = null; }
        if (a == null) { a = new Anim(); a.of = m; a.x = a.px = m.x; a.y = a.py = m.y; a.z = a.pz = m.z; a.angle = m.angle; a.axis = m.axis; a.seen = new Entity[m.ids.length]; ANIM.put(m.key(), a); }
        // the plan is the server's; how far along it is drawn is counted here, a client tick at a time
        LivingWorld.Motion plan = m.motion;
        if (plan != null && plan.seq() != a.motionSeq) { a.motion = plan; a.motionSeq = plan.seq(); a.motionTick = 0; }
        double nx = a.x, ny = a.y, nz = a.z;
        if (a.motion != null) {
            double[] at = a.motion.at(++a.motionTick);
            nx = at[0]; ny = at[1]; nz = at[2];
            if (a.motionTick >= a.motion.ticks()) a.motion = null;
        } else if (plan == null && (a.x != m.x || a.y != m.y || a.z != m.z)) { nx = m.x; ny = m.y; nz = m.z; }
        LivingWorld.Turn turning = m.turn;
        if (turning != null && turning.seq() != a.turnSeq) { a.turn = turning; a.turnSeq = turning.seq(); a.turnTick = 0; a.axis = turning.axis(); }
        if (a.turn != null) {
            a.angle = a.turn.angle(++a.turnTick);
            if (a.turn.done(a.turnTick) || !a.turn.swing() && (turning == null || turning.seq() != a.turnSeq)) { if (a.turn.swing()) a.angle = a.turn.base(); a.turn = null; }
        }
        double dx = nx - a.x, dy = ny - a.y, dz = nz - a.z;
        boolean moved = dx != 0 || dy != 0 || dz != 0, turned = a.angle != a.shownAngle;
        // the deck goes first when it sinks, last when it rises or slides, so the rider is never pushed through it
        if (moved && dy < 0) deck(m, a, nx, ny, nz);
        if (moved && m.deck != null && onDeck(m, a, player)) {
            Vec3 to = player.position().add(dx, dy, dz);
            if (player.level().noCollision(player, player.getBoundingBox().move(dx, dy + 1.0E-4, dz))) player.setPos(to);
        }
        if (!moved || dy >= 0) deck(m, a, nx, ny, nz);
        Quaternionf rotation = null;
        if (turned) { float rad = (float) Math.toRadians(a.angle); rotation = switch (a.axis) { case 'y' -> new Quaternionf().rotationY(rad); case 'z' -> new Quaternionf().rotationZ(rad); default -> new Quaternionf().rotationX(rad); }; }
        for (int i = 0; i < m.ids.length; i++) {
            Entity e = level.getEntity(m.ids[i]);
            if (e == null) { a.seen[i] = null; continue; }
            boolean fresh = a.seen[i] != e;
            a.seen[i] = e;
            if ((turned || fresh && a.angle != 0) && e instanceof Display d) {
                Quaternionf q = new Quaternionf(rotation != null ? rotation : switch (a.axis) { case 'y' -> new Quaternionf().rotationY((float) Math.toRadians(a.angle)); case 'z' -> new Quaternionf().rotationZ((float) Math.toRadians(a.angle)); default -> new Quaternionf().rotationX((float) Math.toRadians(a.angle)); });
                if (m.pieceTurn[i] != null) q.mul(m.turnOf(i));
                Vector3f offset = q.transform(new Vector3f(m.at[i][0], m.at[i][1], m.at[i][2]));
                d.setTransformationInterpolationDuration(fresh ? 0 : 1);
                d.setTransformationInterpolationDelay(0);
                d.setTransformation(new Transformation(offset, new Quaternionf(q), new Vector3f(m.scale[i][0], m.scale[i][1], m.scale[i][2]), new Quaternionf()));
            }
        }
        a.px = a.x; a.py = a.y; a.pz = a.z;
        a.x = nx; a.y = ny; a.z = nz; a.shownAngle = a.angle;
    }

    /**
     * Start of a rendered frame (MinecraftMixin), after the ticks: every piece is put where the plan has it at
     * this instant, with no step left for the renderer to interpolate. Done per frame, not per tick, because the
     * server re-sends each display's own position (where the move began) every few seconds, and that packet may
     * land in a frame that has no tick.
     */
    public static void beforeRender(Minecraft mc) {
        look(mc);
        if (level == null || mc.level != level || ANIM.isEmpty()) return;
        float pt = mc.getDeltaTracker().getGameTimeDeltaPartialTick(true);
        for (var entry : ANIM.entrySet()) {
            LivingWorld.Mover m = LivingWorld.mover(entry.getKey());
            if (m == null || m.removed) continue;
            Anim a = entry.getValue();
            double x = Mth.lerp(pt, a.px, a.x), y = Mth.lerp(pt, a.py, a.y), z = Mth.lerp(pt, a.pz, a.z);
            for (int id : m.ids) {
                Entity e = level.getEntity(id);
                if (e == null || e.getX() == x && e.getY() == y && e.getZ() == z && e.xOld == x && e.yOld == y && e.zOld == z) continue;
                e.setPos(x, y, z);
                e.setOldPosAndRot();
            }
        }
    }

    private static boolean onDeck(LivingWorld.Mover m, Anim a, LocalPlayer p) {
        double[] d = m.deck;
        return p.getX() >= a.x + d[0] - 0.3 && p.getX() <= a.x + d[3] + 0.3 && p.getZ() >= a.z + d[2] - 0.3 && p.getZ() <= a.z + d[5] + 0.3 && Math.abs(p.getY() - (a.y + d[4])) < 0.12;
    }

    /**
     * The floor under the rider: client-only boxes that go where the mover is drawn. The deck is laid in tiles
     * no wider than two blocks, because the game looks for things to collide with only within two blocks of
     * where each thing is registered; one wide box is missed when its corner crosses into the next chunk.
     */
    private static void deck(LivingWorld.Mover m, Anim a, double x, double y, double z) {
        if (m.deck == null) return;
        if (a.tiles == null) {
            List<double[]> tiles = new ArrayList<>();
            for (double tx = m.deck[0]; tx < m.deck[3] - 1e-6; tx += 2) for (double tz = m.deck[2]; tz < m.deck[5] - 1e-6; tz += 2) tiles.add(new double[] {tx, tz, Math.min(2, m.deck[3] - tx), Math.min(2, m.deck[5] - tz)});
            a.tiles = tiles.toArray(new double[0][]);
            a.deck = new DeckEntity[a.tiles.length];
        }
        for (int i = 0; i < a.tiles.length; i++) {
            double[] t = a.tiles[i];
            if (a.deck[i] == null || a.deck[i].isRemoved() || a.deck[i].level() != level) {
                a.deck[i] = new DeckEntity(ModEntities.DECK, level);
                a.deck[i].setId(nextDeckId--);
                a.deck[i].size(t[2], m.deck[4] - m.deck[1], t[3]);
                a.deck[i].snapTo(x + t[0], y + m.deck[1], z + t[1]);
                level.addEntity(a.deck[i]);
            } else a.deck[i].setPos(x + t[0], y + m.deck[1], z + t[1]);
        }
    }

    /** The head turns through its keys; the body is left where the world (or a raft) has put it. */
    private static void look(Minecraft mc) {
        double[][] keys = lookKeys;
        LocalPlayer p = mc.player;
        if (keys == null || p == null) return;
        double t = (System.nanoTime() - lookStart) / 1e9, t0 = 0;
        float yaw0 = lookFromYaw, pitch0 = lookFromPitch, yaw = yaw0, pitch = pitch0;
        boolean done = true;
        for (double[] k : keys) {
            if (t < k[0]) { double u = (t - t0) / Math.max(1e-6, k[0] - t0); u = u * u * (3 - 2 * u); yaw = yaw0 + (float) (Mth.wrapDegrees(k[1] - yaw0) * u); pitch = pitch0 + (float) ((k[2] - pitch0) * u); done = false; break; }
            t0 = k[0]; yaw0 = (float) k[1]; pitch0 = (float) k[2]; yaw = yaw0; pitch = pitch0;
        }
        p.setYRot(yaw); p.setXRot(pitch); p.yRotO = yaw; p.xRotO = p.getXRot(); p.setYHeadRot(yaw); p.yHeadRotO = yaw; p.setYBodyRot(yaw); p.yBodyRotO = yaw;
        if (done) lookKeys = null;
    }

    /** End of a rendered frame (MinecraftMixin): the trace of what was actually drawn. */
    public static void afterRender(Minecraft mc) {
        if (traceKey == null) return;
        long now = System.nanoTime();
        if (now > traceUntil || mc.level == null || TRACE.size() > 40_000) return;
        LivingWorld.Mover m = LivingWorld.mover(traceKey);
        Entity e = m == null || m.ids.length == 0 ? null : mc.level.getEntity(m.ids[0]);
        float pt = mc.getDeltaTracker().getGameTimeDeltaPartialTick(true);
        Vec3 cam = mc.gameRenderer.mainCamera().position();
        TRACE.add(new double[] {now / 1e6, cam.x, cam.y, cam.z, e == null ? Double.NaN : Mth.lerp(pt, e.xOld, e.getX()), e == null ? Double.NaN : Mth.lerp(pt, e.yOld, e.getY()), e == null ? Double.NaN : Mth.lerp(pt, e.zOld, e.getZ())});
    }
}
