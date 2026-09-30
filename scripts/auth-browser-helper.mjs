export async function enterGuest(page, origin) {
  await page.goto(origin); await page.locator('#guest-enter').click(); await page.waitForURL(origin + '/chat/');
}
export async function enterAccount(page, origin, password) {
  await page.goto(origin); await page.locator('#account-username').fill('host'); await page.locator('#account-password').fill(password);
  await page.locator('#account-submit').click(); await page.waitForURL(origin + '/chat/');
}
export async function signOut(page, origin) {
  await page.locator('#admin-dialog .close-dialog').click(); await page.locator('#open-settings').click(); await page.locator('#account-signout').click(); await page.waitForURL(origin + '/#entry');
}
