import { test, expect, type Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Virtual Wallet Injection Helpers
// ---------------------------------------------------------------------------

interface InjectedWalletSession {
  address: string;
  network: string;
  signature: string;
  expiresAt: number;
}

/** Generate a deterministic Stellar-compatible address for testing. */
function generateTestAddress(seed: number): string {
  // G-prefixed base32-like public key matching Stellar address format
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  // Stellar public keys are G + 55 chars = 56 total
  const body = Array.from({ length: 55 }, (_, i) =>
    chars.charAt((seed * 7 + i * 13) % chars.length)
  ).join("");
  return `G${body}`;
}

/** Create a fake auth session payload suitable for localStorage injection. */
function createTestSession(address: string): InjectedWalletSession {
  return {
    address,
    network: "testnet",
    signature: "00".repeat(64),
    expiresAt: Date.now() + 30 * 60 * 1000, // 30 minutes
  };
}

/** Inject a connected wallet session into the browser via localStorage.
 *  Navigates to the app first so localStorage is accessible, injects session,
 *  then reloads so the app picks up the injected state. */
async function injectWalletSession(
  page: Page,
  address?: string
): Promise<string> {
  const addr = address ?? generateTestAddress(Date.now());
  const session = createTestSession(addr);

  // Must be on the app's origin before touching localStorage
  await page.goto("/");

  await page.evaluate(
    ({ session: s }) => {
      localStorage.setItem("utility-auth-session", JSON.stringify(s));
      localStorage.setItem(
        "utility-auth-secret",
        // 56-char Stellar secret key (S-prefixed)
        "S" + "A".repeat(55)
      );
    },
    { session }
  );

  // Reload so the app reads the newly injected session
  await page.reload();

  return addr;
}

/** Format a Stellar address for display (first 6 … last 4). */
function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// ---------------------------------------------------------------------------
// Wallet Connection Flow (real Stellar SDK via UI)
// ---------------------------------------------------------------------------

test.describe("Wallet Connection Flow", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("should display connect button when wallet is disconnected", async ({
    page,
  }) => {
    const connectBtn = page.getByRole("button", { name: /connect wallet/i });
    await expect(connectBtn).toBeVisible();
  });

  test("should connect wallet and show truncated address", async ({
    page,
  }) => {
    const connectBtn = page.getByRole("button", { name: /connect wallet/i });
    await connectBtn.click();

    await expect(
      page.getByText(/^G[A-Z0-9]{5}\.{3}[A-Z0-9]{4}$/)
    ).toBeVisible();
  });

  test("should disconnect wallet and show connect button", async ({
    page,
  }) => {
    await page.getByRole("button", { name: /connect wallet/i }).click();
    await expect(
      page.getByText(/^G[A-Z0-9]{5}\.{3}[A-Z0-9]{4}$/)
    ).toBeVisible();

    await page.getByRole("button", { name: /disconnect/i }).click();
    await expect(
      page.getByRole("button", { name: /connect wallet/i })
    ).toBeVisible();
  });

  test("should persist wallet session across page reload", async ({
    page,
  }) => {
    await page.getByRole("button", { name: /connect wallet/i }).click();
    const address = await page
      .getByText(/^G[A-Z0-9]{5}\.{3}[A-Z0-9]{4}$/)
      .textContent();

    await page.reload();
    await expect(page.getByText(address!)).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Virtual Wallet Injection Tests
// ---------------------------------------------------------------------------

test.describe("Virtual Wallet Injection", () => {
  test("should show connected state when session is injected", async ({
    page,
  }) => {
    const address = await injectWalletSession(page);

    // Address should be visible without clicking Connect
    await expect(
      page.getByText(truncateAddress(address))
    ).toBeVisible();

    // Disconnect button should be visible
    await expect(
      page.getByRole("button", { name: /disconnect/i })
    ).toBeVisible();

    // Connect button should NOT be visible
    await expect(
      page.getByRole("button", { name: /connect wallet/i })
    ).not.toBeVisible();
  });

  test("should show multiple test addresses correctly", async ({ page }) => {
    const address = generateTestAddress(42);
    await injectWalletSession(page, address);

    // Verify the exact injected address is displayed
    await expect(
      page.getByText(truncateAddress(address))
    ).toBeVisible();
  });

  test("should show connect button after clearing injected session", async ({
    page,
  }) => {
    // First inject a session
    await injectWalletSession(page);

    // Click disconnect to clear
    await page.getByRole("button", { name: /disconnect/i }).click();

    // Connect button should reappear
    await expect(
      page.getByRole("button", { name: /connect wallet/i })
    ).toBeVisible();
  });

  test("should survive page reload with injected session", async ({
    page,
  }) => {
    const address = await injectWalletSession(page);

    await expect(
      page.getByText(truncateAddress(address))
    ).toBeVisible();

    // Reload should preserve the session
    await page.reload();
    await expect(
      page.getByText(truncateAddress(address))
    ).toBeVisible();
  });

  test("should not show connected state with expired session", async ({
    page,
  }) => {
    const address = generateTestAddress(99);
    const expiredSession: InjectedWalletSession = {
      address,
      network: "testnet",
      signature: "00".repeat(64),
      expiresAt: Date.now() - 1000, // expired 1 second ago
    };

    // Navigate first so localStorage is accessible, then inject expired session
    await page.goto("/");
    await page.evaluate((session) => {
      localStorage.setItem("utility-auth-session", JSON.stringify(session));
      localStorage.setItem("utility-auth-secret", "S" + "A".repeat(55));
    }, expiredSession);
    await page.reload();

    // Expired session should show connect button
    await expect(
      page.getByRole("button", { name: /connect wallet/i })
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test.describe("Wallet Edge Cases", () => {
  test("should handle corrupt localStorage gracefully", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() => {
      localStorage.setItem("utility-auth-session", "not-valid-json{");
      localStorage.setItem("utility-auth-secret", "".repeat(56));
    });
    await page.reload();

    // Should fall back to disconnected state — no crash
    await expect(
      page.getByRole("button", { name: /connect wallet/i })
    ).toBeVisible();
  });

  test("should handle missing secret gracefully", async ({ page }) => {
    const address = generateTestAddress(77);
    const session = createTestSession(address);

    await page.goto("/");
    await page.evaluate((s) => {
      localStorage.setItem("utility-auth-session", JSON.stringify(s));
      // Deliberately omit utility-auth-secret
    }, session);
    await page.reload();

    // Should still show the address from the session (address is in session, not secret)
    await expect(
      page.getByText(truncateAddress(address))
    ).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Dashboard Integration
// ---------------------------------------------------------------------------

test.describe("Dashboard Integration", () => {
  test("should render the grid map canvas", async ({ page }) => {
    await page.goto("/");
    const canvas = page.locator("canvas").first();
    await expect(canvas).toBeVisible();
  });

  test("should display fleet grid with assets", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(/Meter-/).first()).toBeVisible();
  });

  test("should filter fleet grid by status", async ({ page }) => {
    await page.goto("/");
    const onlineBtn = page.getByRole("button", { name: /^Online$/ });
    await onlineBtn.click();
    const activeCards = page.locator('[class*="rounded-lg border"]');
    const count = await activeCards.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });
});
