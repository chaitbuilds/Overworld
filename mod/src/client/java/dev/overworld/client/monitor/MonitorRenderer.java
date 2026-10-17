package dev.overworld.client.monitor;

import com.mojang.blaze3d.vertex.PoseStack;
import dev.overworld.block.entity.MonitorBlockEntity;
import dev.overworld.client.town.LivePanels;
import dev.overworld.client.ui.WorldUi;
import dev.overworld.client.world.StationRenderState;
import dev.overworld.client.world.StationRenderer;
import net.minecraft.client.renderer.SubmitNodeCollector;
import net.minecraft.client.renderer.rendertype.RenderTypes;
import net.minecraft.client.renderer.state.level.CameraRenderState;
import net.minecraft.resources.Identifier;
import net.minecraft.util.LightCoordsUtil;
import org.jspecify.annotations.Nullable;

/**
 * Monitor panel BER: a panel the town names for a live screen ({@link LivePanels}) shows that page's
 * newest picture over the whole connected surface, drawn once from the panel's origin block, full
 * bright, with the pointer on it. A panel with no live screen shows only its block model.
 */
public class MonitorRenderer extends StationRenderer<MonitorBlockEntity, MonitorRenderer.State> {
	/** Screen plane of the north-facing model (assets block contract), minus a hair to sit on top. */
	public static final float SCREEN_DEPTH = 12f / 16f - 0.002f;
	/** Default pixel density: 96 px per block. */
	public static final float PX_PER_BLOCK = 96f;

	/** Depth step towards the viewer between layers drawn on the same face (blocks; in face space -z faces the viewer). */
	static final float Z_STEP = -0.0012f;
	static final float Z_TINT = Z_STEP;
	static final float Z_BADGE = 6 * Z_STEP;
	static final float Z_BADGE_TEXT = 7 * Z_STEP;

	public static class State extends StationRenderState {
		/** The live page shown on this panel (LivePanels), and the pointer on it. */
		@Nullable Identifier live;
		boolean pointer;
		float pu, pv;
	}
	private static final Identifier WHITE = dev.overworld.Overworld.id("textures/gui/white.png");

	/** Pixel density for a panel: 1-block-high (or wide) screens get 128 px/block, bigger ones 96. */
	public static int density(int w, int h) {
		return Math.min(w, h) <= 1 ? 128 : (int) PX_PER_BLOCK;
	}

	@Override
	public State createRenderState() {
		return new State();
	}

	@Override
	public boolean shouldRenderOffScreen() {
		return true; // multi-block screens draw from the origin block only
	}

	@Override
	public int getViewDistance() {
		return 64;
	}

	@Override
	protected void extractStation(MonitorBlockEntity be, State s, float partialTicks) {
		LivePanels.extracted(be.getBlockPos(), s.panelOrigin, s.panelWidth, s.panelHeight);
		if (!s.panelOrigin) {
			return;
		}
		// a panel the town names for a live screen shows that page
		String screen = LivePanels.screenAt(be.getBlockPos());
		s.live = LivePanels.texture(screen);
		if (screen != null) {
			LivePanels.looked(be.getBlockPos(), screen, s.live != null);
			LivePanels.Pointer p = LivePanels.pointer(screen);
			s.pointer = p != null && p.shown;
			if (s.pointer) { s.pu = p.u; s.pv = p.v; }
		}
	}

	@Override
	public void submit(State s, PoseStack poseStack, SubmitNodeCollector collector, CameraRenderState camera) {
		if (s.panelOrigin && s.live != null) {
			drawLive(s, poseStack, collector);
		}
	}

	/** The live page over the whole panel, inside its bezel, full bright; the pointer as a white dot ringed in dark. */
	private void drawLive(State s, PoseStack ps, SubmitNodeCollector c) {
		int ppb = density(s.panelWidth, s.panelHeight);
		ps.pushPose();
		toFace(ps, s.facing, SCREEN_DEPTH, ppb);
		ps.translate(0, -(s.panelHeight - 1) * ppb, 0);
		float inset = ppb / 16f, x0 = inset, y0 = inset, x1 = s.panelWidth * ppb - inset, y1 = s.panelHeight * ppb - inset;
		Identifier image = s.live;
		int full = LightCoordsUtil.FULL_BRIGHT;
		c.order(0).submitCustomGeometry(ps, RenderTypes.text(image), (pose, vc) -> WorldUi.quad(pose, vc, x0, y0, x1, y1, Z_TINT, 0, 0, 1, 1, 0xFFFFFFFF, full));
		if (s.pointer) {
			float cx = x0 + (x1 - x0) * s.pu, cy = y0 + (y1 - y0) * s.pv, r = ppb / 9f;
			c.order(1).submitCustomGeometry(ps, RenderTypes.text(WHITE), (pose, vc) -> {
				WorldUi.quad(pose, vc, cx - r, cy - r, cx + r, cy + r, Z_BADGE, 0, 0, 1, 1, 0xFF10131A, full);
				WorldUi.quad(pose, vc, cx - r * 0.6f, cy - r * 0.6f, cx + r * 0.6f, cy + r * 0.6f, Z_BADGE_TEXT, 0, 0, 1, 1, 0xFFFFFFFF, full);
			});
		}
		ps.popPose();
	}
}
