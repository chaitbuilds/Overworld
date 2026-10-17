package dev.overworld.client.agents;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import dev.overworld.client.foreman.Foreman;
import dev.overworld.client.foreman.Protocol;
import dev.overworld.client.living.LivingTown;
import dev.overworld.layout.Anchor;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.world.phys.Vec3;

/**
 * The living town's cast: the backend's agents as people. An agent stands at a site only while the
 * town's own record lists it as working on that site's ask; everyone else waits on the green. Read
 * from the record every half second; nothing here decides or invents work.
 */
public final class LivingAgents {
    private static final Map<String, ClientAgentEntity> CAST = new LinkedHashMap<>();
    private static final Map<String, String> GOING = new HashMap<>();
    private static ClientLevel level;
    private static int nextEntityId = -62_001, ticks;
    private LivingAgents() {}

    public static void tick(Minecraft mc) {
        if (mc.level != level) { level = mc.level; CAST.clear(); GOING.clear(); }
        if (level == null || mc.player == null || ++ticks % 10 != 0) return;
        JsonObject town = LivingTown.town();
        double[] green = LivingTown.spot(town, "green");
        if (green == null) return;
        var state = Foreman.state();
        boolean stale = state.isStale();
        // where the record puts each agent: agent id -> the place of the ask it is working on
        Map<String, JsonObject> at = new HashMap<>();
        if (!stale && town.has("asks")) for (JsonElement el : town.getAsJsonArray("asks")) {
            JsonObject ask = el.getAsJsonObject();
            JsonArray working = ask.has("agents") ? ask.getAsJsonArray("agents") : null;
            JsonObject place = LivingTown.place(town, ask.get("place").getAsString());
            if (working != null && place != null) for (JsonElement id : working) at.put(id.getAsString(), place);
        }
        List<Protocol.Agent> agents = new ArrayList<>(state.agents().values());
        agents.sort(Comparator.comparing(Protocol.Agent::id));
        Map<String, Integer> crowd = new HashMap<>();
        int slot = 0;
        for (Protocol.Agent agent : agents) {
            ClientAgentEntity entity = CAST.get(agent.id());
            if (!agent.isActive()) { if (entity != null) { entity.discard(); CAST.remove(agent.id()); GOING.remove(agent.id()); } continue; }
            int wait = slot++;
            Anchor home = new Anchor("green", green[0] + (wait % 3) * 1.7 - 1.7, green[1], green[2] + (wait / 3) * 1.8, 180f, 0f), target = home;
            JsonObject place = at.get(agent.id());
            if (place != null && place.has("stand")) {
                JsonArray stand = place.getAsJsonArray("stand");
                String id = place.get("id").getAsString();
                int n = crowd.merge(id, 1, Integer::sum) - 1;
                float yaw = place.has("standYaw") ? place.get("standYaw").getAsFloat() : 180f;
                // side by side, at right angles to the way they face
                double side = (n % 2 == 0 ? 1 : -1) * 1.5 * ((n + 1) / 2), rad = Math.toRadians(yaw);
                target = new Anchor("site:" + id + ":" + n, stand.get(0).getAsDouble() + Math.cos(rad) * side, stand.get(1).getAsDouble(), stand.get(2).getAsDouble() + Math.sin(rad) * side, yaw, 0f);
            }
            if (entity == null || entity.isRemoved()) {
                entity = new ClientAgentEntity(level, agent.id(), AgentSkins.get(agent.id(), agent.skin()));
                entity.setId(nextEntityId--);
                entity.setPos(entity.motion().placeAt(home));
                level.addEntity(entity);
                CAST.put(agent.id(), entity); GOING.put(agent.id(), "green");
            }
            entity.view().update(agent, stale, null, 0);
            if (!target.name().equals(GOING.get(agent.id()))) {
                GOING.put(agent.id(), target.name());
                List<Vec3> route = new GridPathfinder(level).find(entity.position(), target.pos());
                if (route != null && !route.isEmpty()) entity.motion().walkTo(target, route);
                else entity.setPos(entity.motion().placeAt(target));
            }
        }
    }

    /** Where every cast member is and where it is going (for tools and tests). */
    public static JsonArray stateJson() {
        JsonArray out = new JsonArray();
        for (var e : CAST.entrySet()) {
            JsonObject o = new JsonObject();
            o.addProperty("id", e.getKey()); o.addProperty("name", e.getValue().view().name); o.addProperty("going", GOING.get(e.getKey()));
            o.addProperty("x", e.getValue().getX()); o.addProperty("y", e.getValue().getY()); o.addProperty("z", e.getValue().getZ()); o.addProperty("walking", e.getValue().motion().walking());
            o.addProperty("state", e.getValue().view().state.wire());
            out.add(o);
        }
        return out;
    }
}
