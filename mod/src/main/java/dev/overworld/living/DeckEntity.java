package dev.overworld.living;

import net.minecraft.network.syncher.SynchedEntityData;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.damagesource.DamageSource;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.storage.ValueInput;
import net.minecraft.world.level.storage.ValueOutput;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/**
 * The floor of a mover's deck: an invisible box the player's own movement collides with, so you
 * stand on a raft the way you stand on a block. It exists on the client only (the client moves it
 * with the raft every tick, see LivingFeature); a server-side instance removes itself.
 */
public class DeckEntity extends Entity {
    private double width = 1, height = 0.25, depth = 1;

    public DeckEntity(EntityType<? extends DeckEntity> type, Level level) {
        super(type, level);
        this.noPhysics = true;
        this.setNoGravity(true);
    }

    /** The box, with the entity's position at its low corner. */
    public void size(double width, double height, double depth) {
        this.width = width; this.height = height; this.depth = depth;
        this.setBoundingBox(this.makeBoundingBox(this.position()));
    }

    @Override
    protected AABB makeBoundingBox(Vec3 p) {
        return new AABB(p.x, p.y, p.z, p.x + width, p.y + height, p.z + depth);
    }

    @Override
    public void tick() {
        if (!level().isClientSide()) discard();
    }

    @Override
    public boolean canBeCollidedWith(Entity other) {
        return true;
    }

    @Override
    public boolean isPickable() {
        return false;
    }

    @Override
    public boolean isPushable() {
        return false;
    }

    @Override
    protected void defineSynchedData(SynchedEntityData.Builder entityData) {
    }

    @Override
    public boolean hurtServer(ServerLevel level, DamageSource source, float damage) {
        return false;
    }

    @Override
    protected void readAdditionalSaveData(ValueInput input) {
    }

    @Override
    protected void addAdditionalSaveData(ValueOutput output) {
    }
}
