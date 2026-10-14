const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
    return Array.from(new Uint8Array(bytes))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
}

export async function verifyStripeWebhookSignature(
    payload: Uint8Array,
    signatureHeader: string,
    webhookSecret: string
): Promise<boolean> {
    const parts = signatureHeader.split(",");
    const timestamp = parts.find((part) => part.startsWith("t="))?.slice(2);
    const signatures = parts
        .filter((part) => part.startsWith("v1="))
        .map((part) => part.slice(3));

    if (!timestamp || signatures.length === 0) {
        return false;
    }

    const timestampNumber = Number(timestamp);

    if (
        !Number.isSafeInteger(timestampNumber) ||
        Math.abs(Date.now() / 1000 - timestampNumber) > 300
    ) {
        return false;
    }

    const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(webhookSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );

    const signedPayload = new Uint8Array(
        encoder.encode(`${timestamp}.`).length + payload.length
    );

    const prefix = encoder.encode(`${timestamp}.`);
    signedPayload.set(prefix);
    signedPayload.set(payload, prefix.length);

    const digest = await crypto.subtle.sign("HMAC", key, signedPayload);
    const expectedSignature = toHex(digest);

    // Compare every candidate signature without early exit.
    let matched = 0;

    for (const signature of signatures) {
        if (!/^[0-9a-f]{64}$/i.test(signature)) {
            continue;
        }

        let difference = 0;

        for (let i = 0; i < expectedSignature.length; i++) {
            difference |= expectedSignature.charCodeAt(i) ^
                signature.toLowerCase().charCodeAt(i);
        }

        matched |= Number(difference === 0);
    }

    return matched !== 0;
}