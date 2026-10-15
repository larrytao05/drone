import { expect, test } from "@playwright/test";

const browserErrors: Error[] = [];

test.beforeEach(async ({ page }) => {
  browserErrors.length = 0;
  page.on("pageerror", (error) => browserErrors.push(error));
  await page.goto("/");
  await expect(page.getByRole("textbox", { name: "Route name" })).toHaveValue("");
});

test.afterEach(() => {
  expect(browserErrors).toEqual([]);
});

test("the editor opens with persistent route settings, waypoints and map tools", async ({ page }) => {
  await expect(page.getByRole("region", { name: "Route settings" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Waypoints" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Selected waypoint" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Mission map" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Route preview" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Map tools" }).getByRole("button")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
});

test("New clears editable source and resets the active map tool", async ({ page }) => {
  await page.getByRole("textbox", { name: "Route name" }).fill("Harbor survey");
  await page.getByRole("textbox", { name: "Height above takeoff" }).fill("32");
  await page.getByRole("button", { name: "Add points" }).click();
  await page.getByRole("button", { name: "New" }).click();

  await expect(page.getByRole("textbox", { name: "Route name" })).toHaveValue("");
  await expect(page.getByRole("textbox", { name: "Height above takeoff" })).toHaveValue("");
  await expect(page.getByRole("button", { name: "Select" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("status", { name: "Review status" })).toContainText("Not reviewed");
  await expect(page.getByRole("status", { name: "Save status" })).toContainText("Unsaved");
});

test("the editor fits 320 and 1024 pixels and responds to system color scheme", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.emulateMedia({ colorScheme: "light" });
  const lightBackground = await page.locator("main").evaluate((main) => getComputedStyle(main).backgroundColor);
  await page.emulateMedia({ colorScheme: "dark" });
  const darkBackground = await page.locator("main").evaluate((main) => getComputedStyle(main).backgroundColor);

  expect(lightBackground).not.toEqual(darkBackground);
  await page.getByRole("textbox", { name: "Route name" }).focus();
  await page.keyboard.type("Keyboard route");
  await expect(page.getByRole("textbox", { name: "Route name" })).toHaveValue("Keyboard route");
  expect(await page.locator("body").evaluate((body) => body.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("narrow-dark.png") });
  await page.emulateMedia({ colorScheme: "light" });
  await page.screenshot({ path: testInfo.outputPath("narrow-light.png") });
  await page.setViewportSize({ width: 1024, height: 740 });
  expect(await page.locator("body").evaluate((body) => body.scrollWidth <= window.innerWidth)).toBe(true);
  const map = await page.getByRole("region", { name: "Mission map" }).boundingBox();
  const inspector = await page.getByRole("region", { name: "Route settings" }).boundingBox();
  expect(map).not.toBeNull();
  expect(inspector).not.toBeNull();
  expect(map?.width).toBeGreaterThan(inspector?.width ?? 0);
  await page.screenshot({ path: testInfo.outputPath("desktop-light.png") });
  await page.emulateMedia({ colorScheme: "dark" });
  const desktopDarkBackground = await page.locator("main").evaluate((main) => getComputedStyle(main).backgroundColor);
  expect(desktopDarkBackground).toBe(darkBackground);
  await page.screenshot({ path: testInfo.outputPath("desktop-dark.png") });
});
