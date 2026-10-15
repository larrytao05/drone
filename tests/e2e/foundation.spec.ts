import { expect, test } from "@playwright/test";

const browserErrors: Error[] = [];

test.beforeEach(async ({ page }) => {
  browserErrors.length = 0;
  page.on("pageerror", (error) => browserErrors.push(error));
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Run fixed route" })).toBeEnabled();
  await page.context().setOffline(true);
});

test.afterEach(() => {
  expect(browserErrors).toEqual([]);
});

async function expectWaypoint(row: import("@playwright/test").Locator, values: readonly number[]) {
  const cells = await row.locator("td").allTextContents();
  expect(cells).toHaveLength(5);
  for (const [index, expected] of values.entries()) {
    expect(Number(cells[index])).toBeCloseTo(expected, 6);
  }
}

test("the fixed route returns the known ordered waypoints while offline", async ({ page }) => {
  await page.getByRole("button", { name: "Run fixed route" }).click();

  const rows = page.getByRole("table", { name: "Calculated waypoints" }).locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expectWaypoint(rows.nth(0), [0, 0, 12, 90, -30]);
  await expectWaypoint(rows.nth(1), [0, 0.001, 12, 90, -30]);
  await expect(page.getByRole("status")).toHaveText("Calculated 2 waypoints.");
});

test("face-target framing follows a meridian toward the target while offline", async ({ page }) => {
  await page.getByRole("button", { name: "Run face-target route" }).click();

  const rows = page.getByRole("table", { name: "Calculated waypoints" }).locator("tbody tr");
  await expect(rows).toHaveCount(2);
  await expectWaypoint(rows.nth(0), [0, 0, 5, 0, 1.2951931927091458]);
  await expectWaypoint(rows.nth(1), [0.003, 0, 5, 180, 2.5890640401952405]);
});

test("invalid routes show errors and each new result clears the previous result", async ({ page }) => {
  await page.getByRole("button", { name: "Run fixed route" }).click();
  await expect(page.getByRole("table", { name: "Calculated waypoints" })).toBeVisible();

  await page.getByRole("button", { name: "Run invalid route" }).click();
  const errors = page.getByRole("list", { name: "Planning errors" });
  await expect(errors).toContainText("malformed");
  await expect(errors).toContainText("shot.anchors");
  await expect(errors).toContainText("A route requires at least two anchors.");
  await expect(page.getByRole("status")).toHaveText("The route has input errors.");
  await expect(page.getByRole("table", { name: "Calculated waypoints" })).toHaveCount(0);

  await page.getByRole("button", { name: "Run face-target route" }).click();
  await expect(page.getByRole("table", { name: "Calculated waypoints" })).toBeVisible();
  await expect(errors).toHaveCount(0);
  await expectWaypoint(page.getByRole("table", { name: "Calculated waypoints" }).locator("tbody tr").nth(1), [0.003, 0, 5, 180, 2.5890640401952405]);
});

test("the page remains usable at a narrow viewport in light and dark color schemes", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.emulateMedia({ colorScheme: "light" });
  const lightBackground = await page.locator("body").evaluate((body) => getComputedStyle(body).backgroundColor);
  await page.emulateMedia({ colorScheme: "dark" });
  const darkBackground = await page.locator("body").evaluate((body) => getComputedStyle(body).backgroundColor);

  expect(lightBackground).not.toEqual(darkBackground);
  await page.getByRole("button", { name: "Run face-target route" }).press("Enter");
  await expect(page.getByRole("table", { name: "Calculated waypoints" })).toBeVisible();
  expect(await page.locator("body").evaluate((body) => body.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("narrow-dark.png") });
  await page.emulateMedia({ colorScheme: "light" });
  await page.screenshot({ path: testInfo.outputPath("narrow-light.png") });
  await page.setViewportSize({ width: 1024, height: 740 });
  expect(await page.locator("body").evaluate((body) => body.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("desktop-light.png") });
});
