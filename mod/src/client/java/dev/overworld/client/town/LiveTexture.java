package dev.overworld.client.town;

import com.mojang.blaze3d.platform.NativeImage;
import com.mojang.blaze3d.systems.RenderSystem;
import com.mojang.renderpearl.api.device.GpuDevice;
import com.mojang.renderpearl.api.textures.AddressMode;
import com.mojang.renderpearl.api.textures.FilterMode;
import com.mojang.renderpearl.api.GpuFormat;
import com.mojang.renderpearl.api.textures.GpuTexture;
import net.minecraft.client.renderer.texture.AbstractTexture;

/**
 * A fixed-size texture that is rewritten many times a second: a live page on a wall. Three mip levels
 * and linear filtering, so it stays readable up close and does not shimmer from across the water.
 */
final class LiveTexture extends AbstractTexture {
    static final int LEVELS = 3;
    final int width, height;

    LiveTexture(String label, int width, int height) {
        this.width = width; this.height = height;
        GpuDevice device = RenderSystem.getDevice();
        this.texture = device.createTexture(label, GpuTexture.USAGE_COPY_DST | GpuTexture.USAGE_TEXTURE_BINDING, GpuFormat.RGBA8_UNORM, width, height, 1, LEVELS);
        this.sampler = RenderSystem.getSamplerCache().getSampler(AddressMode.CLAMP_TO_EDGE, AddressMode.CLAMP_TO_EDGE, FilterMode.LINEAR, FilterMode.LINEAR, true);
        this.textureView = device.createTextureView(this.texture);
    }

    /** Write a frame and its smaller copies (render thread). The images stay the caller's to close. */
    void write(NativeImage[] levels) {
        if (this.texture == null) return;
        var encoder = RenderSystem.getDevice().createCommandEncoder();
        for (int level = 0; level < levels.length && level < LEVELS; level++) encoder.writeToTexture(this.texture, levels[level], level, 0, 0, 0);
    }

    /** Half-size copy by averaging 2x2 blocks (any thread). Reads and writes the pixel memory directly: this runs for every frame of every wall. */
    static NativeImage half(NativeImage source) {
        int sw = source.getWidth(), w = Math.max(1, sw / 2), h = Math.max(1, source.getHeight() / 2);
        NativeImage out = new NativeImage(w, h, false);
        long from = source.getPointer(), to = out.getPointer();
        for (int y = 0; y < h; y++) {
            long top = from + 4L * (2L * y * sw), bottom = top + 4L * sw, dest = to + 4L * y * w;
            for (int x = 0; x < w; x++) {
                int a = org.lwjgl.system.MemoryUtil.memGetInt(top + 8L * x), b = org.lwjgl.system.MemoryUtil.memGetInt(top + 8L * x + 4), c = org.lwjgl.system.MemoryUtil.memGetInt(bottom + 8L * x), d = org.lwjgl.system.MemoryUtil.memGetInt(bottom + 8L * x + 4);
                // four 8-bit channels averaged in two halves of the word, so no channel carries into its neighbour
                int even = (((a & 0x00FF00FF) + (b & 0x00FF00FF) + (c & 0x00FF00FF) + (d & 0x00FF00FF) + 0x00020002) >>> 2) & 0x00FF00FF;
                int odd = ((((a >>> 8) & 0x00FF00FF) + ((b >>> 8) & 0x00FF00FF) + ((c >>> 8) & 0x00FF00FF) + ((d >>> 8) & 0x00FF00FF) + 0x00020002) >>> 2) & 0x00FF00FF;
                org.lwjgl.system.MemoryUtil.memPutInt(dest + 4L * x, even | odd << 8);
            }
        }
        return out;
    }
}
