package dev.overworld.client.agents;

import dev.overworld.Overworld;
import dev.overworld.Cast;
import java.util.HashMap;
import java.util.Map;
import net.minecraft.client.Minecraft;
import net.minecraft.client.resources.DefaultPlayerSkin;
import net.minecraft.core.ClientAsset;
import net.minecraft.resources.Identifier;
import net.minecraft.world.entity.player.PlayerModelType;
import net.minecraft.world.entity.player.PlayerSkin;

/**
 * Agent skins: {@code assets/overworld/textures/entity/agent/<skin>.png} (64x64, both layers) with
 * the arm model from cast.json ({@code slim} = 3 px arms). Unknown skins fall back to a vanilla
 * default skin so a new Foreman agent still renders.
 */
public final class AgentSkins {
	private static final Map<String, PlayerSkin> CACHE = new HashMap<>();

	private AgentSkins() {
	}

	public static PlayerSkin get(String agentId, String skinId) {
		return CACHE.computeIfAbsent(agentId + "|" + skinId, k -> create(agentId, skinId));
	}

	private static PlayerSkin create(String agentId, String skinId) {
		Identifier asset = Overworld.id("entity/agent/" + skinId);
		ClientAsset.ResourceTexture tex = new ClientAsset.ResourceTexture(asset);
		Cast.Member m = Cast.get(agentId);
		if (m == null) {
			m = Cast.get(skinId);
		}
		boolean exists = Minecraft.getInstance().getResourceManager().getResource(tex.texturePath()).isPresent();
		if (!exists) {
			Overworld.LOGGER.warn("No skin texture {} for agent {}; using a default skin", tex.texturePath(), agentId);
			return DefaultPlayerSkin.get(java.util.UUID.nameUUIDFromBytes(agentId.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
		}
		return PlayerSkin.insecure(tex, null, null, m != null && m.slim() ? PlayerModelType.SLIM : PlayerModelType.WIDE);
	}

	public static void clear() {
		CACHE.clear();
	}
}
