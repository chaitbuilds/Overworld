package dev.overworld.client.agents;

import net.minecraft.client.renderer.entity.state.AvatarRenderState;
import org.jspecify.annotations.Nullable;

/**
 * Render state of an agent: the vanilla avatar state (model, skin, walk cycle) plus Overworld's
 * extras. {@link #renderer} routes the submit back to {@link AgentRenderer} (vanilla would send any
 * AvatarRenderState to the player renderer; see EntityRenderDispatcherMixin).
 */
public class AgentRenderState extends AvatarRenderState {
	public @Nullable AgentRenderer renderer;
	public String agentId = "";
	public AgentPose pose = AgentPose.STAND;
	/** The nameplate to draw this frame (the compact name pill in the town), or null (too far). */
	public Nameplate.@Nullable Data plate;
	/** World size factor of the plate ({@link Nameplate#distanceScale}). */
	public float plateScale = 1f;
	/** Seconds since the client started (for pulses), partial-tick accurate. */
	public float timeSeconds;

	// ---------------------------------------------------------------- agent life (Phase 3)

	/** The agent's life state (poses, particles, speech); the model and the extras read it. */
	public @Nullable AgentLife life;
	/** Pose channels interpolated for this frame ({@link AgentLife#frame}, see {@link AgentLife} P_* indices). */
	public float @Nullable [] posePose;
	/** Seated amount 0..1 (sit-down/stand-up blend). */
	public float sit;
	/** Vertical model offset (blocks) applied in setupRotations: the seat drop times {@link #sit}. */
	public float sitDrop;
	/** Open book in the hands (0 = none, 1 = open). */
	public float book;
	/** Page flip progress 0..1 of the held book. */
	public float pageFlip;
	/** Height of the plate's natural bottom above the feet (blocks): {@link Nameplate#HEIGHT} + seat drop. */
	public float plateBase = (float) Nameplate.HEIGHT;
	/** Seated at a desk/terminal with its own monitor (the plate gives way to the monitor up close). */
	public boolean atMonitor;
	/** Extra plate-space pixels stacked above the plate this frame (speech bubble, "!" marker). */
	public float stackHeight;
	/** "Needs you" marker above the plate: 0 = hidden, 1 = fully shown. */
	public float exclaim;
	/** Speech bubble visibility 0..1 (pop in/out). */
	public float bubble;
	/** Partial tick this state was extracted with. */
	public float partialTick;
	/** Light at the agent (for lit extras like the book). */
	public int agentLight;
}
