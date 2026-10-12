(async () => {
  // Temporary collection for testing.
  const collectionSlug = "ecommerceaveproducts";
  const baseUrl = "/_emdash/api/schema/collections";

  const headers = {
    "Content-Type": "application/json",
    "X-EmDash-Request": "1"
  };

  const fields = [
    {
      slug: "name",
      label: "Name",
      type: "string",
      required: true,
      sortOrder: 0
    },
    {
      slug: "description",
      label: "Description",
      type: "text",
      required: false,
      sortOrder: 1
    },
    {
      slug: "image",
      label: "Image",
      type: "image",
      required: false,
      sortOrder: 2
    },
    {
      slug: "price",
      label: "Price",
      type: "number",
      required: true,
      sortOrder: 3
    },
    {
      slug: "currency",
      label: "Currency",
      type: "select",
      required: true,
      defaultValue: "USD",
      validation: {
        options: ["USD", "CAD", "EUR", "GBP"]
      },
      sortOrder: 4
    },
    {
      slug: "sku",
      label: "SKU",
      type: "string",
      required: false,
      sortOrder: 5
    },
    {
      slug: "active",
      label: "Active",
      type: "boolean",
      required: false,
      sortOrder: 6
    }
  ];

  try {
    // Check whether the collection exists.
    const collectionResponse = await fetch(
      `${baseUrl}/${collectionSlug}`,
      { credentials: "same-origin" }
    );

    if (collectionResponse.status === 404) {
      console.log(`Creating collection: ${collectionSlug}`);

      const createResponse = await fetch(baseUrl, {
        method: "POST",
        credentials: "same-origin",
        headers,
        body: JSON.stringify({
          slug: collectionSlug,
          label: "eCommerce Ave Products Test",
          labelSingular: "Product"
        })
      });

      if (!createResponse.ok) {
        console.error(
          "Collection creation failed:",
          await createResponse.json()
        );
        return;
      }

      console.log(`✓ Created collection: ${collectionSlug}`);

    } else if (!collectionResponse.ok) {
      throw new Error(
        `Collection check failed: HTTP ${collectionResponse.status}`
      );

    } else {
      console.log(`✓ Collection already exists: ${collectionSlug}`);
    }

    let errors = 0;

    // Check or create each field.
    for (const field of fields) {
      const fieldUrl =
        `${baseUrl}/${collectionSlug}/fields/${field.slug}`;

      const existing = await fetch(fieldUrl, {
        credentials: "same-origin"
      });

      if (existing.ok) {
        const result = await existing.json();
        const actual = result.data.item;

        const wrongType = actual.type !== field.type;
        const wrongRequired = actual.required !== field.required;

        const wrongCurrency =
          field.slug === "currency" &&
          (
            actual.defaultValue !== "USD" ||
            JSON.stringify(actual.validation?.options) !==
              JSON.stringify(["USD", "CAD", "EUR", "GBP"])
          );

        if (wrongType || wrongRequired || wrongCurrency) {
          console.error(
            `✗ ${field.slug}: Configuration doesn't match`,
            {
              expected: field,
              actual
            }
          );

          errors++;
        } else {
          console.log(`✓ ${field.slug} already exists and is valid`);
        }

        continue;
      }

      if (existing.status !== 404) {
        throw new Error(
          `Unable to check ${field.slug}: HTTP ${existing.status}`
        );
      }

      // Create missing field.
      const response = await fetch(
        `${baseUrl}/${collectionSlug}/fields`,
        {
          method: "POST",
          credentials: "same-origin",
          headers,
          body: JSON.stringify(field)
        }
      );

      if (!response.ok) {
        console.error(
          `✗ Failed to create ${field.slug}:`,
          await response.json()
        );

        errors++;
        break;
      }

      console.log(`✓ Created ${field.slug}`);
    }

    if (errors === 0) {
      console.log("✓ Products collection setup completed successfully!");
    } else {
      console.error(
        `Products setup finished with ${errors} configuration error(s).`
      );
    }

  } catch (error) {
    console.error("Products setup failed:", error);
  }
})();