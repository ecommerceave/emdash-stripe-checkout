
import { describe, expect, it, vi } from "vitest";
import type { PluginContext } from "emdash/plugin";

import {
    createStripePrice,
    deactivateStripePrice,
} from "../src/products/stripe-api.js";

import { syncProductAfterPublish } from "../src/products/sync.js";

import {
    claimPriceOperation,
    markPriceOperationRetryable,
    completePriceOperation,
    recoverPendingPriceDeactivations,
    claimPendingPriceDeactivation,
    releasePendingPriceDeactivationClaim,
} from "../src/products/price-operation.js";

describe("Stripe Product Price synchronization", () => {
    it.each([
        ["unsupported JPY", "JPY"],
        ["empty currency", ""],
        ["missing currency", undefined],
        ["null currency", null],
    ])(
        "rejects %s before contacting Stripe",
        async (_scenario, currency) => {
            const fetch = vi.fn();

            const productData = {
                name: "Test Product",
                price: 25,
                currency,
                active: true,
            };

            const ctx = {
                settings: {
                    get: vi.fn(async (key: string) => {
                        if (key === "productContentTypeSlug") {
                            return "products";
                        }

                        return null;
                    }),
                },
                content: {
                    get: vi.fn(async () => ({
                        id: "product_invalid_currency",
                        status: "published",
                        data: productData,
                    })),
                },
                http: { fetch },
                kv: {
                    get: vi.fn(),
                },
            } as unknown as PluginContext;

            await syncProductAfterPublish(
                {
                    collection: "products",
                    content: {
                        id: "product_invalid_currency",
                        data: productData,
                    },
                } as Parameters<typeof syncProductAfterPublish>[0],
                ctx,
            );

            expect(fetch).not.toHaveBeenCalled();
            expect(ctx.kv.get).not.toHaveBeenCalled();
        },
    );
    
    it.each([
        ["usd", 2500],
        ["cad", 3500],
        ["eur", 4500],
        ["gbp", 5500],
    ])(
        "creates a Stripe Price using %s",
        async (currency, unitAmount) => {
            const fetch = vi.fn().mockResolvedValue(
                new Response(
                    JSON.stringify({ id: `price_test_${currency}` }),
                    { status: 200 },
                ),
            );

            const ctx = {
                http: { fetch },
            } as unknown as PluginContext;

            const priceId = await createStripePrice(ctx, {
                contentId: `product_${currency}`,
                stripeProductId: "prod_test",
                currency,
                unitAmount,
                stripeSecretKey: "sk_test_example",
                operationId: `currency-test-${currency}`,
            });

            expect(priceId).toBe(`price_test_${currency}`);

            expect(fetch).toHaveBeenCalledTimes(1);

            const [url, options] = fetch.mock.calls[0];

            expect(url).toBe("https://api.stripe.com/v1/prices");

            const body = new URLSearchParams(options.body);

            expect(body.get("product")).toBe("prod_test");
            expect(body.get("currency")).toBe(currency);
            expect(body.get("unit_amount")).toBe(
                String(unitAmount),
            );
        },
    );

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
        const consoleErrorSpy = vi
            .spyOn(console, "error")
            .mockImplementation(() => {});
        
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
            expect(consoleErrorSpy).toHaveBeenCalledWith(
            expect.stringContaining(
                "Stripe Price operation requires manual reconciliation",
            ),
            expect.objectContaining({
                stateKey: "state:product:product_test",
                operationId: "original-operation-123",
                stripeProductId: "prod_test",
                status: "processing",
            }),
        );

        consoleErrorSpy.mockRestore();
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

    it.each([
        {
            scenario: "successful deactivation",
            deactivationStatus: 200,
            expectedPendingDeactivations: [],
            latestPrice: 30,
            latestCurrency: "USD",
        },
        {
            scenario: "failed deactivation",
            deactivationStatus: 500,
            expectedPendingDeactivations: ["price_outdated_25"],
            latestPrice: 30,
            latestCurrency: "USD",
        },
        {
            scenario: "USD to CAD currency change",
            deactivationStatus: 200,
            expectedPendingDeactivations: [],
            latestPrice: 25,
            latestCurrency: "CAD",
        },
    ])(
        "handles an outdated price with $scenario during Stripe creation",
        async ({
            deactivationStatus,
            expectedPendingDeactivations,
            latestPrice,
            latestCurrency,
        }) => {
            let publishedPrice = 25;
            let publishedCurrency = "USD";
            let releasePriceRequest!: (response: Response) => void;
            let signalPriceRequest!: () => void;

            const priceRequestStarted = new Promise<void>((resolve) => {
                signalPriceRequest = resolve;
            });

            const delayedPriceResponse = new Promise<Response>((resolve) => {
                releasePriceRequest = resolve;
            });

            type TestState = {
                stripeProductId: string;
                stripePriceId: string;
                price: number;
                currency: string;
                pendingPriceDeactivations?: string[];
                pendingPriceOperation?: {
                    operationId: string;
                    attemptId?: string;
                    stripeProductId: string;
                    currency: string;
                    unitAmount: number;
                    status?: "processing" | "retryable";
                    createdAt?: number;
                    processingStartedAt?: number;
                };
            };

            let storedState: TestState = {
                stripeProductId: "prod_test",
                stripePriceId: "price_old",
                price: 20,
                currency: "usd",
            };

            let revision = 1;

            const fetch = vi.fn(async (url: string) => {
                if (
                    url ===
                    "https://api.stripe.com/v1/products/prod_test"
                ) {
                    return new Response(
                        JSON.stringify({ id: "prod_test" }),
                        { status: 200 },
                    );
                }

                if (url === "https://api.stripe.com/v1/prices") {
                    const priceRequestCount = fetch.mock.calls.filter(
                        ([requestUrl]) =>
                            requestUrl ===
                            "https://api.stripe.com/v1/prices",
                    ).length;

                    if (priceRequestCount === 1) {
                        signalPriceRequest();
                        return delayedPriceResponse;
                    }

                    return new Response(
                        JSON.stringify({ id: "price_current_30" }),
                        { status: 200 },
                    );
                }

                if (
                    url ===
                    "https://api.stripe.com/v1/prices/price_outdated_25"
                ) {
                    return new Response(
                        JSON.stringify({
                            id: "price_outdated_25",
                            active: deactivationStatus !== 200,
                        }),
                        { status: deactivationStatus },
                    );
                }

                if (
                    url ===
                    "https://api.stripe.com/v1/prices/price_old"
                ) {
                    return new Response(
                        JSON.stringify({
                            id: "price_old",
                            active: false,
                        }),
                        { status: 200 },
                    );
                }

                throw new Error(`Unexpected Stripe request: ${url}`);
            });

            const ctx = {
                settings: {
                    get: vi.fn(async (key: string) => {
                        if (key === "stripeSecretKey") {
                            return "sk_test_example";
                        }
                        return null;
                    }),
                },
                site: { url: "https://example.com" },
                content: {
                    get: vi.fn(async () => ({
                        id: "product_test",
                        status: "published",
                        data: {
                            name: "Test Product",
                            price: publishedPrice,
                            currency: publishedCurrency,
                            active: true,
                        },
                    })),
                },
                http: { fetch },
                kv: {
                    get: vi.fn(async () =>
                        structuredClone(storedState),
                    ),
                    getVersioned: vi.fn(async () => ({
                        value: structuredClone(storedState),
                        revision: String(revision),
                    })),
                    compareAndSet: vi.fn(
                        async (
                            _key: string,
                            expectedRevision: string | null,
                            value: TestState,
                        ) => {
                            if (
                                expectedRevision !==
                                String(revision)
                            ) {
                                return { applied: false };
                            }

                            storedState = structuredClone(value);
                            revision++;

                            return {
                                applied: true,
                                revision: String(revision),
                            };
                        },
                    ),
                },
            } as unknown as PluginContext;

            const synchronization = syncProductAfterPublish(
                {
                    collection: "products",
                    content: {
                        id: "product_test",
                        data: {
                            name: "Test Product",
                            price: 25,
                            currency: "USD",
                            active: true,
                        },
                    },
                } as Parameters<typeof syncProductAfterPublish>[0],
                ctx,
            );

            await priceRequestStarted;

            // The published price or currency changes while Stripe
            // is processing the original $25 USD Price.
            publishedPrice = latestPrice;
            publishedCurrency = latestCurrency;

            releasePriceRequest(
                new Response(
                    JSON.stringify({
                        id: "price_outdated_25",
                    }),
                    { status: 200 },
                ),
            );

            await synchronization;

            // The outdated $25 Price must not replace the existing Price.
            expect(storedState.stripePriceId).not.toBe(
                "price_outdated_25",
            );

            // The latest published price and currency must synchronize.
            expect(storedState.price).toBe(latestPrice);
            expect(storedState.currency).toBe(
                latestCurrency.toLowerCase(),
            );
            expect(storedState.stripePriceId).toBe(
                "price_current_30",
            );

            // The Price creation operation must be completed.
            expect(storedState.pendingPriceOperation).toBeUndefined();

            // Failed deactivations remain recorded for recovery.
            // Successful deactivations are removed from the list.
            expect(
                storedState.pendingPriceDeactivations ?? [],
            ).toEqual(expectedPendingDeactivations);

            // Verify that both cleanup requests were attempted.
            expect(fetch).toHaveBeenCalledWith(
                "https://api.stripe.com/v1/prices/price_outdated_25",
                expect.objectContaining({
                    method: "POST",
                    body: "active=false",
                }),
            );

            expect(fetch).toHaveBeenCalledWith(
                "https://api.stripe.com/v1/prices/price_old",
                expect.objectContaining({
                    method: "POST",
                    body: "active=false",
                }),
            );
        },
    );

    it("successfully deactivates a Stripe Price", async () => {
        const fetch = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    id: "price_test",
                    active: false,
                }),
                { status: 200 },
            ),
        );

        const ctx = {
            http: { fetch },
        } as unknown as PluginContext;

        await deactivateStripePrice(
            ctx,
            "price_test",
            "sk_test_example",
        );

        expect(fetch).toHaveBeenCalledTimes(1);

        const [url, options] = fetch.mock.calls[0];

        expect(url).toBe(
            "https://api.stripe.com/v1/prices/price_test",
        );
        expect(options.method).toBe("POST");
        expect(options.body).toBe("active=false");
    });

    it("reports failure when Stripe rejects Price deactivation", async () => {
        const fetch = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    error: {
                        message: "Stripe API error",
                    },
                }),
                { status: 500 },
            ),
        );

        const ctx = {
            http: { fetch },
        } as unknown as PluginContext;

        const result = await deactivateStripePrice(
            ctx,
            "price_test",
            "sk_test_example",
        );

        expect(result).toBe(false);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("reports failure when Stripe Price deactivation encounters a network error", async () => {
        const fetch = vi.fn().mockRejectedValue(
            new Error("Network connection failed"),
        );

        const ctx = {
            http: { fetch },
        } as unknown as PluginContext;

        const result = await deactivateStripePrice(
            ctx,
            "price_test",
            "sk_test_example",
        );

        expect(result).toBe(false);
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("recovers a pending Stripe Price deactivation and clears its record", async () => {
        type TestState = {
            stripePriceId: string;
            pendingPriceDeactivations: string[];
        };

        let storedState: TestState = {
            stripePriceId: "price_current_30",
            pendingPriceDeactivations: ["price_old_25"],
        };

        let revision = 1;

        const fetch = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    id: "price_old_25",
                    active: false,
                }),
                { status: 200 },
            ),
        );

        const ctx = {
            http: { fetch },
            kv: {
                getVersioned: vi.fn(async () => ({
                    value: structuredClone(storedState),
                    revision: String(revision),
                })),
                compareAndSet: vi.fn(
                    async (
                        _key: string,
                        expectedRevision: string | null,
                        value: TestState,
                    ) => {
                        if (expectedRevision !== String(revision)) {
                            return { applied: false };
                        }

                        storedState = structuredClone(value);
                        revision++;

                        return {
                            applied: true,
                            revision: String(revision),
                        };
                    },
                ),
            },
        } as unknown as PluginContext;

        await recoverPendingPriceDeactivations(
            ctx,
            "state:product:product_test",
            "sk_test_example",
            deactivateStripePrice,
        );

        expect(fetch).toHaveBeenCalledWith(
            "https://api.stripe.com/v1/prices/price_old_25",
            expect.objectContaining({
                method: "POST",
                body: "active=false",
            }),
        );

        expect(storedState.stripePriceId).toBe("price_current_30");
        expect(storedState.pendingPriceDeactivations).toEqual([]);
    });

    it("preserves a pending Stripe Price deactivation when recovery fails", async () => {
        type TestState = {
            stripePriceId: string;
            pendingPriceDeactivations: string[];
            pendingDeactivationClaims?: Record<
                string,
                {
                    attemptId: string;
                    claimedAt: number;
                }
            >;
        };

        let storedState: TestState = {
            stripePriceId: "price_current_30",
            pendingPriceDeactivations: ["price_old_25"],
        };

        let revision = 1;

        const fetch = vi.fn().mockResolvedValue(
            new Response(
                JSON.stringify({
                    error: {
                        message: "Stripe API error",
                    },
                }),
                { status: 500 },
            ),
        );

        const compareAndSet = vi.fn(
            async (
                _key: string,
                expectedRevision: string,
                nextState: TestState,
            ) => {
                if (expectedRevision !== String(revision)) {
                    return { applied: false };
                }

                storedState = structuredClone(nextState);
                revision++;

                return { applied: true };
            },
        );

        const ctx = {
            http: { fetch },
            kv: {
                getVersioned: vi.fn(async () => ({
                    value: structuredClone(storedState),
                    revision: String(revision),
                })),
                compareAndSet,
            },
        } as unknown as PluginContext;

        await recoverPendingPriceDeactivations(
            ctx,
            "state:product:product_test",
            "sk_test_example",
            deactivateStripePrice,
        );

        expect(fetch).toHaveBeenCalledWith(
            "https://api.stripe.com/v1/prices/price_old_25",
            expect.objectContaining({
                method: "POST",
                body: "active=false",
            }),
        );

        // Failed deactivations must remain available for retry.
        expect(storedState.pendingPriceDeactivations).toEqual([
            "price_old_25",
        ]);

        // Recovery must not modify the current Stripe Price.
        expect(storedState.stripePriceId).toBe("price_current_30");

        // The ownership claim must be released after failure.
        expect(storedState.pendingDeactivationClaims?.["price_old_25"]).toBeUndefined();

        // One atomic update claims ownership; another releases it.
        expect(compareAndSet).toHaveBeenCalledTimes(2);
    });

    it("never deactivates the currently active Stripe Price during recovery", async () => {
        const storedState = {
            stripePriceId: "price_current_30",
            pendingPriceDeactivations: ["price_current_30"],
        };

        const fetch = vi.fn();
        const compareAndSet = vi.fn();

        const ctx = {
            http: { fetch },
            kv: {
                getVersioned: vi.fn(async () => ({
                    value: structuredClone(storedState),
                    revision: "1",
                })),
                compareAndSet,
            },
        } as unknown as PluginContext;

        await recoverPendingPriceDeactivations(
            ctx,
            "state:product:product_test",
            "sk_test_example",
            deactivateStripePrice,
        );

        // The current Stripe Price must never be deactivated.
        expect(fetch).not.toHaveBeenCalled();

        // Its pending record must not be cleared automatically.
        expect(storedState.pendingPriceDeactivations).toEqual([
            "price_current_30",
        ]);

        // Recovery must not modify the product state.
        expect(compareAndSet).not.toHaveBeenCalled();
    });

    it("prevents concurrent recovery attempts from deactivating the same Stripe Price twice", async () => {
        type TestState = {
            stripePriceId: string;
            pendingPriceDeactivations: string[];
        };

        let storedState: TestState = {
            stripePriceId: "price_current_30",
            pendingPriceDeactivations: ["price_old_25"],
        };

        let revision = 1;
        let releaseDeactivation!: () => void;
        let signalDeactivationStarted!: () => void;

        const deactivationStarted = new Promise<void>((resolve) => {
            signalDeactivationStarted = resolve;
        });

        const deactivationBlocked = new Promise<void>((resolve) => {
            releaseDeactivation = resolve;
        });

        const fetch = vi.fn(async () => {
            signalDeactivationStarted();
            await deactivationBlocked;

            return new Response(
                JSON.stringify({
                    id: "price_old_25",
                    active: false,
                }),
                { status: 200 },
            );
        });

        const ctx = {
            http: { fetch },
            kv: {
                getVersioned: vi.fn(async () => ({
                    value: structuredClone(storedState),
                    revision: String(revision),
                })),
                compareAndSet: vi.fn(
                    async (
                        _key: string,
                        expectedRevision: string | null,
                        value: TestState,
                    ) => {
                        if (expectedRevision !== String(revision)) {
                            return { applied: false };
                        }

                        storedState = structuredClone(value);
                        revision++;

                        return {
                            applied: true,
                            revision: String(revision),
                        };
                    },
                ),
            },
        } as unknown as PluginContext;

        const firstRecovery = recoverPendingPriceDeactivations(
            ctx,
            "state:product:product_test",
            "sk_test_example",
            deactivateStripePrice,
        );

        await deactivationStarted;

        const secondRecovery = recoverPendingPriceDeactivations(
            ctx,
            "state:product:product_test",
            "sk_test_example",
            deactivateStripePrice,
        );

        releaseDeactivation();

        await Promise.all([firstRecovery, secondRecovery]);

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(storedState.stripePriceId).toBe("price_current_30");
        expect(storedState.pendingPriceDeactivations).toEqual([]);
    });

    it("reclaims an expired deactivation claim without allowing the previous owner to release it", async () => {
        type TestState = {
            stripePriceId: string;
            pendingPriceDeactivations: string[];
            pendingDeactivationClaims?: Record<
                string,
                {
                    attemptId: string;
                    claimedAt: number;
                }
            >;
        };

        const stateKey = "state:product:product_test";
        const stripePriceId = "price_old_25";

        let storedState: TestState = {
            stripePriceId: "price_current_30",
            pendingPriceDeactivations: [stripePriceId],
            pendingDeactivationClaims: {
                [stripePriceId]: {
                    attemptId: "original-attempt",
                    claimedAt: Date.now() - 6 * 60 * 1000,
                },
            },
        };

        let revision = 1;

        const ctx = {
            kv: {
                getVersioned: vi.fn(async () => ({
                    value: structuredClone(storedState),
                    revision: String(revision),
                })),
                compareAndSet: vi.fn(
                    async (
                        _key: string,
                        expectedRevision: string | null,
                        nextState: TestState,
                    ) => {
                        if (expectedRevision !== String(revision)) {
                            return { applied: false };
                        }

                        storedState = structuredClone(nextState);
                        revision++;

                        return {
                            applied: true,
                            revision: String(revision),
                        };
                    },
                ),
            },
        } as unknown as PluginContext;

        const newAttemptId = await claimPendingPriceDeactivation(
            ctx,
            stateKey,
            stripePriceId,
        );

        expect(newAttemptId).toBeTruthy();
        expect(newAttemptId).not.toBe("original-attempt");

        expect(
            storedState.pendingDeactivationClaims?.[stripePriceId]
                ?.attemptId,
        ).toBe(newAttemptId);

        // The previous owner must not release the newer claim.
        const oldOwnerReleased =
            await releasePendingPriceDeactivationClaim(
                ctx,
                stateKey,
                stripePriceId,
                "original-attempt",
            );

        expect(oldOwnerReleased).toBe(false);

        expect(
            storedState.pendingDeactivationClaims?.[stripePriceId]
                ?.attemptId,
        ).toBe(newAttemptId);

        // The current owner can release its own claim.
        const newOwnerReleased =
            await releasePendingPriceDeactivationClaim(
                ctx,
                stateKey,
                stripePriceId,
                newAttemptId!,
            );

        expect(newOwnerReleased).toBe(true);

        expect(
            storedState.pendingDeactivationClaims?.[stripePriceId],
        ).toBeUndefined();

        // Releasing ownership must not remove the pending Price.
        expect(storedState.pendingPriceDeactivations).toEqual([
            stripePriceId,
        ]);

        expect(storedState.stripePriceId).toBe("price_current_30");
    });
});
