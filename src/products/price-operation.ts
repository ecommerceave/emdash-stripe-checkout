
import type { PluginContext } from "emdash/plugin";

const PRICE_OPERATION_RECOVERY_TIMEOUT_MS = 5 * 60 * 1000;
const PRICE_OPERATION_IDEMPOTENCY_WINDOW_MS = 23 * 60 * 60 * 1000;

export type PendingPriceOperation = {
    operationId: string;
    attemptId?: string;
    stripeProductId: string;
    currency: string;
    unitAmount: number;
    status?: "processing" | "retryable";
    createdAt?: number;
    processingStartedAt?: number;
};

export type PriceOperationState = {
    stripeProductId?: string;
    stripePriceId?: string;
    price?: number;
    currency?: string;
    pendingPriceOperation?: PendingPriceOperation;
};

export type PriceOperationClaim = {
    state: PriceOperationState;
    operationId: string;
    attemptId?: string;
    acquired: boolean;
};

export async function claimPriceOperation(
    ctx: PluginContext,
    stateKey: string,
    stripeProductId: string,
    currency: string,
    unitAmount: number,
): Promise<PriceOperationClaim | null> {
    for (let attempt = 0; attempt < 5; attempt++) {
        const versioned =
            await ctx.kv.getVersioned<PriceOperationState>(stateKey);

        if (!versioned) {
            return null;
        }

        const state = versioned.value;
        const pending = state.pendingPriceOperation;
        const recoveryNow = Date.now();

        const processingTimedOut =
            pending?.status === "processing" &&
            typeof pending.processingStartedAt === "number" &&
            recoveryNow - pending.processingStartedAt >=
                PRICE_OPERATION_RECOVERY_TIMEOUT_MS;

        const withinIdempotencyWindow =
            typeof pending?.createdAt === "number" &&
            recoveryNow >= pending.createdAt &&
            recoveryNow - pending.createdAt <
                PRICE_OPERATION_IDEMPOTENCY_WINDOW_MS;

        // An existing operation for the same price must reuse
        // its original idempotency key.
        if (
            pending?.stripeProductId === stripeProductId &&
            pending.currency === currency &&
            pending.unitAmount === unitAmount
        ) {
            if (
                withinIdempotencyWindow &&
                (pending.status === "retryable" || processingTimedOut)
            ) {
                const attemptId = crypto.randomUUID();

                const result = await ctx.kv.compareAndSet(
                    stateKey,
                    versioned.revision,
                    {
                        ...state,
                        pendingPriceOperation: {
                            ...pending,
                            attemptId,
                            status: "processing",
                            processingStartedAt: Date.now(),
                        },
                    },
                );

                if (result.applied) {
                    return {
                        state,
                        operationId: pending.operationId,
                        attemptId,
                        acquired: true,
                    };
                }

                // Another request changed the operation.
                // Reload the latest state and try again.
                continue;
            }

            // An expired idempotency key cannot be safely retried.
            // Stripe may have created the Price even if the original
            // request failed before we received its response.
            if (!withinIdempotencyWindow) {
                console.error(
                    "[PLUGIN] Stripe Price operation requires manual reconciliation. Automatic recovery is unavailable.",
                    {
                        stateKey,
                        operationId: pending.operationId,
                        stripeProductId: pending.stripeProductId,
                        status: pending.status,
                        createdAt: pending.createdAt,
                        reason:
                            typeof pending.createdAt === "number"
                                ? "Idempotency recovery window expired or timestamp is invalid."
                                : "Operation has no creation timestamp.",
                    },
                );
            }

            return {
                state,
                operationId: pending.operationId,
                acquired: false,
            };
        }

        // Do not replace a different operation while it is pending.
        // This avoids allowing an older request to overwrite an
        // operation that another request has already claimed.
        if (pending) {
            console.warn(
                "[PLUGIN] Stripe Price synchronization is already pending.",
                {
                    stateKey,
                    pendingOperationId: pending.operationId,
                },
            );

            return null;
        }

        // A completed operation may already have updated the price
        // while this request was waiting to claim it.
        if (
            state.stripeProductId === stripeProductId &&
            state.stripePriceId &&
            state.currency === currency &&
            Math.round((state.price ?? NaN) * 100) === unitAmount
        ) {
            return null;
        }

        const operationId = crypto.randomUUID();
        const attemptId = crypto.randomUUID();
        const now = Date.now();

        const result = await ctx.kv.compareAndSet(
            stateKey,
            versioned.revision,
            {
                ...state,
                pendingPriceOperation: {
                    operationId,
                    attemptId,
                    stripeProductId,
                    currency,
                    unitAmount,
                    status: "processing",
                    createdAt: now,
                    processingStartedAt: now,
                },
            },
        );

        if (result.applied) {
            return {
                state,
                operationId,
                attemptId,
                acquired: true,
            };
        }
    }

    console.error(
        "[PLUGIN] Could not claim Stripe Price operation after concurrent updates.",
        { stateKey },
    );

    return null;
}

export async function markPriceOperationRetryable(
    ctx: PluginContext,
    stateKey: string,
    operationId: string,
    attemptId: string | undefined,
): Promise<boolean> {
    for (let attempt = 0; attempt < 5; attempt++) {
        const versioned =
            await ctx.kv.getVersioned<PriceOperationState>(stateKey);

        if (!versioned) {
            return false;
        }

        const state = versioned.value;
        const pending = state.pendingPriceOperation;

        // Never modify an operation that has been replaced
        // or already completed.
        if (
            !pending ||
            pending.operationId !== operationId ||
            !attemptId ||
            pending.attemptId !== attemptId ||
            pending.status !== "processing"
        ) {
            return false;
        }

        const result = await ctx.kv.compareAndSet(
            stateKey,
            versioned.revision,
            {
                ...state,
                pendingPriceOperation: {
                    ...pending,
                    status: "retryable",
                },
            },
        );

        if (result.applied) {
            return true;
        }
    }

    console.error(
        "[PLUGIN] Could not mark Stripe Price operation as retryable.",
        { stateKey, operationId },
    );

    return false;
}

export async function completePriceOperation(
    ctx: PluginContext,
    stateKey: string,
    operationId: string,
    attemptId: string | undefined,
    stripePriceId: string,
    price: number,
    currency: string,
): Promise<boolean> {
    for (let attempt = 0; attempt < 5; attempt++) {
        const versioned =
            await ctx.kv.getVersioned<PriceOperationState>(stateKey);

        if (!versioned) {
            return false;
        }

        const state = versioned.value;
        const pending = state.pendingPriceOperation;

        // Only the matching operation can complete.
        if (
            !pending ||
            pending.operationId !== operationId ||
            !attemptId ||
            pending.attemptId !== attemptId ||
            pending.status !== "processing"
        ) {
            return false;
        }

        // Atomically save the Stripe Price and clear the operation.
        const result = await ctx.kv.compareAndSet(
            stateKey,
            versioned.revision,
            {
                ...state,
                stripePriceId,
                price,
                currency,
                pendingPriceOperation: undefined,
            },
        );

        if (result.applied) {
            return true;
        }
    }

    console.error(
        "[PLUGIN] Could not complete Stripe Price operation.",
        { stateKey, operationId },
    );

    return false;
}

export async function discardOutdatedPriceOperation(
    ctx: PluginContext,
    stateKey: string,
    operationId: string,
    attemptId: string | undefined,
): Promise<boolean> {
    for (let attempt = 0; attempt < 5; attempt++) {
        const versioned =
            await ctx.kv.getVersioned<PriceOperationState>(stateKey);

        if (!versioned) {
            return false;
        }

        const state = versioned.value;
        const pending = state.pendingPriceOperation;

        // Only the worker that owns this operation may clear it.
        if (
            !pending ||
            pending.operationId !== operationId ||
            !attemptId ||
            pending.attemptId !== attemptId ||
            pending.status !== "processing"
        ) {
            return false;
        }

        const result = await ctx.kv.compareAndSet(
            stateKey,
            versioned.revision,
            {
                ...state,
                pendingPriceOperation: undefined,
            },
        );

        if (result.applied) {
            return true;
        }
    }

    console.error(
        "[PLUGIN] Could not discard outdated Stripe Price operation.",
        { stateKey, operationId },
    );

    return false;
}
