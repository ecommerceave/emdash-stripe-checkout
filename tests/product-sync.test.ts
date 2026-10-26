
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "emdash/plugin";

import { createStripePrice } from "../src/products/stripe-api.js";
import {
    claimPriceOperation,
    markPriceOperationRetryable,
    completePriceOperation,
} from "../src/products/price-operation.js";

describe("Stripe Product Price synchronization", () => {
    it("uses a unique idempotency key for separate price creation attempts", async () => {
        const fetch = vi.fn()
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({ id: "price_test_first" }),
                    { status: 200 },
                ),
            )
            .mockResolvedValueOnce(
                new Response(
                    JSON.stringify({ id: "price_test_second" }),
                    { status: 200 },
                ),
            );

        const ctx = {
            http: { fetch },
        } as unknown as PluginContext;

        const input = {
            contentId: "product_test",
            stripeProductId: "prod_test",
            currency: "usd",
            unitAmount: 2500,
            stripeSecretKey: "sk_test_example",
            operationId: "price-change-first",
        };

        const firstPrice = await createStripePrice(ctx, input);
        const secondPrice = await createStripePrice(ctx, {
            ...input,
            operationId: "price-change-second",
        });

        expect(firstPrice).toBe("price_test_first");
        expect(secondPrice).toBe("price_test_second");

        expect(fetch).toHaveBeenCalledTimes(2);

        const firstRequest = fetch.mock.calls[0][1];
        const secondRequest = fetch.mock.calls[1][1];

        const firstKey = new Headers(
            firstRequest.headers,
        ).get("Idempotency-Key");

        const secondKey = new Headers(
            secondRequest.headers,
        ).get("Idempotency-Key");

        expect(firstKey).toBeTruthy();
        expect(secondKey).toBeTruthy();
        expect(firstKey).not.toBe(secondKey);
    });

    it("reuses one operation ID for concurrent price claims", async () => {
        let revision = "revision-1";

        const state = {
            stripeProductId: "prod_test",
            stripePriceId: "price_old",
            price: 25,
            currency: "usd",
        };

        let storedState: typeof state & {
            pendingPriceOperation?: {
                operationId: string;
                stripeProductId: string;
                currency: string;
                unitAmount: number;
            };
        } = { ...state };

        const getVersioned = vi.fn(async () => ({
            value: { ...storedState },
            revision,
        }));

        const compareAndSet = vi.fn(
            async (
                _key: string,
                expectedRevision: string | null,
                value: typeof storedState,
            ) => {
                if (expectedRevision !== revision) {
                    return { applied: false as const };
                }

                storedState = value;
                revision = "revision-2";

                return {
                    applied: true as const,
                    revision,
                };
            },
        );

        const ctx = {
            kv: {
                getVersioned,
                compareAndSet,
            },
        } as unknown as PluginContext;

        const [first, second] = await Promise.all([
            claimPriceOperation(
                ctx,
                "state:product:product_test",
                "prod_test",
                "usd",
                3000,
            ),
            claimPriceOperation(
                ctx,
                "state:product:product_test",
                "prod_test",
                "usd",
                3000,
            ),
        ]);

        expect(first).not.toBeNull();
        expect(second).not.toBeNull();

        expect(first?.operationId).toBe(second?.operationId);

        expect(storedState.pendingPriceOperation?.operationId)
            .toBe(first?.operationId);

        // Exactly one request must acquire ownership.
        const acquiredCount = [first, second].filter(
            (claim) => claim?.acquired === true,
        ).length;

        expect(acquiredCount).toBe(1);

        // Both requests must recognize the same operation,
        // but only the owner should initiate Stripe Price creation.
        expect([first?.acquired, second?.acquired].sort()).toEqual([
            false,
            true,
        ]);
    });

    it("does not overwrite a different pending Stripe Price operation", async () => {
        const existingState = {
            stripeProductId: "prod_test",
            stripePriceId: "price_old",
            price: 25,
            currency: "usd",
            pendingPriceOperation: {
                operationId: "existing-operation",
                stripeProductId: "prod_test",
                currency: "usd",
                unitAmount: 3000,
            },
        };

        const getVersioned = vi.fn().mockResolvedValue({
            value: existingState,
            revision: "revision-1",
        });

        const compareAndSet = vi.fn();

        const ctx = {
            kv: {
                getVersioned,
                compareAndSet,
            },
        } as unknown as PluginContext;

        // A different publish event attempts to change the price to $35.
        const result = await claimPriceOperation(
            ctx,
            "state:product:product_test",
            "prod_test",
            "usd",
            3500,
        );

        expect(result).toBeNull();

        // The existing operation must remain untouched.
        expect(compareAndSet).not.toHaveBeenCalled();
        expect(existingState.pendingPriceOperation.operationId)
            .toBe("existing-operation");
    });

    it("marks a failed Stripe Price operation as retryable", async () => {
        let revision = "revision-1";

        const storedState = {
            stripeProductId: "prod_test",
            stripePriceId: "price_old",
            price: 25,
            currency: "usd",
            pendingPriceOperation: {
                operationId: "original-operation-123",
                attemptId: "attempt-123",
                stripeProductId: "prod_test",
                currency: "usd",
                unitAmount: 3000,
                status: "processing" as "processing" | "retryable",
            },
        };

        const getVersioned = vi.fn(async () => ({
            value: structuredClone(storedState),
            revision,
        }));

        const compareAndSet = vi.fn(async (
            _key: string,
            expectedRevision: string | null,
            value: typeof storedState,
        ) => {
            if (expectedRevision !== revision) {
                return { applied: false as const };
            }

            Object.assign(storedState, value);
            revision = "revision-2";

            return {
                applied: true as const,
                revision,
            };
        });

        const ctx = {
            kv: {
                getVersioned,
                compareAndSet,
            },
        } as unknown as PluginContext;

        const result = await markPriceOperationRetryable(
            ctx,
            "state:product:product_test",
            "original-operation-123",
            "attempt-123",
        );

        expect(result).toBe(true);
        expect(storedState.pendingPriceOperation.status).toBe("retryable");
        expect(storedState.pendingPriceOperation.operationId).toBe(
            "original-operation-123",
        );
        expect(compareAndSet).toHaveBeenCalledTimes(1);

        // Simulate a newer worker taking ownership of the same operation.
        storedState.pendingPriceOperation.attemptId = "new-attempt";
        storedState.pendingPriceOperation.status = "processing";

        compareAndSet.mockClear();

        // An older worker must not change the newer attempt's status.
        const staleResult = await markPriceOperationRetryable(
            ctx,
            "state:product:product_test",
            "original-operation-123",
            "attempt-123",
        );

        expect(staleResult).toBe(false);
        expect(storedState.pendingPriceOperation.status).toBe("processing");
        expect(storedState.pendingPriceOperation.attemptId).toBe("new-attempt");
        expect(compareAndSet).not.toHaveBeenCalled();
    });

    it("atomically reclaims a retryable Stripe Price operation", async () => {
        let revision = "revision-1";

        const storedState = {
            stripeProductId: "prod_test",
            stripePriceId: "price_old",
            price: 25,
            currency: "usd",
            pendingPriceOperation: {
                operationId: "original-operation-123",
                stripeProductId: "prod_test",
                currency: "usd",
                unitAmount: 3000,
                status: "retryable" as "processing" | "retryable",
                createdAt: Date.now() - 10 * 60 * 1000,
            },
        };

        const getVersioned = vi.fn(async () => ({
            value: structuredClone(storedState),
            revision,
        }));

        const compareAndSet = vi.fn(async (
            _key: string,
            expectedRevision: string | null,
            value: typeof storedState,
        ) => {
            if (expectedRevision !== revision) {
                return { applied: false as const };
            }

            Object.assign(storedState, value);
            revision = "revision-2";

            return {
                applied: true as const,
                revision,
            };
        });

        const ctx = {
            kv: {
                getVersioned,
                compareAndSet,
            },
        } as unknown as PluginContext;

        const [first, second] = await Promise.all([
            claimPriceOperation(
                ctx,
                "state:product:product_test",
                "prod_test",
                "usd",
                3000,
            ),
            claimPriceOperation(
                ctx,
                "state:product:product_test",
                "prod_test",
                "usd",
                3000,
            ),
        ]);

        expect(first?.operationId).toBe("original-operation-123");
        expect(second?.operationId).toBe("original-operation-123");

        expect([first?.acquired, second?.acquired].sort()).toEqual([
            false,
            true,
        ]);

        expect(storedState.pendingPriceOperation.status).toBe("processing");
        expect(storedState.pendingPriceOperation.operationId).toBe(
            "original-operation-123",
        );
    });

    it("recovers a timed-out Stripe Price operation with a new ownership token", async () => {
        let revision = "revision-1";

        const originalAttemptId = "original-attempt-123";
        const originalOperationId = "original-operation-123";
        const originalCreatedAt = Date.now() - 10 * 60 * 1000;
        const originalProcessingStartedAt = Date.now() - 6 * 60 * 1000;

        const storedState = {
            stripeProductId: "prod_test",
            stripePriceId: "price_old",
            price: 25,
            currency: "usd",
            pendingPriceOperation: {
                operationId: originalOperationId,
                attemptId: originalAttemptId,
                stripeProductId: "prod_test",
                currency: "usd",
                unitAmount: 3000,
                status: "processing" as "processing" | "retryable",
                createdAt: originalCreatedAt,
                processingStartedAt: originalProcessingStartedAt,
            },
        };

        const getVersioned = vi.fn(async () => ({
            value: structuredClone(storedState),
            revision,
        }));

        const compareAndSet = vi.fn(async (
            _key: string,
            expectedRevision: string | null,
            value: typeof storedState,
        ) => {
            if (expectedRevision !== revision) {
                return { applied: false as const };
            }

            Object.assign(storedState, value);
            revision = "revision-2";

            return {
                applied: true as const,
                revision,
            };
        });

        const ctx = {
            kv: {
                getVersioned,
                compareAndSet,
            },
        } as unknown as PluginContext;

        const claim = await claimPriceOperation(
            ctx,
            "state:product:product_test",
            "prod_test",
            "usd",
            3000,
        );

        expect(claim?.acquired).toBe(true);
        expect(claim?.operationId).toBe(originalOperationId);
        expect(claim?.attemptId).toBeDefined();
        expect(claim?.attemptId).not.toBe(originalAttemptId);

        expect(storedState.pendingPriceOperation.operationId).toBe(
            originalOperationId,
        );
        expect(storedState.pendingPriceOperation.attemptId).toBe(
            claim?.attemptId,
        );
        expect(storedState.pendingPriceOperation.createdAt).toBe(
            originalCreatedAt,
        );
        expect(storedState.pendingPriceOperation.processingStartedAt).toBeGreaterThan(
            originalProcessingStartedAt,
        );
        expect(storedState.pendingPriceOperation.status).toBe("processing");
        expect(compareAndSet).toHaveBeenCalledTimes(1);
    });

    it("does not reclaim a Stripe Price operation before its timeout", async () => {
        const now = Date.now();

        const storedState = {
            stripeProductId: "prod_test",
            stripePriceId: "price_old",
            price: 25,
            currency: "usd",
            pendingPriceOperation: {
                operationId: "original-operation-123",
                attemptId: "original-attempt-123",
                stripeProductId: "prod_test",
                currency: "usd",
                unitAmount: 3000,
                status: "processing" as "processing" | "retryable",
                createdAt: now - 2 * 60 * 1000,
                processingStartedAt: now - 60 * 1000,
            },
        };

        const getVersioned = vi.fn(async () => ({
            value: structuredClone(storedState),
            revision: "revision-1",
        }));

        const compareAndSet = vi.fn();

        const ctx = {
            kv: {
                getVersioned,
                compareAndSet,
            },
        } as unknown as PluginContext;

        const claim = await claimPriceOperation(
            ctx,
            "state:product:product_test",
            "prod_test",
            "usd",
            3000,
        );

        expect(claim?.acquired).toBe(false);
        expect(claim?.operationId).toBe("original-operation-123");
        expect(storedState.pendingPriceOperation.attemptId).toBe(
            "original-attempt-123",
        );
        expect(compareAndSet).not.toHaveBeenCalled();
    });
    
    it("does not reclaim a Stripe Price operation outside the idempotency window", async () => {
        const now = Date.now();

        const storedState = {
            stripeProductId: "prod_test",
            stripePriceId: "price_old",
            price: 25,
            currency: "usd",
            pendingPriceOperation: {
                operationId: "original-operation-123",
                attemptId: "original-attempt-123",
                stripeProductId: "prod_test",
                currency: "usd",
                unitAmount: 3000,
                status: "processing" as "processing" | "retryable",
                createdAt: now - 24 * 60 * 60 * 1000,
                processingStartedAt: now - 10 * 60 * 1000,
            },
        };

        const getVersioned = vi.fn(async () => ({
            value: structuredClone(storedState),
            revision: "revision-1",
        }));

        const compareAndSet = vi.fn();

        const ctx = {
            kv: {
                getVersioned,
                compareAndSet,
            },
        } as unknown as PluginContext;

        const claim = await claimPriceOperation(
            ctx,
            "state:product:product_test",
            "prod_test",
            "usd",
            3000,
        );

        expect(claim?.acquired).toBe(false);
        expect(claim?.operationId).toBe("original-operation-123");
        expect(storedState.pendingPriceOperation.attemptId).toBe(
            "original-attempt-123",
        );
        expect(storedState.pendingPriceOperation.status).toBe("processing");
        expect(compareAndSet).not.toHaveBeenCalled();
    });

    it("does not automatically recover a legacy operation without timestamps", async () => {
        const storedState = {
            stripeProductId: "prod_test",
            stripePriceId: "price_old",
            price: 25,
            currency: "usd",
            pendingPriceOperation: {
                operationId: "legacy-operation-123",
                stripeProductId: "prod_test",
                currency: "usd",
                unitAmount: 3000,
                status: "processing" as "processing" | "retryable",
            },
        };

        const getVersioned = vi.fn(async () => ({
            value: structuredClone(storedState),
            revision: "revision-1",
        }));

        const compareAndSet = vi.fn();

        const ctx = {
            kv: {
                getVersioned,
                compareAndSet,
            },
        } as unknown as PluginContext;

        const claim = await claimPriceOperation(
            ctx,
            "state:product:product_test",
            "prod_test",
            "usd",
            3000,
        );

        expect(claim?.acquired).toBe(false);
        expect(claim?.operationId).toBe("legacy-operation-123");
        expect(storedState.pendingPriceOperation.status).toBe("processing");
        expect(compareAndSet).not.toHaveBeenCalled();
    });
    
    it("does not reclaim an expired retryable Stripe Price operation", async () => {
        const now = Date.now();

        const storedState = {
            stripeProductId: "prod_test",
            stripePriceId: "price_old",
            price: 25,
            currency: "usd",
            pendingPriceOperation: {
                operationId: "expired-operation-123",
                attemptId: "expired-attempt-123",
                stripeProductId: "prod_test",
                currency: "usd",
                unitAmount: 3000,
                status: "retryable" as "processing" | "retryable",
                createdAt: now - 24 * 60 * 60 * 1000,
                processingStartedAt: now - 24 * 60 * 60 * 1000,
            },
        };

        const getVersioned = vi.fn(async () => ({
            value: structuredClone(storedState),
            revision: "revision-1",
        }));

        const compareAndSet = vi.fn();

        const ctx = {
            kv: {
                getVersioned,
                compareAndSet,
            },
        } as unknown as PluginContext;

        const claim = await claimPriceOperation(
            ctx,
            "state:product:product_test",
            "prod_test",
            "usd",
            3000,
        );

        expect(claim?.acquired).toBe(false);
        expect(claim?.operationId).toBe("expired-operation-123");
        expect(storedState.pendingPriceOperation.status).toBe("retryable");
        expect(storedState.pendingPriceOperation.attemptId).toBe(
            "expired-attempt-123",
        );
        expect(compareAndSet).not.toHaveBeenCalled();
    });
    
    it("atomically completes a successful Stripe Price operation", async () => {
        let revision = "revision-1";

        const storedState = {
            stripeProductId: "prod_test",
            stripePriceId: "price_old",
            price: 25,
            currency: "usd",
            pendingPriceOperation: {
                operationId: "operation-123",
                attemptId: "attempt-123",
                stripeProductId: "prod_test",
                currency: "usd",
                unitAmount: 3000,
                status: "processing" as "processing" | "retryable",
            },
        };

        const getVersioned = vi.fn(async () => ({
            value: structuredClone(storedState),
            revision,
        }));

        const compareAndSet = vi.fn(async (
            _key: string,
            expectedRevision: string | null,
            value: typeof storedState,
        ) => {
            if (expectedRevision !== revision) {
                return { applied: false as const };
            }

            Object.assign(storedState, value);
            revision = "revision-2";

            return {
                applied: true as const,
                revision,
            };
        });

        const ctx = {
            kv: {
                getVersioned,
                compareAndSet,
            },
        } as unknown as PluginContext;

        const completed = await completePriceOperation(
            ctx,
            "state:product:product_test",
            "operation-123",
            "attempt-123",
            "price_new",
            30,
            "usd",
        );

        expect(completed).toBe(true);
        expect(storedState.stripeProductId).toBe("prod_test");
        expect(storedState.stripePriceId).toBe("price_new");
        expect(storedState.price).toBe(30);
        expect(storedState.currency).toBe("usd");
        expect(storedState.pendingPriceOperation).toBeUndefined();
        expect(compareAndSet).toHaveBeenCalledTimes(1);

        // A completed operation cannot be completed again.
        const completedAgain = await completePriceOperation(
            ctx,
            "state:product:product_test",
            "operation-123",
            "attempt-123",
            "price_duplicate",
            30,
            "usd",
        );

        expect(completedAgain).toBe(false);
        expect(storedState.stripePriceId).toBe("price_new");

        // An outdated worker must not complete an operation
        // owned by a different attempt.
        const staleState = {
            ...storedState,
            pendingPriceOperation: {
                operationId: "operation-456",
                attemptId: "current-attempt",
                stripeProductId: "prod_test",
                currency: "usd",
                unitAmount: 3500,
                status: "processing" as "processing" | "retryable",
            },
        };

        const staleGetVersioned = vi.fn(async () => ({
            value: structuredClone(staleState),
            revision: "revision-3",
        }));

        const staleCompareAndSet = vi.fn();

        const staleCtx = {
            kv: {
                getVersioned: staleGetVersioned,
                compareAndSet: staleCompareAndSet,
            },
        } as unknown as PluginContext;

        const staleCompleted = await completePriceOperation(
            staleCtx,
            "state:product:product_test",
            "operation-456",
            "old-attempt",
            "price_stale",
            35,
            "usd",
        );

        expect(staleCompleted).toBe(false);
        expect(staleState.stripePriceId).toBe("price_new");
        expect(staleCompareAndSet).not.toHaveBeenCalled();
    });
});
