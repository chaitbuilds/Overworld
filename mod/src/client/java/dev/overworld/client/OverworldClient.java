package dev.overworld.client;

import dev.overworld.Overworld;
import dev.overworld.client.dev.DevBridge;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientLifecycleEvents;
import net.fabricmc.fabric.api.client.screen.v1.ScreenEvents;
import net.minecraft.client.gui.screens.PauseScreen;
import net.minecraft.client.Minecraft;
import net.minecraft.sounds.SoundSource;

/** Client entrypoint: auto-world, mute policy, DevBridge, and every client feature (ClientFeatures). */
public class OverworldClient implements ClientModInitializer {
	@Override
	public void onInitializeClient() {
		AutoWorld.init();
		ClientFeatures.init();
		ClientLifecycleEvents.CLIENT_STARTED.register(OverworldClient::onStarted);
		ClientLifecycleEvents.CLIENT_STOPPING.register(client -> DevBridge.stopBridge());
		ScreenEvents.BEFORE_INIT.register((client, screen, w, h) -> {
			if (screen instanceof PauseScreen) { // init runs on open and on resize
				logPauseOrigin(client);
			}
		});
		Overworld.LOGGER.info("Overworld client init (devPort={}, mute={}, takeFocus={}, autoWorld={})",
			ClientEnv.DEV_PORT, ClientEnv.MUTE, ClientEnv.TAKE_FOCUS, ClientEnv.AUTO_WORLD);
	}

	/** Diagnostic: unattended runs showed a pause menu nobody asked for; log who opened it. */
	private static void logPauseOrigin(Minecraft mc) {
		StringBuilder sb = new StringBuilder();
		StackTraceElement[] st = Thread.currentThread().getStackTrace();
		for (int i = 2, n = 0; i < st.length && n < 12; i++) {
			String cls = st[i].getClassName();
			if (cls.startsWith("net.minecraft") || cls.startsWith("com.mojang") || cls.startsWith("dev.overworld")) {
				sb.append(System.lineSeparator()).append("    at ").append(st[i]);
				n++;
			}
		}
		Overworld.LOGGER.info("Pause screen opening (sdlFocused={}, pauseOnLostFocus={}):{}", mc.getWindow().isFocused(), mc.options.pauseOnLostFocus, sb);
	}

	private static void onStarted(Minecraft mc) {
		if (ClientEnv.MUTE) {
			// Runs before the first client tick, so no sound/music ever plays.
			mc.options.getSoundSourceOptionInstance(SoundSource.MASTER).set(0.0);
			mc.options.getSoundSourceOptionInstance(SoundSource.MUSIC).set(0.0);
			Overworld.LOGGER.info("Muted (OVERWORLD_MUTE=1)");
		}
		// Never pause because the window is in the background (also enforced via options template).
		mc.options.pauseOnLostFocus = false;
		DevBridge.startBridge();
	}
}
