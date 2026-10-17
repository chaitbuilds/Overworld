package dev.overworld.layout;

/**
 * Station names: the protocol's {@code Agent.station} values (besides {@code desk}) that an agent's
 * posture follows (reading at the library, typing at the terminal, leaning on the test bench,
 * reviewing at the merge station, waiting for the user, relaxing in the lounge).
 */
public final class AnchorNames {
	public static final String LIBRARY = "library";
	public static final String TERMINAL = "terminal";
	public static final String TESTBENCH = "testbench";
	public static final String MERGESTATION = "mergestation";
	public static final String MEETING = "meeting";
	public static final String LOUNGE = "lounge";
	public static final String USER = "user";

	private AnchorNames() {
	}
}
